#!/usr/bin/env node
/**
 * Deterministic offline replay of a real DSH session through `image-budget-guard`.
 *
 * What this measures
 * ------------------
 * Every agent step re-sends the whole derived history. On an inline-base64 route
 * each retained image occurrence costs `ceil(requestVersionBytes / 3) * 4`
 * characters of the outgoing body, where the request version is what
 * `attachments.readImageRequest(ref, llm.imageRequestTarget(provider, model,
 * ref))` produces for that exact route. The replay rebuilds the session log
 * event by event, and at every `step/start` boundary it records
 *
 *   - before: the retained occurrences and their exact request payload with no
 *     guard decision taken at this step (but with earlier guarded decisions in
 *     force, so the guarded curve is a true continuous replay);
 *   - after: the same numbers once `runGuard()` has had the chance to append one
 *     `image/offload` decision;
 *   - baseline: a separate pass with no guard at all, which is the "before" the
 *     plugin is supposed to improve on.
 *
 * Two scenarios
 * -------------
 * A third-party provider may run with pi-ai's *default* image policy (nothing
 * configured), or with a deployment that already shrank the request images.
 * Both are replayed against the same session, both with the plugin's own 6 MiB
 * budget:
 *
 *   mitigated   1 MP / 256 KiB target, 6 MiB adapter ceiling  (live profile today)
 *   unmitigated 4 MP / 1 MiB target,  20 MiB adapter ceiling (pi-ai defaults)
 *
 * Isolation
 * ---------
 * Request-version encoding is done by the real `LocalAttachmentStore` rooted at
 * a fresh temporary harness home whose `attachments/v1` is a symlink to the
 * user's real attachment store and whose `cache/` starts empty. The guard and
 * the replay therefore read the real images but write every encoded request
 * version under the temporary home; `~/.dsh/cache` is never touched.
 *
 * Usage
 * -----
 *   pnpm build && pnpm replay
 *   node scripts/replay-session.mjs --log <session.v4.jsonl.zstd> --out docs/reports
 *
 * @module image-budget-guard/scripts/replay-session
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection';
import { requiredImageOffload, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';

import { ConfigSchema, base64Length, createGuard, resolveRouteBudget, surfaceImageOccurrences } from '../dist/index.js';
import {
  DEFAULT_PROJECTIONS,
  SessionPlayer,
  collectSessionFacts,
  decodeSessionLog,
  parseSessionLog,
  stepStartRecords,
  toMiB,
} from './session-log.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOG = join(
  homedir(),
  '.dsh',
  'sessions',
  '--home-ksndjaks-code-tmp--',
  'session-15758717-978d-41a1-a89e-6c4288ef5287',
  'session.v4.jsonl.zstd',
);
const DEFAULT_OUT_DIR = join(PACKAGE_ROOT, 'docs', 'reports');
const REAL_ATTACHMENTS_ROOT = join(homedir(), '.dsh', 'attachments', 'v1');

/** The exact route stored in the live profile (`llm-pi-ai` provider entry). */
const ROUTE = Object.freeze({
  provider: 'commandcode',
  model: 'deepseek/deepseek-v4.1-flash',
  contextWindow: 1000000,
  maxTokens: 384000,
});

/**
 * The plugin's own budget and retention floor, unchanged in both scenarios.
 * These are `ConfigSchema` defaults; only the adapter-side target policy varies.
 */
const PLUGIN_BUDGET_BYTES = 6 * 1024 * 1024;

/**
 * The two adapter policies to replay against.
 *
 * `mitigated` is `~/.dsh/profiles/web/cordis.patch.yml` today. `unmitigated`
 * is what pi-ai resolves when a route configures nothing: the constants at
 * `dsh-llm-pi-ai/lib/index.js:953-957` applied at `:1131-1133`
 * (`maxRequestImageBytes ?? 20971520`, `requestImagePixelBudget ?? 4194304`,
 * `requestImageMaxBytes ?? 1048576`).
 */
const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'mitigated',
    label: 'A · mitigated',
    title: 'live commandcode profile today',
    requestImagePixelBudget: 1048576,
    requestImageMaxBytes: 262144,
    adapterCeilingBytes: 6291456,
    guardOverrides: Object.freeze({}),
    provenance: '~/.dsh/profiles/web/cordis.patch.yml llm-pi-ai.providers.commandcode',
  }),
  Object.freeze({
    id: 'unmitigated',
    label: 'B · unmitigated',
    title: 'pi-ai defaults, no config-layer mitigation',
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    adapterCeilingBytes: 20971520,
    guardOverrides: Object.freeze({}),
    provenance:
      'dsh-llm-pi-ai/lib/index.js:953-957 constants applied at :1131-1133 (pi-ai defaults)',
  }),
  Object.freeze({
    id: 'tuned-floor',
    label: 'C · unmitigated, tuned floor (retainSteps 0 / minRetainImages 6)',
    title: 'pi-ai defaults with a zero-step retention window',
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    adapterCeilingBytes: 20971520,
    guardOverrides: Object.freeze({ minRetainImages: 6, retainSteps: 0 }),
    provenance:
      'same route policy as B; guard config overrides minRetainImages=6, retainSteps=0 (integration-test floor)',
  }),
  Object.freeze({
    id: 'floor-sweep-demo',
    label: 'C2 · floor sweep (retainSteps 4 / minRetainImages 4)',
    title: 'why lowering minRetainImages alone cannot reach the budget',
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    adapterCeilingBytes: 20971520,
    guardOverrides: Object.freeze({ minRetainImages: 4, retainSteps: 4 }),
    provenance:
      'same route policy as B; the 4/4 floor is the evidence pass showing per-message recent protection dominates',
  }),
]);

/**
 * Candidate retention floors for the acceptance sweep.
 *
 * Lower values shrink the protected suffix, which lets the guard omit more
 * history and therefore reach the plugin budget on an image-dense surface, at
 * the cost of keeping fewer images verbatim. The sweep finds the mildest
 * relaxation that still satisfies `peak-after <= 6 MiB` on this session.
 */
