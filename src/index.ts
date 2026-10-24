/**
 * Proactive image budget guard.
 *
 * The session log is append-only, and every agent step sends the whole derived
 * history to the model. On an inline (`base64`) route a long session therefore
 * re-uploads every historical screenshot on every step: visual tokens stay far
 * below the compaction threshold while the request body grows by megabytes, so
 * the only existing backstop is `compaction-image-offload`, which fires *after*
 * the adapter already refused the request (`IMAGE_OFFLOAD_REQUIRED`) and only
 * names the oldest occurrences. That path costs the user a slow request, a
 * transport failure, and a retry on every new image that crosses the waterline.
 *
 * This plugin moves the same durable decision in front of the request. It hooks
 * `agent/request`, resolves the exact `(provider, model)` the loop is about to
 * use, and — when the image-capable route has a budget policy — records one
 * `image/offload` event for the oldest occurrences before `buildRequest()`
 * derives the surface. The request then never reaches the adapter ceiling: no
 * failure, no retry, and a bounded body.
 *
 * Why `agent/request` and not `agent/pre-step`: the model-selection listener in
 * `@deepseek-ai/dsh-agent` rewrites provider/model **inside** the
 * `agent/request` waterfall, so only a listener that awaits `next()` observes
 * the route actually used; and `buildRequest()` — which calls
 * `session.deriveMessages()` — runs after that waterfall returns, so an event
 * appended here is part of the request. See the README's source table.
 *
 * @module @ksndjaks/dsh-image-budget-guard
 */
import type { Context } from '@deepseek-ai/cordis';
// Load the event-map augmentations this plugin listens to (`agent/request`,
// `agent/request-error`); a type-only import keeps the runtime graph empty.
import type {} from '@deepseek-ai/dsh-agent';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import {
  ConfigSchema,
  resolveRouteBudget,
  routeCapabilityOverride,
  routeEnabled,
  type ImageBudgetGuardConfig,
  type RouteBudgetPolicy,
  type RouteRepresentation,
} from './config.js';
import {
  base64Length,
  planImageOffload,
  type ImageOccurrence,
  type OffloadTarget,
  type SelectionResult,
} from './select.js';
import {
  appendImageOffloadDecision,
  ensureImageOffloadProjection,
  isCompactionInProgress,
  recentStepBoundary,
  surfaceImageOccurrences,
  validateOffloadTargets,
  type OffloadTargetShape,
  type ProjectionMode,
} from './projection.js';

/**
 * Zod schema the Harness loader validates before `apply()` runs.
 *
 * Cordis resolves a plugin's `Config` through the Standard Schema
 * `~standard.validate()` interface, which Zod 4 implements; `.strict()` makes
 * an unknown key a load-time `ValidationError` instead of a silent typo.
 */
export const Config = ConfigSchema;

/** Plugin name used in diagnostics. */
export const name = 'image-budget-guard';

/**
 * Services this plugin needs. `attachments` is deliberately absent: an image
 * route without an attachment store has nothing to measure, so the guard
 * degrades to a no-op instead of refusing to mount.
 */
export const inject = ['sessions', 'llm'];

