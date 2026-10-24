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
import type { LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { type ImageBudgetGuardConfig, type RouteBudgetPolicy, type RouteRepresentation } from './config.js';
import { type OffloadTarget, type SelectionResult } from './select.js';
import { type ProjectionMode } from './projection.js';
/**
 * Zod schema the Harness loader validates before `apply()` runs.
 *
 * Cordis resolves a plugin's `Config` through the Standard Schema
 * `~standard.validate()` interface, which Zod 4 implements; `.strict()` makes
 * an unknown key a load-time `ValidationError` instead of a silent typo.
 */
export declare const Config: import("zod").ZodObject<{
    enabled: import("zod").ZodDefault<import("zod").ZodBoolean>;
    dryRun: import("zod").ZodDefault<import("zod").ZodBoolean>;
    representation: import("zod").ZodDefault<import("zod").ZodEnum<{
        "inline-base64": "inline-base64";
        files: "files";
        auto: "auto";
    }>>;
    maxRequestImageBytes: import("zod").ZodDefault<import("zod").ZodNumber>;
    maxRequestImages: import("zod").ZodDefault<import("zod").ZodNumber>;
    minRetainImages: import("zod").ZodDefault<import("zod").ZodNumber>;
    retainSteps: import("zod").ZodDefault<import("zod").ZodNumber>;
    quanta: import("zod").ZodDefault<import("zod").ZodNumber>;
    perRoute: import("zod").ZodDefault<import("zod").ZodArray<import("zod").ZodObject<{
        provider: import("zod").ZodString;
        model: import("zod").ZodString;
        enabled: import("zod").ZodOptional<import("zod").ZodBoolean>;
        representation: import("zod").ZodOptional<import("zod").ZodEnum<{
            "inline-base64": "inline-base64";
            files: "files";
        }>>;
        imageCapable: import("zod").ZodOptional<import("zod").ZodBoolean>;
        maxRequestImageBytes: import("zod").ZodOptional<import("zod").ZodNumber>;
        maxRequestImages: import("zod").ZodOptional<import("zod").ZodNumber>;
        minRetainImages: import("zod").ZodOptional<import("zod").ZodNumber>;
        retainSteps: import("zod").ZodOptional<import("zod").ZodNumber>;
        quanta: import("zod").ZodOptional<import("zod").ZodNumber>;
    }, import("zod/v4/core").$strict>>>;
    logLevel: import("zod").ZodDefault<import("zod").ZodEnum<{
        silent: "silent";
        error: "error";
        warn: "warn";
        info: "info";
        debug: "debug";
    }>>;
}, import("zod/v4/core").$strict>;
/** Plugin name used in diagnostics. */
export declare const name = "image-budget-guard";
/**
 * Services this plugin needs. `attachments` is deliberately absent: an image
 * route without an attachment store has nothing to measure, so the guard
 * degrades to a no-op instead of refusing to mount.
 */
export declare const inject: string[];
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
/** Guard-owned leveled logger that never changes harness-wide levels. */
interface GuardLogger {
    error(record: GuardLogRecord): void;
    warn(record: GuardLogRecord): void;
    info(record: GuardLogRecord): void;
    debug(record: GuardLogRecord): void;
}
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
export declare function runGuard(state: GuardState, facts: GuardRequestFacts, resolved: LlmCallConfig): Promise<GuardDecision>;
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
export declare function createGuard(ctx: Context, config: ImageBudgetGuardConfig): Guard;
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
export declare function apply(ctx: Context, config: ImageBudgetGuardConfig): void;
export type { ImageBudgetGuardConfig, ImageBudgetGuardConfigInput, RouteBudgetPolicy } from './config.js';
export type { ImageOccurrence, OffloadTarget, SelectionResult } from './select.js';
export { ConfigSchema, resolveRouteBudget, routeEnabled, routeCapabilityOverride } from './config.js';
export { planImageOffload, base64Length } from './select.js';
export { IMAGE_OFFLOAD_EVENT, appendImageOffloadDecision, ensureImageOffloadProjection, hasImageOffloadProjection, isCompactionInProgress, recentStepBoundary, surfaceImageOccurrences, validateOffloadTargets, } from './projection.js';
//# sourceMappingURL=index.d.ts.map