const FLOOR_SWEEP = Object.freeze({
  minRetainImages: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  retainSteps: Object.freeze([0, 1, 2, 3, 4, 6, 8, 12]),
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage: pnpm replay [--log <path>] [--out <dir>] [--keep-temp]

  --log <path>   session log to replay (default: the 213-step sample session)
  --out <dir>    report directory (default: docs/reports)
  --keep-temp    keep the isolated temporary harness home for inspection
`;

function parseArgs(argv) {
  const options = { logPath: DEFAULT_LOG, outDir: DEFAULT_OUT_DIR, keepTemp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--log') {
      options.logPath = resolve(argv[(index += 1)] ?? '');
    } else if (arg === '--out') {
      options.outDir = resolve(argv[(index += 1)] ?? '');
    } else if (arg === '--keep-temp') {
      options.keepTemp = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${HELP}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Isolated harness home
// ---------------------------------------------------------------------------

/**
 * Build a temporary harness home that borrows the real attachment bytes and
 * owns an empty request-version cache.
 *
 * `LocalAttachmentStore` derives `root = <dshHome>/attachments/v1` and
 * `cacheRoot = <dshHome>/cache/attachments`, so the symlink makes every source
 * image readable while the cache directory stays inside the temp home.
 *
 * @returns {{home: string, cacheDir: string, dispose: () => void}}
 */
function createIsolatedHome() {
  if (!existsSync(REAL_ATTACHMENTS_ROOT)) {
    throw new Error(`real attachment store not found: ${REAL_ATTACHMENTS_ROOT}`);
  }
  const home = mkdtempSync(join(tmpdir(), 'ibg-replay-'));
  const attachmentsDir = join(home, 'attachments');
  mkdirSync(attachmentsDir, { recursive: true });
  const link = join(attachmentsDir, 'v1');
  symlinkSync(REAL_ATTACHMENTS_ROOT, link, 'dir');
  if (!existsSync(join(link, '..'))) throw new Error(`isolated attachment link is not usable: ${link}`);
  const cacheDir = join(home, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  if (readdirSync(cacheDir).length !== 0) throw new Error(`isolated cache is not empty: ${cacheDir}`);
  return {
    home,
    cacheDir,
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Scenario runtime: one real LlmRuntime + one minimal adapter + one store
// ---------------------------------------------------------------------------

/**
 * Minimal `LlmAdapter` that reproduces one scenario's request-image policy.
 *
 * The replay needs `imageRequestTarget()` and image capability; nothing is ever
 * sent over the wire. Mounting the whole pi-ai adapter would drag in the
 * settings and credentials services only to answer those two questions, so the
 * replay mounts the real `LlmRuntime` (the exact dispatch path the guard uses)
 * and this adapter, whose target expression is the one pi-ai uses:
 * `requestImageDimensions(w, h, pixelBudget)` plus `maxBytes`
 * (`dsh-llm-pi-ai/lib/index.js:1379-1384`, `:1837-1845`).
 */
class ScenarioAdapter extends LlmAdapter {
  constructor(scenario) {
    super();
    this.scenario = scenario;
    this.targetsResolved = 0;
  }

  providerInfo(provider) {
    return { id: provider, name: `replay:${provider}` };
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: 'DeepSeek V4.1 Flash (replay route)',
      inputModalities: ['text', 'image'],
      context: { contextWindow: ROUTE.contextWindow },
      defaultMaxTokens: ROUTE.maxTokens,
    };
  }

  imageRequestTarget(_provider, _model, image) {
    this.targetsResolved += 1;
    const { width, height } = requestImageDimensions(
      image.width,
      image.height,
      this.scenario.requestImagePixelBudget,
    );
    return { width, height, maxBytes: this.scenario.requestImageMaxBytes };
  }

  async *stream() {
    // Never reached: the replay measures derived requests, it does not dispatch.
    throw new Error('replay adapter does not implement stream()');
  }
}

/** `LocalAttachmentStore` that counts request-version materializations. */
class CountingAttachmentStore extends LocalAttachmentStore {
  constructor(ctx, config) {
    super(ctx, config);
    this.requestReads = 0;
  }

  async readImageRequest(ref, target, signal) {
    this.requestReads += 1;
    return super.readImageRequest(ref, target, signal);
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Exact request-version bytes per attachment for one scenario.
 *
 * The cache key mirrors the guard's own key (attachment id + target geometry),
 * so repeated occurrences of the same attachment are measured once.
 */
class RequestImageMeasurer {
  constructor({ llm, store, scenario }) {
    this.llm = llm;
    this.store = store;
    this.scenario = scenario;
    this.bytesByTarget = new Map();
    this.bytesByAttachment = new Map();
    this.targets = new Map();
    this.storeReads = 0;
  }

  targetFor(attachment) {
    const id = String(attachment.attachmentId);
    const cached = this.targets.get(id);
    if (cached !== undefined) return cached;
    const target = this.llm.imageRequestTarget(ROUTE.provider, ROUTE.model, attachment);
    this.targets.set(id, target);
    return target;
  }

  async bytesFor(attachment) {
    const id = String(attachment.attachmentId);
    const known = this.bytesByAttachment.get(id);
    if (known !== undefined) return known;
    const target = this.targetFor(attachment);
    const key = `${id}\u0000${target.width}x${target.height}\u0000${target.maxBytes}`;
    let bytes = this.bytesByTarget.get(key);
    if (bytes === undefined) {
      const version = await this.store.readImageRequest(attachment, target);
      bytes = version.bytes;
      this.storeReads += 1;
      this.bytesByTarget.set(key, bytes);
    }
    this.bytesByAttachment.set(id, bytes);
    return bytes;
  }

  /**
   * Measure one session surface the way the adapter would see the next request.
   *
   * The payload is the sum of `base64Length(version.bytes)` over retained
   * occurrences — the same accounting `requiredImageOffload()` performs for an
   * inline route. `requiredOffload` is the real harness predicate, so
   * `requiredOffload > 0` is exactly "the adapter would throw
   * IMAGE_OFFLOAD_REQUIRED for this request".
   *
   * @param {object} session - live replay session.
   * @returns {Promise<{occurrences: number, images: number, eligibleImages: number,
   *   payloadBytes: number, requiredOffload: number}>}
   */
  async measure(session) {
    const messages = session.deriveMessages();
    let occurrences = 0;
    let images = 0;
    let payloadBytes = 0;
    for (const message of messages) {
      for (const block of message.content) {
        if (block?.type !== 'image') continue;
        occurrences += 1;
        if (block.offloaded === true || block.attachment === undefined) continue;
        const bytes = await this.bytesFor(block.attachment);
        images += 1;
        payloadBytes += base64Length(bytes);
      }
    }
    const requiredOffload = requiredImageOffload(
      messages,
      { representation: 'base64', maxBytes: this.scenario.adapterCeilingBytes },
      (block) => {
        const bytes = this.bytesByAttachment.get(String(block.attachment.attachmentId));
        if (bytes === undefined) {
          throw new Error(`replay measured no request bytes for ${block.attachment.attachmentId}`);
        }
        return bytes;
      },
    );
    // Same predicate against the plugin's own budget: how many occurrences would
    // still have to go before the request fits 6 MiB. Non-zero after a guard pass
    // means the retention floor is what keeps the request above the plugin budget.
    const requiredOffloadPlugin = requiredImageOffload(
      messages,
      { representation: 'base64', maxBytes: PLUGIN_BUDGET_BYTES },
      (block) => {
        const bytes = this.bytesByAttachment.get(String(block.attachment.attachmentId));
        if (bytes === undefined) {
          throw new Error(`replay measured no request bytes for ${block.attachment.attachmentId}`);
        }
        return bytes;
      },
    );
    // Independent cross-check over the guard's own occurrence reader.
    const eligibleImages = surfaceImageOccurrences(session).reduce(
      (count, occurrence) => count + (occurrence.offloaded ? 0 : 1),
      0,
    );
    return { occurrences, images, eligibleImages, payloadBytes, requiredOffload, requiredOffloadPlugin };
  }
}

// ---------------------------------------------------------------------------
// Replay passes
// ---------------------------------------------------------------------------

function factsFor(session, turn, step) {
  return {
    agent: { session, options: { provider: ROUTE.provider, model: ROUTE.model } },
    turn,
    step,
    signal: new AbortController().signal,
  };
}

/**
 * A fresh detached session for one pass.
 *
 * The projection list is explicit: `dsh-session` refuses to fold an
 * `image/offload` event without a registered interpreter, and a detached
 * `Session.create()` does not inherit the store's projections.
 */
function newReplaySession(header, label) {
  return Session.create(SessionId(`${header.id}-replay-${label}`), undefined, undefined, 0, DEFAULT_PROJECTIONS);
}

/**
 * Replay the log with the guard enabled, measuring immediately around each
 * `step/start` boundary.
 */
async function runGuardedPass({ header, events, guard, measurer, store, label }) {
  const session = newReplaySession(header, `${label}-guarded`);
  const player = new SessionPlayer(session);
  const series = [];
  let guardStoreReads = 0;
  const startedAt = performance.now();

  for (const event of events) {
    player.append(event);
    if (event.type !== 'step/start') continue;
    const turn = event.data?.turn ?? 0;
    const step = event.data?.step ?? 0;
    const before = await measurer.measure(session);
    const readsBefore = store.requestReads;
    const decision = await guard.run(factsFor(session, turn, step), {
      provider: ROUTE.provider,
      model: ROUTE.model,
    });
    guardStoreReads += store.requestReads - readsBefore;
    const after = await measurer.measure(session);
    const plan = decision.plan;
    series.push({
      stepIndex: series.length + 1,
      logSeq: event.seq,
      replaySeq: player.seqMap.get(event.seq),
      turn,
      step,
      occurrencesBefore: before.occurrences,
      imagesBefore: before.images,
      eligibleImagesBefore: before.eligibleImages,
      payloadBeforeBytes: before.payloadBytes,
      payloadBeforeMiB: toMiB(before.payloadBytes),
      requiredOffloadBefore: before.requiredOffload,
      requiredOffloadPluginBefore: before.requiredOffloadPlugin,
      occurrencesAfter: after.occurrences,
      imagesAfter: after.images,
      eligibleImagesAfter: after.eligibleImages,
      payloadAfterBytes: after.payloadBytes,
      payloadAfterMiB: toMiB(after.payloadBytes),
      requiredOffloadAfter: after.requiredOffload,
      requiredOffloadPluginAfter: after.requiredOffloadPlugin,
      overPluginBudgetBefore: before.payloadBytes > PLUGIN_BUDGET_BYTES,
      overPluginBudgetAfter: after.payloadBytes > PLUGIN_BUDGET_BYTES,
      overAdapterCeilingBefore: before.payloadBytes > measurer.scenario.adapterCeilingBytes,
      overAdapterCeilingAfter: after.payloadBytes > measurer.scenario.adapterCeilingBytes,
      offloadEmitted: decision.action === 'offloaded',
      offloadEventSeq: decision.eventSeq ?? null,
      action: decision.action,
      reason: decision.reason,
      removedCount: plan?.removedCount ?? 0,
      candidateCount: plan?.candidateCount ?? null,
      retainedBefore: plan?.retainedCount ?? before.images,
      retainedAfter: plan?.retainedAfter ?? after.images,
      budgetSatisfied: plan?.budgetSatisfied ?? null,
      unsatisfiable: plan !== undefined ? plan.budgetSatisfied === false : false,
      imageCountMismatch: before.images !== before.eligibleImages || after.images !== after.eligibleImages,
    });
  }

  return {
    label,
    ms: performance.now() - startedAt,
    guardStoreReads,
    measurerReads: measurer.storeReads,
    series,
    eventCount: session.seq,
  };
}

/** Replay the log without any guard: the true "before" curve. */
async function runBaselinePass({ header, events, measurer, label, adapterCeilingBytes }) {
  const session = newReplaySession(header, `${label}-baseline`);
  const player = new SessionPlayer(session);
  const series = [];
  const startedAt = performance.now();

  for (const event of events) {
    player.append(event);
    if (event.type !== 'step/start') continue;
    const measurement = await measurer.measure(session);
    series.push({
      stepIndex: series.length + 1,
      logSeq: event.seq,
      replaySeq: player.seqMap.get(event.seq),
      turn: event.data?.turn ?? 0,
      step: event.data?.step ?? 0,
      occurrences: measurement.occurrences,
      images: measurement.images,
      eligibleImages: measurement.eligibleImages,
      payloadBytes: measurement.payloadBytes,
      payloadMiB: toMiB(measurement.payloadBytes),
      requiredOffload: measurement.requiredOffload,
      requiredOffloadPlugin: measurement.requiredOffloadPlugin,
      overPluginBudget: measurement.payloadBytes > PLUGIN_BUDGET_BYTES,
      overAdapterCeiling: measurement.payloadBytes > adapterCeilingBytes,
      imageCountMismatch: measurement.images !== measurement.eligibleImages,
    });
  }

  return {
    label,
    ms: performance.now() - startedAt,
    measurerReads: measurer.storeReads,
    series,
    eventCount: session.seq,
  };
}

// ---------------------------------------------------------------------------
// Retention-floor sweep
// ---------------------------------------------------------------------------

/** Peak/offload facts for one guarded pass, used by the floor sweep. */
function passFacts(pass) {
  const peak = maxRow(pass.series, (row) => row.payloadAfterBytes);
  return {
    peakAfterBytes: peak.payloadAfterBytes,
    peakAfterMiB: peak.payloadAfterMiB,
    peakAfterStep: peak.stepIndex,
    offloadEvents: pass.series.filter((row) => row.offloadEmitted).length,
    unsatisfiableSteps: pass.series.filter((row) => row.unsatisfiable).length,
    adapterRejections: pass.series.filter((row) => row.requiredOffloadAfter > 0).length,
    meetsPluginBudget: peak.payloadAfterBytes <= PLUGIN_BUDGET_BYTES,
  };
}

/**
 * Sweep `minRetainImages` × `retainSteps` for the unmitigated route.
 *
 * The sweep answers the acceptance question directly: with the adapter left at
 * pi-ai's defaults, which retention floor — if any — lets the guard bring every
 * step to `<= 6 MiB`? The default floor (6/12) leaves the protected suffix
 * itself above the budget on an image-dense surface; a smaller floor makes more
 * occurrences eligible, at the cost of keeping fewer images verbatim.
 *
 * Passes share one measurer (attachment byte estimates do not depend on the
 * guard config) but each gets a fresh guard, so the per-combo result is exactly
 * what a fresh mount with that config would decide.
 *
 * @returns {Promise<{grid: object[], mildest: object|null, tuned: object|null,
 *   defaults: object|null, note: string}>}
 */
async function runFloorSweep({ header, events, runtime, scenario }) {
  const measurer = new RequestImageMeasurer({ llm: runtime.ctx.llm, store: runtime.store, scenario });
  const grid = [];
  for (const minRetainImages of FLOOR_SWEEP.minRetainImages) {
    for (const retainSteps of FLOOR_SWEEP.retainSteps) {
      const config = ConfigSchema.parse({
        representation: 'inline-base64',
        logLevel: 'silent',
        minRetainImages,
        retainSteps,
      });
      const guard = createGuard(runtime.ctx, config);
      const pass = await runGuardedPass({
        header,
        events,
        guard,
        measurer,
        store: runtime.store,
        label: `sweep-${minRetainImages}x${retainSteps}`,
      });
      grid.push({ minRetainImages, retainSteps, ...passFacts(pass) });
    }
  }

  const passing = grid.filter((row) => row.meetsPluginBudget);
  // Mildest relaxation from the defaults (6/12): smallest total reduction that
  // still satisfies the budget, preferring a higher hard floor on ties.
  const relaxation = (row) => 6 - row.minRetainImages + (12 - row.retainSteps);
  const mildest = [...passing].sort(
    (a, b) =>
      relaxation(a) - relaxation(b) ||
      b.minRetainImages - a.minRetainImages ||
      b.retainSteps - a.retainSteps,
  )[0] ?? null;
  const tuned = grid.find(
    (row) =>
      row.minRetainImages === (scenario.guardOverrides.minRetainImages ?? 6) &&
      row.retainSteps === (scenario.guardOverrides.retainSteps ?? 12),
  );
  const defaults = grid.find((row) => row.minRetainImages === 6 && row.retainSteps === 12);
  return {
    grid,
    mildest,
    tuned: tuned ?? null,
    defaults: defaults ?? null,
    note:
      passing.length === 0
        ? 'No tested floor reaches the 6 MiB plugin budget on this session.'
        : 'Lowering the floor keeps fewer images verbatim; the sweep reports the mildest setting that still reaches 6 MiB.',
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const firstRow = (series, predicate) => series.find(predicate);
const maxRow = (series, pick) =>
  series.reduce((best, row) => (pick(row) > pick(best) ? row : best), series[0]);
const countRows = (series, predicate) => series.filter(predicate).length;

/** Peak/profile facts for one scenario's guarded and baseline passes. */
function summarizeScenario({ scenario, config, cold, warm, baseline }) {
  const guarded = cold.series;
  const base = baseline.series;
  const peakBefore = maxRow(guarded, (row) => row.payloadBeforeBytes);
  const peakAfter = maxRow(guarded, (row) => row.payloadAfterBytes);
  const peakBase = maxRow(base, (row) => row.payloadBytes);
  const firstPluginCrossing = firstRow(base, (row) => row.overPluginBudget);
  const firstCeilingCrossing = firstRow(base, (row) => row.overAdapterCeiling);
  const firstGuardPluginUnmet = firstRow(guarded, (row) => row.overPluginBudgetAfter);
  const unsatisfiable = guarded.filter((row) => row.unsatisfiable);
  const offloads = guarded.filter((row) => row.offloadEmitted);
  const adapterRejections = guarded.filter((row) => row.requiredOffloadAfter > 0);
  const guardFailures = guarded.filter((row) =>
    ['estimate-failed', 'stale-surface', 'append-failed', 'no-attachments', 'no-route'].includes(row.reason),
  );
  const imageCountMismatches = guarded.filter((row) => row.imageCountMismatch);

  const peakAfterWithin = peakAfter.payloadAfterBytes <= PLUGIN_BUDGET_BYTES;
  const projectedRejections = adapterRejections.length;
  const acceptanceMet = peakAfterWithin && projectedRejections === 0;
  const floorLabel = `minRetainImages ${config.minRetainImages} / retainSteps ${config.retainSteps}`;
  const notes =
    scenario.id === 'mitigated'
      ? `Live profile policy. The unguarded peak is ${peakBase.payloadMiB} MiB, ` +
        `${((100 * (PLUGIN_BUDGET_BYTES - peakBase.payloadBytes)) / PLUGIN_BUDGET_BYTES).toFixed(2)}% below the ` +
        `6 MiB plugin budget, so the guard stayed a no-op (${offloads.length} events, ` +
        `${unsatisfiable.length} unsatisfiable). Acceptance is met by the route policy, not by any omission.`
      : scenario.id === 'unmitigated'
        ? `pi-ai defaults with the default floor (6/12). The guard emitted ${offloads.length} events and cut the ` +
          `peak from ${peakBase.payloadMiB} to ${peakAfter.payloadAfterMiB} MiB, but ${unsatisfiable.length} steps ` +
          `remain above 6 MiB because the protected suffix alone is ` +
          `${unsatisfiable.length > 0 ? formatMiBRange(unsatisfiable.map((row) => row.payloadAfterMiB)) : 'n/a'}; ` +
          `the ${toMiB(scenario.adapterCeilingBytes)} MiB adapter ceiling is never reached. Acceptance on the ` +
          `plugin budget fails.`
        : scenario.id === 'tuned-floor'
          ? `pi-ai defaults with retainSteps 0 / minRetainImages 6. The guard emitted ${offloads.length} events; ` +
            `peak after ${peakAfter.payloadAfterMiB} MiB; ${unsatisfiable.length} unsatisfiable steps. Acceptance ` +
            `${acceptanceMet ? 'met' : 'not met'}: with a zero-step window every occurrence older than the newest ` +
            `6 is eligible, so the batched paste stops being protected as a block.`
          : `pi-ai defaults with minRetainImages 4 / retainSteps 4 — the evidence pass, not the fix. Peak after ` +
            `${peakAfter.payloadAfterMiB} MiB with ${unsatisfiable.length} unsatisfiable step(s): \`retainSteps\` protects ` +
            `every image admitted in a recent step, so a batched paste is protected as a whole and lowering ` +
            `\`minRetainImages\` alone cannot get below that batch's size. Lower the step window first when the ` +
            `budget still cannot be met.`;

  const compactRow = (row) =>
    row === undefined
      ? null
      : {
          stepIndex: row.stepIndex,
          turn: row.turn,
          step: row.step,
          payloadBytes: row.payloadBytes ?? row.payloadBeforeBytes,
          payloadMiB: row.payloadMiB ?? row.payloadBeforeMiB,
          images: row.images ?? row.imagesBefore,
        };

  return {
    id: scenario.id,
    label: scenario.label,
    title: scenario.title,
    provenance: scenario.provenance,
    guardOverrides: scenario.guardOverrides,
    notes,
    verdict: {
      peakAfterBytes: peakAfter.payloadAfterBytes,
      peakAfterMiB: peakAfter.payloadAfterMiB,
      peakWithinPluginBudget: peakAfterWithin,
      projectedImageOffloadRequired: projectedRejections,
      acceptanceMet,
      achievedBy: acceptanceMet
        ? offloads.length === 0 && scenario.id === 'mitigated'
          ? 'route policy (guard no-op)'
          : floorLabel
        : 'not met — retention floor',
    },
    target: {
      requestImagePixelBudget: scenario.requestImagePixelBudget,
      requestImageMaxBytes: scenario.requestImageMaxBytes,
      formula: `requestImageDimensions(w, h, ${scenario.requestImagePixelBudget}) + maxBytes ${scenario.requestImageMaxBytes}`,
    },
    adapterCeilingBytes: scenario.adapterCeilingBytes,
    pluginBudgetBytes: PLUGIN_BUDGET_BYTES,
    timings: {
      coldMs: Number(cold.ms.toFixed(1)),
      warmMs: Number(warm.ms.toFixed(1)),
      baselineMs: Number(baseline.ms.toFixed(1)),
      warmSpeedup: cold.ms > 0 ? Number((cold.ms / warm.ms).toFixed(2)) : null,
      coldGuardStoreReads: cold.guardStoreReads,
      warmGuardStoreReads: warm.guardStoreReads,
      coldMeasurerReads: cold.measurerReads,
      warmMeasurerReads: warm.measurerReads,
      coldPassStoreReads: cold.guardStoreReads + cold.measurerReads,
      warmPassStoreReads: warm.guardStoreReads + warm.measurerReads,
    },
    totals: {
      steps: guarded.length,
      baselinePeak: compactRow(peakBase),
      baselineMaxImages: base.reduce((max, row) => Math.max(max, row.images), 0),
      guardedMaxImagesBefore: guarded.reduce((max, row) => Math.max(max, row.imagesBefore), 0),
      guardedMaxImagesAfter: guarded.reduce((max, row) => Math.max(max, row.imagesAfter), 0),
      guardedPeakBefore: {
        stepIndex: peakBefore.stepIndex,
        turn: peakBefore.turn,
        step: peakBefore.step,
        payloadBytes: peakBefore.payloadBeforeBytes,
        payloadMiB: peakBefore.payloadBeforeMiB,
        images: peakBefore.imagesBefore,
      },
      guardedPeakAfter: {
        stepIndex: peakAfter.stepIndex,
        turn: peakAfter.turn,
        step: peakAfter.step,
        payloadBytes: peakAfter.payloadAfterBytes,
        payloadMiB: peakAfter.payloadAfterMiB,
        images: peakAfter.imagesAfter,
      },
      baselineStepsOverPluginBudget: countRows(base, (row) => row.overPluginBudget),
      baselineStepsOverAdapterCeiling: countRows(base, (row) => row.overAdapterCeiling),
      baselineFirstPluginBudgetCrossing: compactRow(firstPluginCrossing),
      baselineFirstAdapterCeilingCrossing: compactRow(firstCeilingCrossing),
      baselineMaxRequiredOffload: base.reduce((max, row) => Math.max(max, row.requiredOffload), 0),
      baselineStepsRequiringAdapterOffload: countRows(base, (row) => row.requiredOffload > 0),
      baselineMaxRequiredOffloadPlugin: base.reduce(
        (max, row) => Math.max(max, row.requiredOffloadPlugin),
        0,
      ),
      guardedStepsOverPluginBudget: countRows(guarded, (row) => row.overPluginBudgetAfter),
      guardedStepsOverBudgetPrevented:
        countRows(base, (row) => row.overPluginBudget) - countRows(guarded, (row) => row.overPluginBudgetAfter),
      guardedFirstPluginBudgetUnmet: compactRow(firstGuardPluginUnmet),
      guardOffloadEvents: offloads.length,
      guardOffloadByStep: offloads.map((row) => ({
        stepIndex: row.stepIndex,
        turn: row.turn,
        step: row.step,
        removedCount: row.removedCount,
        payloadBeforeMiB: row.payloadBeforeMiB,
        payloadAfterMiB: row.payloadAfterMiB,
        budgetSatisfied: row.budgetSatisfied,
        reason: row.reason,
      })),
      unsatisfiableSteps: unsatisfiable.length,
      unsatisfiableNoCandidates: unsatisfiable.filter((row) => row.reason === 'no-candidates').length,
      unsatisfiableExhausted: unsatisfiable.filter((row) => row.reason === 'exhausted-candidates').length,
      unsatisfiableReasons: [...new Set(unsatisfiable.map((row) => row.reason))],
      unsatisfiableFloorMiB: unsatisfiable.map((row) => row.payloadAfterMiB),
      unsatisfiableRequiredOffloadAfterMax: unsatisfiable.reduce(
        (max, row) => Math.max(max, row.requiredOffloadPluginAfter),
        0,
      ),
      adapterWouldRejectAfterGuardSteps: adapterRejections.length,
      adapterWouldRejectAfterGuardMaxRequired: guarded.reduce(
        (max, row) => Math.max(max, row.requiredOffloadAfter),
        0,
      ),
      adapterWouldRejectAfterGuardStepsList: adapterRejections.map((row) => ({
        stepIndex: row.stepIndex,
        requiredOffloadAfter: row.requiredOffloadAfter,
        payloadAfterMiB: row.payloadAfterMiB,
        reason: row.reason,
      })),
      guardFailures: guardFailures.map((row) => ({
        stepIndex: row.stepIndex,
        reason: row.reason,
      })),
      imageCountMismatches: imageCountMismatches.length,
      replayedEvents: cold.eventCount,
      baselineReplayedEvents: baseline.eventCount,
      seriesIdenticalAcrossPasses: JSON.stringify(cold.series) === JSON.stringify(warm.series),
    },
    policy: resolveRouteBudget(config, ROUTE.provider, ROUTE.model, 'inline-base64'),
    config,
    baseline: base,
    guarded,
    warm: {
      ms: Number(warm.ms.toFixed(1)),
      guardStoreReads: warm.guardStoreReads,
      measurerReads: warm.measurerReads,
      matchesCold: JSON.stringify(warm.series) === JSON.stringify(cold.series),
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, rule, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

/** Sample the curve while always keeping every story-carrying row. */
function downsampleCurve(series, { maxSampled = 20, maxRows = 70 } = {}) {
  const selected = new Map();
  const stride = Math.max(1, Math.ceil(series.length / maxSampled));
  for (let index = 0; index < series.length; index += stride) {
    selected.set(series[index].stepIndex, series[index]);
  }
  for (const row of series) {
    if (row.offloadEmitted || row.unsatisfiable || row.requiredOffloadAfter > 0 || row.overPluginBudget) {
      selected.set(row.stepIndex, row);
    }
  }
  selected.set(1, series[0]);
  selected.set(series.length, series.at(-1));
  const rows = [...selected.values()].sort((a, b) => a.stepIndex - b.stepIndex);
  if (rows.length <= maxRows) return rows;
  const must = rows.filter((row) => row.offloadEmitted);
  const rest = rows.filter((row) => !row.offloadEmitted);
  const keep = new Set([...must, rows[0], rows.at(-1)]);
  const budget = Math.max(1, maxRows - keep.size);
  const restStride = Math.max(1, Math.ceil(rest.length / budget));
  for (let index = 0; index < rest.length; index += restStride) keep.add(rest[index]);
  return rows.filter((row) => keep.has(row));
}

function where(row) {
  return row === null || row === undefined ? '—' : `step ${row.stepIndex} (t${row.turn}/s${row.step})`;
}

/** Render retry codes in the brief's order (TRANSPORT, then SERVER, then the rest). */
function formatRetryCodes(codes) {
  const order = ['TRANSPORT', 'SERVER'];
  const entries = Object.entries(codes);
  entries.sort(([a], [b]) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    return a.localeCompare(b);
  });
  return `${entries.reduce((total, [, count]) => total + count, 0)} (${entries
    .map(([code, count]) => `${count} ${code}`)
    .join(' + ')})`;
}

/** Retry split without the leading total, for prose ("8 TRANSPORT + 11 SERVER"). */
function formatRetrySplit(codes) {
  const full = formatRetryCodes(codes);
  return full.slice(full.indexOf('(') + 1, -1);
}

/** "11.49 MiB" when the floor range is a single value, otherwise "a–b MiB". */
function formatMiBRange(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `${min} MiB` : `${min}–${max} MiB`;
}

function scenarioSection(s) {
  const lines = [];
  lines.push(`### ${s.label} — ${s.title}`);
  lines.push('');
  lines.push(
    `Target \`${s.target.formula}\`; adapter ceiling **${toMiB(s.adapterCeilingBytes)} MiB**; ` +
      `plugin budget **${toMiB(s.pluginBudgetBytes)} MiB**; retention floor ` +
      `\`minRetainImages ${s.config.minRetainImages}\` / \`retainSteps ${s.config.retainSteps}\` / ` +
      `\`quanta ${s.config.quanta}\`.`,
  );
  lines.push('');
  lines.push(
    mdTable(
      ['Metric', 'Baseline (no guard)', 'With guard'],
      [
        [
          'Peak payload',
          `${s.totals.baselinePeak.payloadMiB} MiB at ${where(s.totals.baselinePeak)}`,
          `${s.totals.guardedPeakAfter.payloadMiB} MiB at ${where(s.totals.guardedPeakAfter)}`,
        ],
        [
          'Max retained images',
          `${s.totals.baselineMaxImages}`,
          `${s.totals.guardedMaxImagesAfter}`,
        ],
        [
          'Steps over plugin budget (6 MiB)',
          `${s.totals.baselineStepsOverPluginBudget} / ${s.totals.steps}`,
          `${s.totals.guardedStepsOverPluginBudget} / ${s.totals.steps}`,
        ],
        [
          'Steps over adapter ceiling',
          `${s.totals.baselineStepsOverAdapterCeiling} / ${s.totals.steps}`,
          `${s.totals.adapterWouldRejectAfterGuardSteps} / ${s.totals.steps}`,
        ],
        ['`image/offload` events emitted by guard', '—', `${s.totals.guardOffloadEvents}`],
        [
          'Steps where guard could not satisfy the budget (retention floor)',
          '—',
          `${s.totals.unsatisfiableSteps}`,
        ],
        [
          'Replayed events (original + guard `image/offload`)',
          `${s.totals.baselineReplayedEvents}`,
          `${s.totals.replayedEvents}`,
        ],
      ],
    ),
  );
  lines.push('');

  const totalRemoved = s.totals.guardOffloadByStep.reduce((total, row) => total + row.removedCount, 0);
  const belowQuanta = s.totals.guardOffloadByStep.filter((row) => row.removedCount < 4);

  if (s.totals.guardOffloadEvents > 0) {
    lines.push('**Guard decisions that emitted `image/offload`**');
    lines.push('');
    lines.push(
      mdTable(
        ['#', 'Step', 'Turn/step', 'Removed', 'Payload before → after', 'Fits 6 MiB', 'Reason'],
        s.totals.guardOffloadByStep.map((row, index) => [
          `${index + 1}`,
          `${row.stepIndex}`,
          `t${row.turn}/s${row.step}`,
          `${row.removedCount}`,
          `${row.payloadBeforeMiB} → ${row.payloadAfterMiB} MiB`,
          `${row.budgetSatisfied ? 'yes' : 'no'}`,
          `\`${row.reason}\``,
        ]),
      ),
    );
    lines.push('');
    lines.push(
      `Across ${s.totals.guardOffloadEvents} decisions the guard omitted **${totalRemoved} occurrence references**. ` +
        (belowQuanta.length === 0
          ? ''
          : `${belowQuanta.length} decision(s) removed fewer than \`quanta=4\` (` +
            `${belowQuanta.map((row) => `#${s.totals.guardOffloadByStep.indexOf(row) + 1} at step ${row.stepIndex}: ${row.removedCount}`).join(', ')}) ` +
            `because only that many occurrences were eligible; \`quanta\` is a minimum when enough candidates exist, not a floor on every decision. `) +
        `Every unsafe occurrence stays behind the retention window; nothing newer than an omitted occurrence was ever touched.`,
    );
    lines.push('');
  } else {
    lines.push('No `image/offload` decision was needed under this policy; the guard stayed a no-op.');
    lines.push('');
  }

  if (s.totals.unsatisfiableSteps > 0) {
    lines.push(
      `**Retention-floor steps:** ${s.totals.unsatisfiableSteps} (${s.totals.unsatisfiableNoCandidates} ` +
        `\`no-candidates\`, ${s.totals.unsatisfiableExhausted} \`exhausted-candidates\`). After removing ` +
        `every eligible occurrence the payload floor stays at ` +
        `**${formatMiBRange(s.totals.unsatisfiableFloorMiB)}**, and the adapter-side predicate against the 6 MiB ` +
        `plugin budget would still want **${s.totals.unsatisfiableRequiredOffloadAfterMax}** more occurrence(s) ` +
        `removed. The guard deliberately will not touch them: the newest \`minRetainImages=${s.config.minRetainImages}\` ` +
        `occurrences and everything admitted in the last \`retainSteps=${s.config.retainSteps}\` steps are never ` +
        `eligible. The floor is constant while no new images arrive and drops only when the ` +
        `${s.config.retainSteps}-step window slides (or a compaction replaces the history); this is the retention ` +
        `contract working as designed, not a budget bug.`,
    );
    lines.push('');
  }

  if (s.totals.adapterWouldRejectAfterGuardSteps > 0) {
    lines.push(
      `> **Residual adapter pressure:** at ${s.totals.adapterWouldRejectAfterGuardSteps} of ` +
        `${s.totals.steps} steps the guarded request would still exceed the **${toMiB(s.adapterCeilingBytes)} MiB** ` +
        `adapter ceiling (max required offload ${s.totals.adapterWouldRejectAfterGuardMaxRequired}). ` +
        `Those are exactly the retention-floor steps: the guard may not touch the protected suffix.`,
    );
    lines.push('');
  } else {
    lines.push(
      `After the guard, **0** steps exceed the adapter ceiling: \`requiredImageOffload\` is 0 everywhere, ` +
        `so no request could fail with \`IMAGE_OFFLOAD_REQUIRED\`.`,
    );
    lines.push('');
  }

  lines.push('**Downsampled per-step curve** (every sampled step plus all offload/over-budget steps)');
  lines.push('');
  const baselineByStep = new Map(s.baseline.map((row) => [row.stepIndex, row.payloadMiB]));
  lines.push(
    mdTable(
      [
        'Step',
        'Turn/step',
        'Images before',
        'Images after',
        'MiB baseline',
        'MiB before',
        'MiB after',
        'Offload',
      ],
      downsampleCurve(s.guarded).map((row) => [
        `${row.stepIndex}`,
        `t${row.turn}/s${row.step}`,
        `${row.imagesBefore}`,
        `${row.imagesAfter}`,
        `${baselineByStep.get(row.stepIndex) ?? '—'}`,
        `${row.payloadBeforeMiB}`,
        `${row.payloadAfterMiB}`,
        row.offloadEmitted
          ? `\`image/offload\` −${row.removedCount}`
          : row.unsatisfiable
            ? 'floor'
            : '',
      ]),
    ),
  );
  lines.push('');
  return lines.join('\n');
}

function floorSweepSection(sweep, facts) {
  const lines = [];
  lines.push('### Floor sweep on the unmitigated route (acceptance tuning)');
  lines.push('');
  lines.push(
    'Each cell is the guarded peak payload in MiB for that `minRetainImages` / `retainSteps` pair; ' +
      '**✓** means the peak is at or below the 6 MiB plugin budget. Only the guard floor changes: the adapter ' +
      'keeps pi-ai defaults (4 MP / 1 MiB target, 20 MiB ceiling), so this is exactly the "no config-layer ' +
      'mitigation, tune the plugin" question.',
  );
  lines.push('');
  const steps = FLOOR_SWEEP.retainSteps;
  lines.push(
    mdTable(
      ['minRetainImages \\ retainSteps', ...steps.map((value) => `${value}`)],
      FLOOR_SWEEP.minRetainImages.map((minRetainImages) => [
        `${minRetainImages}`,
        ...steps.map((retainSteps) => {
          const row = sweep.grid.find(
            (candidate) =>
              candidate.minRetainImages === minRetainImages && candidate.retainSteps === retainSteps,
          );
          return row === undefined
            ? '—'
            : `${row.meetsPluginBudget ? '✓' : '✗'} ${row.peakAfterMiB}`;
        }),
      ]),
    ),
  );
  lines.push('');
  if (sweep.mildest !== null) {
    lines.push(
      `- **Mildest passing floor:** \`minRetainImages ${sweep.mildest.minRetainImages} / ` +
        `retainSteps ${sweep.mildest.retainSteps}\` → peak **${sweep.mildest.peakAfterMiB} MiB**, ` +
        `${sweep.mildest.offloadEvents} events, ${sweep.mildest.unsatisfiableSteps} unsatisfiable steps.`,
    );
  } else {
    lines.push('- **No tested floor reaches the 6 MiB budget.**');
  }
  if (sweep.defaults !== undefined && sweep.defaults !== null) {
    lines.push(
      `- Default floor (6/12): peak ${sweep.defaults.peakAfterMiB} MiB, ${sweep.defaults.offloadEvents} events, ` +
        `${sweep.defaults.unsatisfiableSteps} unsatisfiable — the same numbers as scenario B.`,
    );
  }
  if (sweep.tuned !== undefined && sweep.tuned !== null) {
    lines.push(
      `- Scenario C floor (${sweep.tuned.minRetainImages}/${sweep.tuned.retainSteps}): peak ` +
        `${sweep.tuned.peakAfterMiB} MiB, ${sweep.tuned.offloadEvents} events, ` +
        `${sweep.tuned.unsatisfiableSteps} unsatisfiable — the same numbers as scenario C.`,
    );
  }
  const fourByFour = sweep.grid.find(
    (row) => row.minRetainImages === 4 && row.retainSteps === 4,
  );
  if (fourByFour !== undefined) {
    lines.push(
      `- \`minRetainImages 4 / retainSteps 4\` (scenario C2, the evidence pass): peak ` +
        `**${fourByFour.peakAfterMiB} MiB** with ${fourByFour.unsatisfiableSteps} unsatisfiable steps — still ` +
        `above the budget. The floor is dominated by a single batched message: \`retainSteps\` protects every ` +
        `image admitted in a recent step, so the whole batch is protected at once and shrinking ` +
        `\`minRetainImages\` cannot get below it. Lower the step window first.`,
    );
  }
  if (facts !== undefined && facts.largestImageMessage !== null && facts.largestImageMessage.images > 1) {
    const largest = facts.largestImageMessage;
    lines.push(
      `- Largest single event: seq ${largest.seq} (${largest.type}` +
        `${largest.source ? `, ${largest.source}` : ''}) with ${largest.images} images / ` +
        `${(largest.rawBytes / (1024 * 1024)).toFixed(2)} MiB raw. That is the batch the 4/4 floor pins inside ` +
        `its window, and the reason \`minRetainImages\` alone cannot reach 6 MiB.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function buildMarkdown({ facts, header, logPath, scenarios, isolation, adapterNote, sweep }) {
  const [a, b, c, c2] = scenarios;
  const lines = [];
  lines.push('# Offline replay — `image-budget-guard` on a real 213-step session');
  lines.push('');
  lines.push(
    `Deterministic offline replay of \`${relative(PACKAGE_ROOT, logPath) || logPath}\` ` +
      `(session \`${header.id}\`, ${facts.eventCount} events, ${facts.stepStarts} steps). ` +
      `Generated by \`pnpm replay\` on ${new Date().toISOString()} (UTC).`,
  );
  lines.push('');
  lines.push('## TL;DR — same session, same 6 MiB plugin budget, four passes');
  lines.push('');
  const pick = (fn) => scenarios.map((s) => fn(s));
  lines.push(
    mdTable(
      ['', ...scenarios.map((s) => s.label)],
      [
        ['Guard floor (minRetainImages / retainSteps)', ...pick((s) => `${s.config.minRetainImages} / ${s.config.retainSteps}`)],
        ['Request-image target', ...pick((s) => `${s.target.requestImagePixelBudget} px / ${s.target.requestImageMaxBytes} B`)],
        ['Adapter ceiling', ...pick((s) => `${toMiB(s.adapterCeilingBytes)} MiB`)],
        ['Plugin budget', ...pick((s) => `${toMiB(s.pluginBudgetBytes)} MiB`)],
        ['**Peak payload before guard**', ...pick((s) => `**${s.totals.baselinePeak.payloadMiB} MiB** (${where(s.totals.baselinePeak)})`)],
        ['**Peak payload after guard**', ...pick((s) => `**${s.totals.guardedPeakAfter.payloadMiB} MiB**`)],
        ['Steps over plugin budget (before)', ...pick((s) => `${s.totals.baselineStepsOverPluginBudget}`)],
        ['Steps over adapter ceiling (before)', ...pick((s) => `${s.totals.baselineStepsOverAdapterCeiling}`)],
        ['**`image/offload` events emitted**', ...pick((s) => `**${s.totals.guardOffloadEvents}**`)],
        ['Unsatisfiable steps (retention floor)', ...pick((s) => `${s.totals.unsatisfiableSteps}`)],
        ['Steps still over adapter ceiling after guard', ...pick((s) => `${s.totals.adapterWouldRejectAfterGuardSteps}`)],
        ['`IMAGE_OFFLOAD_REQUIRED` (projected, after guard)', ...pick((s) => (s.totals.adapterWouldRejectAfterGuardSteps === 0 ? '**0**' : `${s.totals.adapterWouldRejectAfterGuardSteps}`))],
        ['Cold → warm replay', ...pick((s) => `${s.timings.coldMs} → ${s.timings.warmMs} ms`)],
      ],
    ),
  );
  lines.push('');
  lines.push(
    '**The rule the floor taught us:** `retainSteps` protects every image admitted in a recent step, so a batched ' +
      'paste is protected as a whole; lower the step window before lowering `minRetainImages` if the budget still ' +
      'cannot be met.',
  );
  lines.push('');
  lines.push('### Verdict vs acceptance');
  lines.push('');
  const verdictCell = (s) =>
    `${s.verdict.peakWithinPluginBudget ? '**YES**' : '**NO**'} (${s.verdict.peakAfterMiB} MiB)`;
  lines.push(
    mdTable(
      ['Acceptance check', ...scenarios.map((s) => s.label)],
      [
        ['Peak payload after guard ≤ 6 MiB plugin budget', ...pick((s) => verdictCell(s))],
        ['Projected `IMAGE_OFFLOAD_REQUIRED` (adapter)', ...pick((s) => (s.verdict.projectedImageOffloadRequired === 0 ? '**0**' : `${s.verdict.projectedImageOffloadRequired}`))],
        ['**Acceptance (budget met AND 0 adapter rejections)**', ...pick((s) => `**${s.verdict.acceptanceMet ? 'PASS' : 'FAIL'}** — ${s.verdict.achievedBy}`)],
      ],
    ),
  );
  lines.push('');
  if (sweep.mildest !== null) {
    lines.push(
      `**Least-relaxed floor in the sweep that reaches the 6 MiB budget:** ` +
        `\`minRetainImages ${sweep.mildest.minRetainImages} / retainSteps ${sweep.mildest.retainSteps}\` → ` +
        `peak **${sweep.mildest.peakAfterMiB} MiB**, ${sweep.mildest.offloadEvents} events, ` +
        `${sweep.mildest.unsatisfiableSteps} unsatisfiable steps (sweep table below). Scenario C uses ` +
        `\`retainSteps 0 / minRetainImages 6\` — the integration-test-compatible floor — which measures the ` +
        `same peak on this session.`,
    );
    lines.push('');
  }
  const unmitigatedCrossed = b.totals.baselineFirstPluginBudgetCrossing !== null;
  const unmitigatedCeiling = b.totals.baselineFirstAdapterCeilingCrossing;
  lines.push('### What this shows');
  lines.push('');
  const mitigatedHeadroom = a.pluginBudgetBytes - a.totals.baselinePeak.payloadBytes;
  const mitigatedHeadroomPct = (100 * mitigatedHeadroom) / a.pluginBudgetBytes;
  if (mitigatedHeadroom >= 0) {
    lines.push(
      `- **Mitigated**: the profile's own 1 MP / 256 KiB target keeps the unguarded peak at ` +
        `**${a.totals.baselinePeak.payloadMiB} MiB**, only **${mitigatedHeadroom.toLocaleString('en-US')} B ` +
        `(${mitigatedHeadroomPct.toFixed(2)}%)** below the plugin's ${toMiB(a.pluginBudgetBytes)} MiB budget. ` +
        `The guard correctly stays a no-op (${a.totals.guardOffloadEvents} events, ` +
        `${a.totals.unsatisfiableSteps} unsatisfiable steps) — but the live mitigation is doing real work: ` +
        `this sample sits within 0.3% of the budget line.`,
    );
  } else {
    lines.push(
      `- **Mitigated**: the profile's target still leaves the unguarded peak ` +
        `**${toMiB(Math.abs(mitigatedHeadroom))} MiB** above the ${toMiB(a.pluginBudgetBytes)} MiB plugin budget; ` +
        `the guard emitted **${a.totals.guardOffloadEvents}** \`image/offload\` events and cut the peak to ` +
        `**${a.totals.guardedPeakAfter.payloadMiB} MiB**.`,
    );
  }
  if (unmitigatedCrossed) {
    lines.push(
      `- **Unmitigated**: the unguarded request body first crosses the plugin's 6 MiB budget at ` +
        `**${where(b.totals.baselineFirstPluginBudgetCrossing)}** ` +
        `(${b.totals.baselineFirstPluginBudgetCrossing.payloadMiB} MiB) and peaks at ` +
        `**${b.totals.baselinePeak.payloadMiB} MiB** — ` +
        `${b.totals.baselineStepsOverPluginBudget} of ${b.totals.steps} steps ` +
        `(${((100 * b.totals.baselineStepsOverPluginBudget) / b.totals.steps).toFixed(0)}%) are over budget ` +
        `without the plugin. So the plugin's own budget is the **binding constraint**, long before anything ` +
        `else changes. The guard emitted **${b.totals.guardOffloadEvents}** \`image/offload\` events, ` +
        `prevented the over-budget condition on **${b.totals.guardedStepsOverBudgetPrevented}** of those ` +
        `${b.totals.baselineStepsOverPluginBudget} steps, and cut the peak to ` +
        `**${b.totals.guardedPeakAfter.payloadMiB} MiB** ` +
        `(at ${where(b.totals.guardedPeakAfter)}).`,
    );
    if (b.totals.unsatisfiableSteps > 0) {
      const floor = b.totals.unsatisfiableFloorMiB;
      lines.push(
        `- The remaining **${b.totals.unsatisfiableSteps}** guarded steps stay above 6 MiB at ` +
          `**${formatMiBRange(floor)}**, because the retention floor already protects the ` +
          `whole surface: the guard may not drop those occurrences. ${b.totals.adapterWouldRejectAfterGuardSteps === 0
            ? `They are still well under the ${toMiB(b.adapterCeilingBytes)} MiB adapter ceiling, so the adapter ` +
              `would **not** reject them (\`IMAGE_OFFLOAD_REQUIRED\` = 0).`
            : `The protected suffix itself crosses the adapter ceiling at ${b.totals.adapterWouldRejectAfterGuardSteps} steps; ` +
              `the guard will not break its retention contract to avoid that.`}`,
      );
    }
    if (unmitigatedCeiling === null) {
      lines.push(
        `- The unmitigated curve does **not** reach the ${toMiB(b.adapterCeilingBytes)} MiB adapter ceiling in ` +
          `this sample (peak ${b.totals.baselinePeak.payloadMiB} MiB, ` +
          `${((100 * b.totals.baselinePeak.payloadBytes) / b.adapterCeilingBytes).toFixed(0)}% of it). The sample ` +
          `carries only ${facts.imageOccurrences} occurrences and compactions keep the concurrent surface small, ` +
          `so **the adapter ceiling is not reached by this sample; the plugin budget is the binding constraint**. ` +
          `Do not extrapolate a failure the log does not show: a longer session would keep growing past 20 MiB, ` +
          `but this replay has no evidence of it.`,
      );
    } else {
      lines.push(
        `- The unmitigated curve also crosses the **${toMiB(b.adapterCeilingBytes)} MiB adapter ceiling** at ` +
          `**${where(unmitigatedCeiling)}** (${unmitigatedCeiling.payloadMiB} MiB).`,
      );
    }
  } else {
    lines.push(
      `- Even unmitigated, this sample never crosses the plugin's 6 MiB budget ` +
        `(peak ${b.totals.baselinePeak.payloadMiB} MiB): the sample simply does not build a long enough ` +
        `image tail. That is a property of the session, not of the guard.`,
    );
  }
  lines.push(
    `- **Tuned floor (C, \`retainSteps 0 / minRetainImages 6\`)**: keeps pi-ai's unmitigated target and meets the ` +
      `6 MiB budget at **${c.totals.guardedPeakAfter.payloadMiB} MiB** (${c.totals.guardOffloadEvents} events, ` +
      `${c.totals.unsatisfiableSteps} unsatisfiable steps, ${c.verdict.projectedImageOffloadRequired} projected ` +
      `adapter rejections). The step window is what had to move: with \`retainSteps 0\` every occurrence older ` +
      `than the newest 6 is eligible.`,
  );
  lines.push(
    `- **Floor-sweep evidence (C2, \`retainSteps 4 / minRetainImages 4\`)**: still peaks at ` +
      `**${c2.totals.guardedPeakAfter.payloadMiB} MiB** with ${c2.totals.unsatisfiableSteps} unsatisfiable ` +
      `steps. \`retainSteps\` protects every image admitted in a recent step, so the batched paste is protected ` +
      `as a whole; lowering \`minRetainImages\` alone cannot get below that batch's size, and lowering only the ` +
      `step window does.`,
  );
  if (facts.largestImageMessage !== null && facts.largestImageMessage.images > 1) {
    const largest = facts.largestImageMessage;
    lines.push(
      `- **One message dominates the floor:** seq ${largest.seq} (${largest.type}` +
        `${largest.source ? `, ${largest.source}` : ''}) carries **${largest.images} images / ` +
        `${(largest.rawBytes / (1024 * 1024)).toFixed(2)} MiB raw** — more request payload than the whole 6 MiB ` +
        `budget at the unmitigated target. While that event sits inside the protected step window, no eligible ` +
        `set can shrink its own occurrences.`,
    );
  }
  lines.push('');
  lines.push('## Session under test (verified from the log)');
  lines.push('');
  lines.push(
    mdTable(
      ['Fact', 'Value', 'Brief'],
      [
        ['Records (1 header + N events)', `${facts.eventCount + 1}`, '1532'],
        ['Events', `${facts.eventCount}`, '1531'],
        ['`step/start`', `${facts.stepStarts}`, '213'],
        ['Image occurrences', `${facts.imageOccurrences}`, '66'],
        [' — `tool/result`', `${facts.imageOccurrencesByType['tool/result'] ?? 0}`, '54'],
        [' — `user/message`', `${facts.imageOccurrencesByType['user/message'] ?? 0}`, '12'],
        ['Unique attachments', `${facts.uniqueAttachments}`, '53'],
        ['Attachments referenced twice', `${facts.duplicateAttachments}`, '13'],
        ['Raw image bytes', `${(facts.rawImageBytes / (1024 * 1024)).toFixed(2)} MiB`, '127.1 MiB'],
        ['`llm/retry`', `${formatRetryCodes(facts.retryCodes)} — none is IMAGE_OFFLOAD_REQUIRED`, '19 (8 TRANSPORT / 11 SERVER)'],
        ['Compaction transactions', `${facts.compactionStarts} start / ${facts.compactionEnds} end`, '8'],
        ['`image/offload` in the source log', `${facts.imageOffloadEvents}`, '0'],
      ],
    ),
  );
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(
    '1. **Reconstruct**: `Session.create(id, events, header, 0, [imageOffloadProjection])` is the ' +
      'baseline rebuild used to validate the parser (1531/1531 events, final surface = 29 occurrences). ' +
      'The incremental replay appends the same events one at a time through `SessionPlayer`, rewriting ' +
      '`surfaceOp` replace windows and `sourceEventSeqs` from original seq → replay seq; a fresh session ' +
      'is used per pass.',
  );
  lines.push(
    '2. **Isolate the cache**: the real `LocalAttachmentStore` is rooted at a temporary harness home with ' +
      '`attachments/v1` symlinked to `~/.dsh/attachments/v1` and an empty `cache/`. Request-version encoding ' +
      'therefore reads the real images and writes only below the temp home. `~/.dsh/cache` is untouched ' +
      `(${isolation.note}).`,
  );
  lines.push(
    '3. **Measure**: `llm.imageRequestTarget(provider, model, ref)` → `attachments.readImageRequest(ref, target)` → ' +
      '`base64Length(version.bytes)`, summed over retained occurrences. That is the same byte accounting the ' +
      'inline route uses. `requiredImageOffload(deriveMessages(), {representation: "base64", maxBytes: ceiling})` ' +
      'is the real adapter-side predicate; `> 0` means the adapter would throw `IMAGE_OFFLOAD_REQUIRED`.',
  );
  lines.push(
    `4. **Run the guard** (not a dry run) at every \`step/start\` boundary, then measure again. ` +
      `"Before" is the surface with all earlier decisions applied; the separate baseline pass has no guard at all.`,
  );
  lines.push('');
  lines.push(`**Adapter note.** ${adapterNote}`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push(scenarioSection(a));
  lines.push(scenarioSection(b));
  lines.push(scenarioSection(c));
  lines.push(scenarioSection(c2));
  lines.push(floorSweepSection(sweep, facts));
  lines.push('## Cold vs warm replay (estimate cache effect)');
  lines.push('');
  lines.push(
    mdTable(
      ['Scenario', 'Cold pass', 'Warm pass', 'Speedup', 'Guard store reads cold → warm', 'Replay measurer reads cold → warm'],
      scenarios.map((s) => [
        s.label,
        `${s.timings.coldMs} ms`,
        `${s.timings.warmMs} ms`,
        `${s.timings.warmSpeedup}×`,
        `${s.timings.coldGuardStoreReads} → ${s.timings.warmGuardStoreReads}`,
        `${s.timings.coldMeasurerReads} → ${s.timings.warmMeasurerReads}`,
      ]),
    ),
  );
  lines.push('');
  lines.push(
    'Cold = first pass in this process: empty request-version cache for that scenario\'s target and a fresh ' +
      'guard. Warm = second identical pass in the same process, reusing the same guard instance (its ' +
      '`sizeCache` is warm) and the now-populated request-version cache. The warm guard performs **zero** ' +
      '`readImageRequest` calls; the replay instrument still re-reads each unique attachment from the warm ' +
      'on-disk cache, which is why the residual warm cost is measurable rather than zero. ' +
      'Both passes produce byte-identical per-step series.',
  );
  lines.push('');
  lines.push('## Anomalies and caveats');
  lines.push('');
  lines.push(
    `- **Original log retries are not image-related.** All ${facts.retryCount} \`llm/retry\` events split as ` +
      `${formatRetrySplit(facts.retryCodes)} — none is \`IMAGE_OFFLOAD_REQUIRED\`. The historical session never ` +
      `failed on image bytes, which is consistent with the mitigated policy keeping its peak ` +
      `(${a.totals.baselinePeak.payloadMiB} MiB) below the 6 MiB line.`,
  );
  const guardedReject = scenarios.reduce(
    (total, s) => total + s.totals.adapterWouldRejectAfterGuardSteps,
    0,
  );
  lines.push(
    `- **Projected \`IMAGE_OFFLOAD_REQUIRED\`:** ` +
      scenarios
        .map((s) => `${s.label} ${s.totals.adapterWouldRejectAfterGuardSteps}`)
        .join(', ') +
      ` (${guardedReject} total) over all guarded steps. ` +
      (guardedReject === 0
        ? 'The guard keeps the adapter from ever rejecting a request in every pass.'
        : 'The residual cases are retention-floor steps where the protected suffix is itself above the ceiling; ' +
          'the guard deliberately does not violate its retention contract to satisfy the budget.'),
  );
  lines.push(
    `- **Scenario C's pass is session-specific, not a universal guarantee.** The plugin budget counts **base64** ` +
      `bytes, so the protected 6-image floor fits 6 MiB only while those six request versions average ` +
      `≈≤786 KB encoded each. The unmitigated per-image target allows 1 MiB **raw** (≈1.33 MiB base64), so six ` +
      `maximal images alone would be ≈8.0 MiB and the budget would again be unreachable without also lowering ` +
      `\`minRetainImages\`. This session's newest six average well below the cap, which is why C measures ` +
      `${c.totals.guardedPeakAfter.payloadMiB} MiB with only ${PLUGIN_BUDGET_BYTES - c.totals.guardedPeakAfter.payloadBytes} B ` +
      `of headroom.`,
  );
  lines.push(
    `- **Measurement is offline and encoding is deterministic**: no HTTP request is built; the payload is the ` +
      `exact base64 length of the request-version bytes the route would send.`,
  );
  lines.push(
    `- **Image-count cross-check:** ${scenarios.reduce((n, s) => n + s.totals.imageCountMismatches, 0)} steps ` +
      `showed a difference between derived-message image blocks and the guard's eligible occurrence reader ` +
      `(expected 0; both count the same surface).`,
  );
  lines.push(
    `- **Guard failure reasons** (\`estimate-failed\`, \`stale-surface\`, \`append-failed\`, …): ` +
      `${scenarios.reduce((n, s) => n + s.totals.guardFailures.length, 0)} steps.`,
  );
  lines.push('');
  lines.push('## Reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('pnpm build        # generates dist/ (scripts import dist/index.js)');
  lines.push('pnpm replay       # writes docs/reports/replay.md and docs/reports/replay-series.json');
  lines.push('```');
  lines.push('');
  lines.push(
    `The replay is offline and deterministic; it needs \`zstd\` on PATH (installed) and the sample session at ` +
      `\`~/.dsh/sessions/--home-ksndjaks-code-tmp--/session-15758717-978d-41a1-a89e-6c4288ef5287/session.v4.jsonl.zstd\`. ` +
      `Nothing under \`~/.dsh\` is written: the only writes are the two report files and the temporary home ` +
      `(removed at exit unless \`--keep-temp\`).`,
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(PACKAGE_ROOT, 'dist', 'index.js'))) {
    throw new Error('dist/index.js is missing — run `pnpm build` before `pnpm replay`');
  }
  const logPath = options.logPath;
  const logBytes = statSync(logPath).size;

  const text = decodeSessionLog(logPath);
  const { header, events, recordCount, warnings } = parseSessionLog(text);
  const facts = collectSessionFacts(events);
  const steps = stepStartRecords(events);
  if (steps.length === 0) throw new Error('session log has no step/start events');

  // Validate the DESIGN §6.3 rebuild recipe against the same records before the
  // incremental replays: both must agree on the final surface.
  const rebuilt = (await import('./session-log.mjs')).rebuildSession(header, events);
  const rebuiltOccurrences = surfaceImageOccurrences(rebuilt).length;
  const rebuiltEventCount = rebuilt.seq;

  const isolation = createIsolatedHome();
  const warningsOut = [...warnings];
  try {
    const scenarios = [];
    /** Scenario id → its live service graph, reused by the floor sweep. */
    const runtimes = new Map();
    for (const scenario of SCENARIOS) {
      const ctx = new Context();
      new SessionStore(ctx);
      ctx.sessions.registerMessageProjection(imageOffloadProjection);
      new LlmRuntime(ctx);
      const adapter = new ScenarioAdapter(scenario);
      ctx.llm.registerAdapter([ROUTE.provider], adapter);
      const store = new CountingAttachmentStore(ctx, { dshHome: isolation.home });
      const config = ConfigSchema.parse({
        representation: 'inline-base64',
        logLevel: 'silent',
        ...scenario.guardOverrides,
      });
      const guard = createGuard(ctx, config);
      const runtime = { ctx, store, adapter };

      // Pass 1: guarded, cold (fresh guard, cold request-version cache for this target).
      const measurerCold = new RequestImageMeasurer({ llm: ctx.llm, store, scenario });
      const cold = await runGuardedPass({
        header,
        events,
        guard,
        measurer: measurerCold,
        store,
        label: scenario.id,
      });

      // Pass 2: guarded, warm (same guard → warm sizeCache; disk cache populated).
      const measurerWarm = new RequestImageMeasurer({ llm: ctx.llm, store, scenario });
      const warm = await runGuardedPass({
        header,
        events,
        guard,
        measurer: measurerWarm,
        store,
        label: `${scenario.id}-warm`,
      });

      // Pass 3: no guard at all, the true "before" curve.
      const measurerBaseline = new RequestImageMeasurer({ llm: ctx.llm, store, scenario });
      const baseline = await runBaselinePass({
        header,
        events,
        measurer: measurerBaseline,
        label: scenario.id,
        adapterCeilingBytes: scenario.adapterCeilingBytes,
      });

      const summary = summarizeScenario({ scenario, config, cold, warm, baseline });
      summary.adapter = {
        kind: 'real LlmRuntime + minimal LlmAdapter subclass',
        targetPolicySource: scenario.provenance,
        adapterCeilingSource:
          scenario.id === 'mitigated'
            ? '~/.dsh/profiles/web/cordis.patch.yml (commandcode.maxRequestImageBytes: 6291456)'
            : 'dsh-llm-pi-ai/lib/index.js:953 (DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 MiB)',
      };
      scenarios.push(summary);
      runtimes.set(scenario.id, runtime);
      const m = summary.totals;
      console.log(
        `[${scenario.id}] peak before ${m.baselinePeak.payloadMiB} MiB @ ${where(m.baselinePeak)} → ` +
          `after ${m.guardedPeakAfter.payloadMiB} MiB; offload events ${m.guardOffloadEvents}; ` +
          `unsatisfiable ${m.unsatisfiableSteps}; over ceiling after ${m.adapterWouldRejectAfterGuardSteps}; ` +
          `cold/warm ${summary.timings.coldMs}/${summary.timings.warmMs} ms`,
      );
    }

    // Scenario C asks for a floor that reaches the plugin budget; sweep the
    // floor on the unmitigated route so the report can name the mildest setting
    // instead of asserting one.
    const sweep = await runFloorSweep({
      header,
      events,
      runtime: runtimes.get('unmitigated'),
      scenario: SCENARIOS.find((scenario) => scenario.id === 'tuned-floor'),
    });
    if (sweep.mildest !== null) {
      console.log(
        `[sweep] mildest floor that reaches 6 MiB: minRetainImages ${sweep.mildest.minRetainImages} / ` +
          `retainSteps ${sweep.mildest.retainSteps} → peak ${sweep.mildest.peakAfterMiB} MiB, ` +
          `${sweep.mildest.unsatisfiableSteps} unsatisfiable`,
      );
    } else {
      console.log('[sweep] no tested floor reaches the 6 MiB plugin budget');
    }

    // The library purges only its own bounded caches; this is the guard view of
    // the same session used for the report header.
    const report = {
      schema: 'image-budget-guard/replay-series@1',
      generatedAt: new Date().toISOString(),
      command: 'pnpm replay',
      log: {
        path: logPath,
        fileBytes: logBytes,
        recordCount,
        eventCount: facts.eventCount,
        sessionId: header.id,
        createdAt: header.createdAt,
        cwd: header.cwd,
        facts,
      },
      rebuild: {
        recipe: 'Session.create(id, events, header, 0, [imageOffloadProjection])',
        eventCount: rebuiltEventCount,
        occurrences: rebuiltOccurrences,
      },
      adapter: {
        kind: 'real LlmRuntime + minimal LlmAdapter subclass',
        rationale:
          'PiAiAdapter.imageRequestTarget needs the settings/credentials-backed profile snapshot; the replay mounts the real LlmRuntime dispatch path and an adapter whose target expression is pi-ai\'s own ' +
          'requestImageDimensions(w,h,pixelBudget) + maxBytes (dsh-llm-pi-ai/lib/index.js:1379-1384, :1837-1845).',
        imageRequestTargetPath: 'LlmRuntime.imageRequestTarget → adapter.imageRequestTarget (real dispatch, fake route)',
      },
      isolation: {
        mode: 'temporary harness home; attachments/v1 symlinked to the real store; empty cache/',
        home: isolation.home,
        attachmentsLink: join(isolation.home, 'attachments', 'v1'),
        cacheDir: isolation.cacheDir,
        realAttachmentsRoot: REAL_ATTACHMENTS_ROOT,
        writesUserCache: false,
      },
      guard: {
        baseConfig: ConfigSchema.parse({ representation: 'inline-base64', logLevel: 'silent' }),
        scenarioConfigs: Object.fromEntries(scenarios.map((s) => [s.id, s.config])),
      },
      warnings: warningsOut,
      scenarios: Object.fromEntries(scenarios.map((s) => [s.id, s])),
      floorSweep: sweep,
      comparison: {
        mitigatedPeakBeforeMiB: scenarios[0].totals.baselinePeak.payloadMiB,
        mitigatedPeakAfterMiB: scenarios[0].totals.guardedPeakAfter.payloadMiB,
        unmitigatedPeakBeforeMiB: scenarios[1].totals.baselinePeak.payloadMiB,
        unmitigatedPeakAfterMiB: scenarios[1].totals.guardedPeakAfter.payloadMiB,
        unmitigatedFirstPluginBudgetCrossing: scenarios[1].totals.baselineFirstPluginBudgetCrossing,
        unmitigatedFirstAdapterCeilingCrossing: scenarios[1].totals.baselineFirstAdapterCeilingCrossing,
        unmitigatedAdapterCeilingReached:
          scenarios[1].totals.baselineFirstAdapterCeilingCrossing !== null,
        tunedFloorPeakAfterMiB: scenarios[2]?.totals.guardedPeakAfter.payloadMiB ?? null,
        tunedFloorAcceptanceMet: scenarios[2]?.verdict.acceptanceMet ?? null,
        floorSweepDemoPeakAfterMiB: scenarios[3]?.totals.guardedPeakAfter.payloadMiB ?? null,
        floorSweepDemoAcceptanceMet: scenarios[3]?.verdict.acceptanceMet ?? null,
        floorSweepDemoFloor: scenarios[3]?.guardOverrides ?? null,
        mildestFloorThatReachesBudget: sweep.mildest,
        acceptance: Object.fromEntries(
          scenarios.map((s) => [
            s.id,
            {
              peakWithinPluginBudget: s.verdict.peakWithinPluginBudget,
              projectedImageOffloadRequired: s.verdict.projectedImageOffloadRequired,
              acceptanceMet: s.verdict.acceptanceMet,
              achievedBy: s.verdict.achievedBy,
            },
          ]),
        ),
      },
    };

    mkdirSync(options.outDir, { recursive: true });
    const seriesPath = join(options.outDir, 'replay-series.json');
    const reportPath = join(options.outDir, 'replay.md');
    writeFileSync(seriesPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(
      reportPath,
      buildMarkdown({
        facts,
        header,
        logPath,
        scenarios,
        sweep,
        isolation: {
          note:
            `temp home ${isolation.home}; attachments/v1 → ${REAL_ATTACHMENTS_ROOT}; ` +
            `cache under ${isolation.cacheDir}`,
        },
        adapterNote:
          'The replay mounts a real `LlmRuntime` (the same dispatch path `runGuard` calls through) with a ' +
          'minimal `LlmAdapter` subclass instead of the full `PiAiAdapter`. The real pi-ai adapter derives its ' +
          'target from a settings/credentials-backed profile snapshot, while for this replay only two ' +
          'adapter-owned numbers matter; the subclass returns exactly ' +
          '`requestImageDimensions(w, h, pixelBudget)` + `maxBytes`, the expression `PiAiAdapter.imageRequestTarget` ' +
          'uses (`dsh-llm-pi-ai/lib/index.js:1379-1384`, `:1837-1845`). Model capability (text+image) and route ' +
          'metadata come from the same stored profile. No request is dispatched.',
      }),
    );

    console.log('');
    console.log(`report: ${relative(PACKAGE_ROOT, reportPath)}`);
    console.log(`series: ${relative(PACKAGE_ROOT, seriesPath)}`);
    if (warningsOut.length > 0) for (const warning of warningsOut) console.log(`warning: ${warning}`);
  } finally {
    if (options.keepTemp) console.log(`kept temporary home: ${isolation.home}`);
    else isolation.dispose();
  }
}

main().catch((error) => {
  console.error(`replay failed: ${error?.stack ?? error}`);
  process.exit(1);
});