/** Minimal facts this guard reads from the agent and the hook payload. */
export interface GuardRequestFacts {
  readonly agent: {
    readonly session: Session;
    readonly options: {
      readonly provider?: string;
      readonly model?: string;
      readonly maxTokens?: number;
    };
  };
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

/** What one guard pass decided. */
export interface GuardDecision {
  /** `noop` wrote nothing; `would-offload` is a dry run; `offloaded` appended one event. */
  readonly action: 'noop' | 'offloaded' | 'would-offload';
  /** Stable machine-readable cause. */
  readonly reason: string;
  readonly provider?: string;
  readonly model?: string;
  readonly policy?: RouteBudgetPolicy;
  readonly plan?: SelectionResult;
  /** Sequence of the appended `image/offload` event, when one was written. */
  readonly eventSeq?: number;
  /** Selected occurrences, always reported for dry runs and writes. */
  readonly selected?: readonly OffloadTarget[];
}

/** Structured log record; one JSON object per line keeps logs machine-readable. */
interface GuardLogRecord {
  readonly event: string;
  readonly [field: string]: unknown;
}

const LOG_LEVEL_RANK: Readonly<Record<ImageBudgetGuardConfig['logLevel'], number>> = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

/** Guard-owned leveled logger that never changes harness-wide levels. */
interface GuardLogger {
  error(record: GuardLogRecord): void;
  warn(record: GuardLogRecord): void;
  info(record: GuardLogRecord): void;
  debug(record: GuardLogRecord): void;
}

/** Maximum estimate cache entries before the cache is dropped. */
const SIZE_CACHE_LIMIT = 4096;

/** Per-process guard state. Decisions themselves live in the session log. */
export interface GuardState {
  readonly ctx: Context;
  readonly config: ImageBudgetGuardConfig;
  readonly log: GuardLogger;
  /**
   * Represented bytes per exact request version. The key is the attachment id
   * plus the adapter's target, which is the same identity the attachment store
   * uses for its on-disk `request-images` cache, so a warm guard never asks the
   * store to re-read or re-encode history (see README "cache reuse").
   */
  readonly sizeCache: Map<string, number>;
  /** Capability/route directory lookups, cleared when the adapter topology changes. */
  readonly modelInfoCache: Map<string, LlmResolvedModelInfo | null>;
  readonly representationCache: Map<string, RouteRepresentation | undefined>;
  projectionMode?: ProjectionMode;
  readonly warned: Set<string>;
}

/**
 * Create the guarded logger for one plugin instance.
 *
 * Cordis maps `error/info/warn/debug` to levels 0/1/2/3 and an exporter without
 * `levels` (the harness buffer's default) accepts only `error` and `info`:
 * `dsh` configures no logger level, so a plain `warn` record would never reach
 * the buffer. Warnings therefore travel on `info` — the one channel that is
 * captured out of the box — and carry their real severity in the JSON payload,
 * so nothing depends on an operator raising an exporter level to see a decision
 * that could not be applied. `debug` stays on the `debug` channel on purpose:
 * it is per-step noise and must stay opt-in.
 */
function createLogger(ctx: Context, level: ImageBudgetGuardConfig['logLevel']): GuardLogger {
  const threshold = LOG_LEVEL_RANK[level];
  const emit = (
    rank: number,
    method: 'error' | 'warn' | 'info' | 'debug',
    severity: 'error' | 'warn' | 'info' | 'debug',
    record: GuardLogRecord,
  ): void => {
    if (threshold < rank) return;
    ctx.logger[method](`[image-budget-guard] ${JSON.stringify({ severity, ...record })}`);
  };
  return {
    error: (record) => emit(1, 'error', 'error', record),
    warn: (record) => emit(2, 'info', 'warn', record),
    info: (record) => emit(3, 'info', 'info', record),
    debug: (record) => emit(4, 'debug', 'debug', record),
  };
}

/** Error text safe to log. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Push one value into a bounded map, dropping it wholesale at the limit. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= SIZE_CACHE_LIMIT && !cache.has(key)) cache.clear();
  cache.set(key, value);
}

/**
 * Resolve the representation a mounted adapter uses for one provider route.
 *
 * `LlmAdapter` exposes request-image geometry and pricing, but no field that
 * states whether bytes travel inline or through a Files/reference endpoint, so
 * the only adapter-owned fact available is the configurable-provider directory
 * entry's `settingsNs` (the settings namespace that configures the route — in
 * practice the row id of the adapter plugin). DeepSeek's Messages adapter
 * uploads through `/v1/files`; pi-ai inlines base64. Unknown routes keep the
 * conservative inline byte budget, and `perRoute[].representation` overrides
 * both.
 */
function representationHint(state: GuardState, provider: string): RouteRepresentation | undefined {
  if (state.representationCache.has(provider)) return state.representationCache.get(provider);
  let hint: RouteRepresentation | undefined;
  try {
    const entry = state.ctx.llm
      .listConfigurableProviders()
      .find((candidate) => candidate.provider === provider);
    const namespace = entry?.settingsNs ?? '';
    if (/^llm-deepseek(?:-|$)/.test(namespace)) hint = 'files';
    else if (/^llm-pi-ai(?:-|$)/.test(namespace)) hint = 'inline-base64';
  } catch (error) {
    state.log.debug({ event: 'representation-probe-failed', provider, error: errorText(error) });
  }
  state.representationCache.set(provider, hint);
  return hint;
}

/**
 * Resolve exact-model metadata, caching the answer per route.
 * @returns metadata, or null when the adapter cannot resolve the route.
 */
async function resolveModelInfo(
  state: GuardState,
  provider: string,
  model: string,
  signal: AbortSignal,
): Promise<LlmResolvedModelInfo | null> {
  const key = `${provider}\u0000${model}`;
  const cached = state.modelInfoCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const info = await state.ctx.llm.resolveModelInfo(provider, model, signal);
    state.modelInfoCache.set(key, info);
    return info;
  } catch (error) {
    state.modelInfoCache.set(key, null);
    state.log.warn({ event: 'model-resolution-failed', provider, model, error: errorText(error) });
    return null;
  }
}

/** Represented request bytes for one exact occurrence under one route. */
async function representedBytes(
  state: GuardState,
  attachments: AttachmentStore,
  provider: string,
  model: string,
  policy: RouteBudgetPolicy,
  attachment: ImageAttachmentRef,
  signal: AbortSignal,
): Promise<number> {
  const target = state.ctx.llm.imageRequestTarget(provider, model, attachment);
  const key = `${attachment.attachmentId}\u0000${target.width}x${target.height}\u0000${target.maxBytes}`;
  const cached = state.sizeCache.get(key);
  if (cached !== undefined) return cached;
  const version = await attachments.readImageRequest(attachment, target, signal);
  const bytes = policy.representation === 'inline-base64' ? base64Length(version.bytes) : version.bytes;
  remember(state.sizeCache, key, bytes);
  return bytes;
}

/**
 * Request facts the decision was made under.
 *
 * `provider`/`model`/`maxTokens` come from the resolved `LlmCallConfig` the loop
 * will send (after the `agent/request` waterfall, so a model switch is already
 * applied); the tool count comes from the durable tool history the same request
 * will project (`session.toolHistory()`); the surface count is the number of
 * message-producing nodes the request will derive. None of these change the
 * byte budget — they make the log line answer "which request was this?".
 */
function requestFacts(facts: GuardRequestFacts, resolved: LlmCallConfig, session: Session): Record<string, unknown> {
  let toolCount: number | null = null;
  try {
    toolCount = session.toolHistory().tools.length;
  } catch {
    toolCount = null;
  }
  return {
    turn: facts.turn,
    step: facts.step,
    maxTokens: resolved.maxTokens ?? null,
    toolCount,
    surfaceNodes: session.surface.nodes.length,
  };
}

/** Policy fields worth putting in a log line. */
function summarizePolicy(policy: RouteBudgetPolicy): Record<string, unknown> {
  return {
    representation: policy.representation,
    dimension: policy.dimension,
    maxBytes: Number.isFinite(policy.maxBytes) ? policy.maxBytes : null,
    maxImages: Number.isFinite(policy.maxImages) ? policy.maxImages : null,
    minRetainImages: policy.minRetainImages,
    retainSteps: policy.retainSteps,
    quanta: policy.quanta,
  };
}

/** Flatten a decision for logs and dry-run output. */
function describeSelection(
  occurrences: readonly ImageOccurrence[],
  targets: readonly OffloadTarget[],
): { seq: number; imageIndex: number; attachmentId: string; bytes: number }[] {
  const byPosition = new Map<string, ImageOccurrence>();
  for (const occurrence of occurrences) byPosition.set(`${occurrence.seq}\u0000${occurrence.imageIndex}`, occurrence);
  const detail: { seq: number; imageIndex: number; attachmentId: string; bytes: number }[] = [];
  for (const target of targets) {
    for (const imageIndex of target.imageIndexes) {
      const occurrence = byPosition.get(`${target.seq}\u0000${imageIndex}`);
      if (occurrence === undefined) continue;
      detail.push({
        seq: target.seq,
        imageIndex,
        attachmentId: occurrence.attachmentId,
        bytes: occurrence.bytes,
      });
    }
  }
  return detail;
}

/**
 * Run one guard pass for one request.
 *
 * Every failure path returns `action: 'noop'` after a structured log line: this
 * guard may never turn a step into a failure, and it never swallows the
 * adapter's own error (it simply does not participate in error handling).
 *
 * @param state - per-plugin state.
 * @param facts - agent, position, and cancellation from the hook payload.
 * @param resolved - the final call configuration the loop will send.
 * @returns the decision taken.
 */
export async function runGuard(
  state: GuardState,
  facts: GuardRequestFacts,
  resolved: LlmCallConfig,
): Promise<GuardDecision> {
  const { config, log } = state;
  const provider = resolved.provider;
  const model = resolved.model;
  if (!config.enabled) return { action: 'noop', reason: 'disabled' };
  if (facts.signal.aborted) return { action: 'noop', reason: 'aborted', provider, model };
  if (provider.length === 0 || model.length === 0) return { action: 'noop', reason: 'no-route', provider, model };
  if (!routeEnabled(config, provider, model)) return { action: 'noop', reason: 'route-disabled', provider, model };

  const { session } = facts.agent;
  if (isCompactionInProgress(session)) return { action: 'noop', reason: 'compaction-in-progress', provider, model };

  const occurrences = surfaceImageOccurrences(session);
  if (occurrences.length === 0) return { action: 'noop', reason: 'no-images', provider, model };

  const attachments = state.ctx.get('attachments') as AttachmentStore | undefined;
  if (attachments === undefined) {
    if (!state.warned.has('no-attachments')) {
      state.warned.add('no-attachments');
      log.warn({ event: 'no-attachments-service', provider, model });
    }
    return { action: 'noop', reason: 'no-attachments', provider, model };
  }

  const forcedCapability = routeCapabilityOverride(config, provider, model);
  if (forcedCapability === false) {
    return { action: 'noop', reason: 'route-not-image-capable', provider, model };
  }
  if (forcedCapability !== true) {
    const info = await resolveModelInfo(state, provider, model, facts.signal);
    const modalities = info?.inputModalities;
    if (modalities === undefined || !modalities.includes('image')) {
      log.debug({ event: 'route-not-image-capable', provider, model, modalities: modalities ?? null });
      return { action: 'noop', reason: 'route-not-image-capable', provider, model };
    }
  }

  const policy = resolveRouteBudget(config, provider, model, representationHint(state, provider));
  const boundary = recentStepBoundary(session, policy.retainSteps);

  const measured: ImageOccurrence[] = [];
  try {
    for (const occurrence of occurrences) {
      const recent = occurrence.seq >= boundary;
      const bytes = occurrence.offloaded
        ? 0
        : await representedBytes(state, attachments, provider, model, policy, occurrence.attachment, facts.signal);
      measured.push({
        seq: occurrence.seq,
        imageIndex: occurrence.imageIndex,
        attachmentId: String(occurrence.attachment.attachmentId),
        bytes,
        offloaded: occurrence.offloaded,
        recent,
      });
    }
  } catch (error) {
    // A missing, corrupt, or unreadable attachment is not a reason to fail the
    // turn: skip this decision entirely and let the adapter see the real error.
    log.warn({
      event: 'estimate-failed',
      provider,
      model,
      representation: policy.representation,
      error: errorText(error),
    });
    return { action: 'noop', reason: 'estimate-failed', provider, model, policy };
  }

  const plan = planImageOffload(measured, policy);
  if (plan.targets.length === 0) {
    if (!plan.budgetSatisfied) {
      const key = `unsatisfiable:${provider}\u0000${model}`;
      if (!state.warned.has(key)) {
        state.warned.add(key);
        log.warn({
          event: 'budget-unsatisfiable',
          provider,
          model,
          policy: summarizePolicy(policy),
          payloadBytes: plan.payloadBytes,
          retainedCount: plan.retainedCount,
          reason: plan.reason,
        });
      }
    }
    return { action: 'noop', reason: plan.reason, provider, model, policy, plan };
  }

  const selectedDetail = describeSelection(measured, plan.targets);

  if (config.dryRun) {
    for (const item of selectedDetail) {
      log.info({
        event: 'would-offload',
        provider,
        model,
        representation: policy.representation,
        seq: item.seq,
        imageIndex: item.imageIndex,
        attachmentId: item.attachmentId,
        bytes: item.bytes,
      });
    }
    log.info({
      event: 'dry-run-summary',
      provider,
      model,
      request: requestFacts(facts, resolved, session),
      policy: summarizePolicy(policy),
      payloadBytes: plan.payloadBytes,
      payloadAfterBytes: plan.payloadAfterBytes,
      retainedCount: plan.retainedCount,
      retainedAfter: plan.retainedAfter,
      removedCount: plan.removedCount,
      budgetSatisfied: plan.budgetSatisfied,
    });
    return {
      action: 'would-offload',
      reason: plan.reason,
      provider,
      model,
      policy,
      plan,
      selected: plan.targets,
    };
  }

  const invalid = validateOffloadTargets(session, plan.targets);
  if (invalid !== undefined) {
    log.warn({ event: 'decision-rejected', provider, model, reason: invalid });
    return { action: 'noop', reason: 'stale-surface', provider, model, policy, plan };
  }

  let eventSeq: number;
  try {
    const mode = state.projectionMode ?? ensureImageOffloadProjection(state.ctx);
    state.projectionMode = mode;
    eventSeq = appendImageOffloadDecision(session, plan.targets);
  } catch (error) {
    log.warn({ event: 'append-failed', provider, model, error: errorText(error) });
    return { action: 'noop', reason: 'append-failed', provider, model, policy, plan };
  }

  log.info({
    event: 'offloaded',
    provider,
    model,
    request: requestFacts(facts, resolved, session),
    representation: policy.representation,
    projection: state.projectionMode ?? 'unknown',
    policy: summarizePolicy(policy),
    payloadBytes: plan.payloadBytes,
    payloadAfterBytes: plan.payloadAfterBytes,
    retainedCount: plan.retainedCount,
    retainedAfter: plan.retainedAfter,
    removedCount: plan.removedCount,
    budgetSatisfied: plan.budgetSatisfied,
    eventSeq,
    targets: selectedDetail,
  });

  return {
    action: 'offloaded',
    reason: plan.reason,
    provider,
    model,
    policy,
    plan,
    eventSeq,
    selected: plan.targets,
  };
}

/** Public guard instance returned by {@link createGuard}. */
export interface Guard {
  run(facts: GuardRequestFacts, resolved: LlmCallConfig): Promise<GuardDecision>;
  /** The guard's leveled, structure-preserving logger (used by {@link apply}). */
  readonly logger: GuardLogger;
}

/**
 * Build one guard instance. Kept separate from {@link apply} so tests can drive
 * the exact decision path without booting an agent loop.
 */
export function createGuard(ctx: Context, config: ImageBudgetGuardConfig): Guard {
  const state: GuardState = {
    ctx,
    config,
    log: createLogger(ctx, config.logLevel),
    sizeCache: new Map(),
    modelInfoCache: new Map(),
    representationCache: new Map(),
    warned: new Set(),
  };
  // A route may be re-registered with different modalities or representation.
  ctx.on('llm/adapters-updated', () => {
    state.modelInfoCache.clear();
    state.representationCache.clear();
  });
  return {
    run: (facts, resolved) => runGuard(state, facts, resolved),
    logger: state.log,
  };
}

/**
 * Mount the guard.
 *
 * The listener is prepended and awaits `next()` before deciding, so it observes
 * the final provider/model after every other `agent/request` listener (including
 * the model-selection rewriter) and still runs before `buildRequest()` derives
 * the surface. It always returns the configuration unchanged.
 *
 * @param ctx - plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: ImageBudgetGuardConfig): void {
  // The loader already validated through `Config`, but a direct call (tests,
  // embedded hosts) may pass a partial object; parsing again materializes the
  // documented defaults and keeps both entry points identical.
  const guard = createGuard(ctx, ConfigSchema.parse(config ?? {}));

  ctx.on(
    'agent/request',
    async (payload, next) => {
      const resolved = await next();
      try {
        await guard.run(
          {
            agent: payload.agent,
            turn: payload.turn,
            step: payload.step,
            signal: payload.signal,
          },
          resolved,
        );
      } catch (error) {
        // Never let a guard bug fail the step; the request continues unchanged.
        guard.logger.error({
          event: 'guard-failed',
          error: errorText(error),
          provider: resolved.provider,
          model: resolved.model,
        });
      }
      return resolved;
    },
    { prepend: true },
  );

  // Observation only: an IMAGE_OFFLOAD_REQUIRED that still happens is owned by
  // `compaction-image-offload`. This listener logs it and delegates unchanged.
  ctx.on('agent/request-error', async (payload, next) => {
    if (payload.failure.code === IMAGE_OFFLOAD_REQUIRED_CODE) {
      // `info` channel (see createLogger) so this observation survives the
      // default exporter; the record still says `severity: "warn"`.
      guard.logger.warn({
        event: 'image-offload-required-observed',
        provider: payload.provider,
        turn: payload.turn,
        step: payload.step,
        offloadImages: payload.failure.offloadImages ?? null,
        message: payload.failure.message,
      });
    }
    return next();
  });
}

export type { ImageBudgetGuardConfig, ImageBudgetGuardConfigInput, RouteBudgetPolicy } from './config.js';
export type { ImageOccurrence, OffloadTarget, SelectionResult } from './select.js';
export { ConfigSchema, resolveRouteBudget, routeEnabled, routeCapabilityOverride } from './config.js';
export { planImageOffload, base64Length } from './select.js';
export {
  IMAGE_OFFLOAD_EVENT,
  appendImageOffloadDecision,
  ensureImageOffloadProjection,
  hasImageOffloadProjection,
  isCompactionInProgress,
  recentStepBoundary,
  surfaceImageOccurrences,
  validateOffloadTargets,
} from './projection.js';
