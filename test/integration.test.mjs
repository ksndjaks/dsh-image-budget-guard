/**
 * Integration test: the real pi-ai adapter against a local fake HTTP gateway,
 * with the image-budget guard deciding on a real `Session`/`SessionStore` and
 * a real `LocalAttachmentStore`.
 *
 * Scope note (supersedes the task-2 route config): the route under test uses
 * the pi-ai adapter's DEFAULT image policy — every image-policy key is omitted
 * from the provider profile, so the mounted adapter runs unmitigated:
 *
 *   maxRequestImageBytes    = 20 MiB  (dsh-llm-pi-ai/lib/index.js:953, :1131)
 *   requestImagePixelBudget = 4 MP    (dsh-llm-pi-ai/lib/index.js:954, :1132)
 *   requestImageMaxBytes    = 1 MiB   (dsh-llm-pi-ai/lib/index.js:955, :1133)
 *
 * The guard's own budget stays at the plugin default 6 MiB (`maxRequestImageBytes`
 * defaults to 6 * 1024 * 1024 in src/config.ts), i.e. the guard must act long
 * before the 20 MiB adapter ceiling would reject the request.
 *
 * Feasibility arithmetic behind the chosen image size (1280x800 noisy PNG):
 *   - the saved PNG is ~3.07 MB (> 1 MiB), so the adapter re-encodes it into a
 *     request version of ~730 KB, i.e. ~973 KB as inline base64;
 *   - 24 occurrences = ~23.3 MB base64 > 20,971,520 (20 MiB), so the unguarded
 *     request trips IMAGE_OFFLOAD_REQUIRED;
 *   - the newest 6 occurrences (the guard's `minRetainImages` floor) =
 *     ~5.84 MB < 6,291,456 (6 MiB), so the guard can satisfy its budget while
 *     retaining the newest six.
 * A 12-step `retainSteps` window (the plugin default) would protect twelve
 * ~973 KB occurrences (~11.7 MB) and make a 6 MiB budget mathematically
 * unsatisfiable, so this scenario pins `retainSteps: 0`: only the
 * `minRetainImages` floor protects occurrences, which is what the assertion
 * "the newest 6 attachments are still present as image data" verifies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';

import { ConfigSchema, base64Length, createGuard, surfaceImageOccurrences } from '../dist/index.js';
import {
  classifyImageHandles,
  firstOffloadIndex,
  imageDataUris,
  imagePayloadStats,
  startFakePiGateway,
} from './helpers/fake-pi-gateway.mjs';
import { encodeNoisePng } from './helpers/png-noise.mjs';

/** Occurrences accumulated by the scenario ("~24 image tool results"). */
const IMAGE_COUNT = 24;
/** Extra steps with no new image, used for the cross-step prefix comparison. */
const EXTRA_STEPS = 2;
/** Plugin default inline-base64 budget the guard enforces. */
const GUARD_BUDGET = 6 * 1024 * 1024; // 6,291,456
/** pi-ai DEFAULT_MAX_REQUEST_IMAGE_BYTES: the unmitigated adapter ceiling. */
const ADAPTER_CEILING = 20 * 1024 * 1024; // 20,971,520
/** Route image target under the adapter defaults. */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 800;

const PROVIDER = 'testroute';
const MODEL = 'test-model';

const isResponsePost = (request) => request.method === 'POST' && /\/responses\/?$/.test(request.url);
const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Drain one chunk stream and return its terminal finish chunk. */
async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { chunks, finish: chunks.find((chunk) => chunk.type === 'finish') };
}

/** First index at which two derived message arrays serialize differently. */
function firstDifferentMessage(before, after) {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) return index;
  }
  return -1;
}

test('image-budget guard keeps real pi-ai request bodies under 6 MiB while the unmitigated route fails', async (t) => {
  // pi-ai resolves apiKeyEnv through the launch environment, which falls back
  // to process.env when no launch-environment service is mounted.
  process.env.TEST_PI_KEY = 'sk-test';

  const gateway = await startFakePiGateway();
  const home = await mkdtemp(join(tmpdir(), 'ibg-integration-'));
  await mkdir(join(home, 'attachments', 'v1'), { recursive: true });
  t.after(async () => {
    await gateway.close();
    await rm(home, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Harness: real Context, real LlmRuntime, real SessionStore, real
  // LocalAttachmentStore (temp DSH_HOME), real PiAiAdapter.
  // ---------------------------------------------------------------------------
  const ctx = new Context();
  new LlmRuntime(ctx);
  new SessionStore(ctx);
  new LocalAttachmentStore(ctx, { dshHome: home });

  // Activation route: `ctx.plugin({...}, rawConfig)` — NOT a bare
  // `apply(ctx, config)`. pi-ai's exported `Config` is a schemastery schema;
  // cordis resolves the raw config through `Config["~standard"].validate()`
  // and hands `apply()` a value whose `providers` field is a schemastery
  // *volatile* (`apply()` reads `config.providers.get()` at
  // dsh-llm-pi-ai/lib/index.js:2867). A plain object fails with
  // "config.providers.get is not a function". Awaiting the returned fiber
  // settles the plugin load (including `ensureRegistrationFacts()`), which is
  // why the route assertions below run after the await.
  await ctx.plugin(
    { name: piAi.name, inject: piAi.inject, apply: piAi.apply, Config: piAi.Config },
    {
      providers: {
        [PROVIDER]: {
          api: 'openai-responses',
          baseURL: gateway.baseURL,
          apiKeyEnv: 'TEST_PI_KEY',
          // The three image-policy keys are deliberately omitted so the
          // adapter uses its defaults (20 MiB / 4 MP / 1 MiB per image).
          models: [{ id: MODEL, input: ['text', 'image'], contextWindow: 1_000_000, maxTokens: 384_000 }],
        },
      },
    },
  );

  assert.deepEqual(
    ctx.llm.listProviders().map((provider) => provider.id),
    [PROVIDER],
    'the awaited ctx.plugin() mount must register the pi-ai route',
  );
  const directoryEntry = ctx.llm.listConfigurableProviders().find((entry) => entry.provider === PROVIDER);
  assert.ok(directoryEntry !== undefined, 'the route must appear in the configurable-provider directory');
  // The guard's `representation: 'auto'` reads this namespace: /^llm-pi-ai/
  // resolves to inline-base64 (src/index.ts:197-212, src/config.ts:112-137).
  assert.match(
    directoryEntry.settingsNs,
    /^llm-pi-ai(?:-|$)/,
    'settingsNs must identify the pi-ai adapter so representation auto-detect picks inline-base64',
  );

  const store = ctx.get('attachments');
  assert.ok(store instanceof LocalAttachmentStore, 'LocalAttachmentStore must be mounted as ctx.attachments');

  // ---------------------------------------------------------------------------
  // Images: 24 distinct noisy PNGs saved through the store (content-addressed,
  // verified on every read). Each is large enough that the adapter's 1 MiB
  // per-image target forces the request re-encode path.
  // ---------------------------------------------------------------------------
  const saved = [];
  for (let index = 1; index <= IMAGE_COUNT; index += 1) {
    const data = encodeNoisePng({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT, seed: 0x9e37 + index * 7919 });
    const ref = await store.saveImage({
      data,
      mediaType: 'image/png',
      name: `shot-${String(index).padStart(2, '0')}.png`,
    });
    saved.push(ref);
  }

  const imageTarget = ctx.llm.imageRequestTarget(PROVIDER, MODEL, saved[0]);
  assert.equal(imageTarget.maxBytes, REQUEST_IMAGE_MAX_BYTES, 'route must run the default 1 MiB per-image target');
  assert.equal(imageTarget.width, IMAGE_WIDTH, '1280x800 fits inside the default 4 MP pixel budget unscaled');
  assert.equal(imageTarget.height, IMAGE_HEIGHT);

  const requestVersions = [];
  for (const ref of saved) {
    const target = ctx.llm.imageRequestTarget(PROVIDER, MODEL, ref);
    const version = await store.readImageRequest(ref, target);
    requestVersions.push({ ref, version, base64Bytes: base64Length(version.bytes) });
  }
  const totalImageBase64 = requestVersions.reduce((sum, entry) => sum + entry.base64Bytes, 0);
  for (const [index, entry] of requestVersions.entries()) {
    assert.ok(
      entry.ref.bytes > REQUEST_IMAGE_MAX_BYTES,
      `image ${index + 1} saved bytes (${entry.ref.bytes}) must exceed the 1 MiB per-image target to force re-encode`,
    );
    assert.ok(
      entry.version.bytes < entry.ref.bytes,
      `image ${index + 1} request version (${entry.version.bytes}) must be re-encoded smaller than the saved attachment`,
    );
    console.log(
      `[integration] image ${String(index + 1).padStart(2, '0')} ${entry.ref.name} saved=${entry.ref.bytes}B ` +
        `request=${entry.version.bytes}B base64=${entry.base64Bytes}B`,
    );
  }
  console.log(
    `[integration] unmitigated inline image payload = ${totalImageBase64}B base64 ` +
      `(${(totalImageBase64 / 1024 / 1024).toFixed(2)} MiB) across ${IMAGE_COUNT} occurrences`,
  );

  // The scenario arithmetic that the per-step expectations below rely on,
  // measured from the exact request versions rather than assumed:
  const prefixSum = (count) => requestVersions.slice(0, count).reduce((sum, entry) => sum + entry.base64Bytes, 0);
  assert.ok(prefixSum(6) <= GUARD_BUDGET, 'the first six occurrences must already fit the 6 MiB guard budget');
  assert.ok(prefixSum(7) > GUARD_BUDGET, 'the seventh occurrence must cross the 6 MiB guard budget');
  assert.ok(
    requestVersions.slice(-6).reduce((sum, entry) => sum + entry.base64Bytes, 0) <= GUARD_BUDGET,
    'the newest six retained occurrences (minRetainImages) must fit the 6 MiB guard budget',
  );

  // ---------------------------------------------------------------------------
  // The guarded session: each image is one tool result on its own step; the
  // guard runs before the request is assembled, exactly like `apply()` does on
  // `agent/request`, then the request is built from deriveMessages().
  // ---------------------------------------------------------------------------
  const guard = createGuard(
    ctx,
    ConfigSchema.parse({
      maxRequestImageBytes: GUARD_BUDGET,
      minRetainImages: 6,
      retainSteps: 0,
      quanta: 4,
      logLevel: 'silent',
    }),
  );

  const session = ctx.sessions.create('guarded-session');
  const preamble = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
  // Leading text messages make the "prefix before the first modified message"
  // non-empty in the prefix-stability assertions below.
  session.append('user/message', preamble('session preamble'), { surfaceOp: 'append' });
  session.append('user/message', preamble('workspace context: fake pi-ai gateway'), { surfaceOp: 'append' });

  const guardedSteps = [];
  let peakBodyBase64 = 0;
  let peakBodyStep = 0;

  for (let step = 1; step <= IMAGE_COUNT + EXTRA_STEPS; step += 1) {
    session.append('step/start', { turn: 1, step });
    if (step <= IMAGE_COUNT) {
      const ref = saved[step - 1];
      session.append(
        'tool/result',
        {
          turn: 1,
          step,
          message: createToolResultMessage({
            callId: ToolCallId(`call-${step}`),
            content: [
              { type: 'text', text: `tool output for screenshot ${step}` },
              { type: 'image', attachment: ref },
            ],
            isError: false,
          }),
        },
        { surfaceOp: 'append' },
      );
    }

    const before = session.deriveMessages();
    const decision = await guard.run(
      {
        agent: { session, options: { provider: PROVIDER, model: MODEL } },
        turn: 1,
        step,
        signal: new AbortController().signal,
      },
      { provider: PROVIDER, model: MODEL },
    );
    const after = session.deriveMessages();

    const postsBefore = gateway.requests.filter(isResponsePost).length;
    const { chunks, finish } = await collectStream(
      ctx.llm.stream({ provider: PROVIDER, model: MODEL, messages: after }),
    );
    const newPosts = gateway.requests.filter(isResponsePost).slice(postsBefore);
    assert.equal(newPosts.length, 1, `step ${step} must produce exactly one POST /v1/responses body`);
    const request = newPosts[0];
    assert.match(request.url, /^\/v1\/responses$/, 'the adapter must post to the route baseURL + /responses');

    // The minimal SSE above is fully valid: the adapter must complete with a
    // stop finish, never a terminal error chunk (and never IMAGE_OFFLOAD_REQUIRED).
    assert.equal(finish?.type, 'finish', `step ${step} stream must terminate with a finish chunk`);
    assert.equal(finish.reason.kind, 'stop', `step ${step} stream must complete (got ${finish.reason.kind})`);
    assert.notEqual(
      finish.reason.failure?.code,
      'IMAGE_OFFLOAD_REQUIRED',
      `step ${step} must not observe IMAGE_OFFLOAD_REQUIRED`,
    );
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'), `step ${step} stream must deliver model text`);

    // Assertion 1: every recorded HTTP body's inline base64 image payload is
    // within the guard's 6 MiB budget.
    const stats = imagePayloadStats(request.body);
    assert.ok(
      stats.base64Bytes <= GUARD_BUDGET,
      `step ${step} body carries ${stats.base64Bytes}B of base64 images (> ${GUARD_BUDGET})`,
    );

    // Cross-check the guard's estimate against the exact wire payload this
    // route's request versions produce: the body count and base64 total must
    // equal the derived surface's retained (non-offloaded) occurrences.
    const retainedOccurrences = surfaceImageOccurrences(session).filter((occurrence) => !occurrence.offloaded);
    let expectedBodyBase64 = 0;
    for (const occurrence of retainedOccurrences) {
      const target = ctx.llm.imageRequestTarget(PROVIDER, MODEL, occurrence.attachment);
      const version = await store.readImageRequest(occurrence.attachment, target);
      expectedBodyBase64 += base64Length(version.bytes);
    }
    assert.equal(stats.count, retainedOccurrences.length, `step ${step} body must inline every retained occurrence`);
    assert.equal(stats.base64Bytes, expectedBodyBase64, `step ${step} body base64 must match exact request versions`);

    if (decision.policy !== undefined) {
      assert.equal(
        decision.policy.representation,
        'inline-base64',
        'representation: auto must resolve the llm-pi-ai route to inline-base64',
      );
      assert.equal(decision.policy.maxBytes, GUARD_BUDGET);
    }

    if (step <= 6) {
      assert.equal(decision.action, 'noop', `step ${step} is still within budget`);
      assert.equal(decision.reason, 'within-budget');
    } else if (step <= IMAGE_COUNT) {
      assert.equal(decision.action, 'offloaded', `step ${step} must offload the oldest retained occurrence`);
      assert.equal(decision.reason, 'selected');
      assert.equal(decision.selected?.length, 1, `step ${step} must select exactly one message`);
      assert.deepEqual(decision.selected[0].imageIndexes, [0]);
      assert.ok(
        decision.plan.payloadAfterBytes <= GUARD_BUDGET,
        `step ${step} decision must restore the budget (${decision.plan.payloadAfterBytes} > ${GUARD_BUDGET})`,
      );
      assert.equal(decision.plan.payloadAfterBytes, stats.base64Bytes, `step ${step} guard estimate must equal the wire`);
    } else {
      assert.equal(decision.action, 'noop', `step ${step} adds no image, so nothing may be offloaded`);
      assert.equal(decision.reason, 'within-budget');
    }

    if (stats.base64Bytes > peakBodyBase64) {
      peakBodyBase64 = stats.base64Bytes;
      peakBodyStep = step;
    }
    console.log(
      `[integration] guarded step=${String(step).padStart(2, '0')} decision=${decision.action}/${decision.reason} ` +
        `removed=${decision.plan?.removedCount ?? 0} retained=${decision.plan?.retainedAfter ?? stats.count} ` +
        `bodyImages=${stats.count} bodyBase64=${stats.base64Bytes}B`,
    );

    session.append('step/end', { turn: 1, step });
    guardedSteps.push({ step, decision, before, after, request, stats, finish });
  }

  const finalStep = guardedSteps.at(-1);
  assert.ok(finalStep !== undefined);
  const finalBody = finalStep.request.body;
  const finalStats = imagePayloadStats(finalBody);

  // ---------------------------------------------------------------------------
  // Assertion 3: the newest minRetainImages (6) occurrences are still present
  // as image data in the final request; every older occurrence is a placeholder.
  // ---------------------------------------------------------------------------
  const { retained, offloaded } = classifyImageHandles(finalBody);
  const newestNames = saved.slice(-6).map((ref) => ref.name);
  const olderNames = saved.slice(0, -6).map((ref) => ref.name);
  for (const name of newestNames) {
    assert.ok(retained.has(name), `newest attachment ${name} must still be image data in the final request`);
    assert.ok(!offloaded.has(name), `newest attachment ${name} must not be a placeholder`);
  }
  for (const name of olderNames) {
    assert.ok(offloaded.has(name), `older attachment ${name} must be an offload placeholder in the final request`);
    assert.ok(!retained.has(name), `older attachment ${name} must not still be image data`);
  }
  assert.equal(retained.size, 6, 'exactly minRetainImages occurrences stay retained');
  assert.equal(offloaded.size, IMAGE_COUNT - 6, 'every older occurrence is projected to a placeholder');
  assert.equal(finalStats.count, 6, 'the final request must inline exactly the 6 retained images');
  assert.equal(finalStats.base64Bytes, requestVersions.slice(-6).reduce((sum, entry) => sum + entry.base64Bytes, 0));
  console.log(
    `[integration] newest-6 retained: ${newestNames.join(', ')}; ` +
      `${olderNames.length} older occurrences are placeholders`,
  );

  // ---------------------------------------------------------------------------
  // Assertion 4a (invariant 5, within one decision): the derived-message prefix
  // before the first *modified* message is byte-identical before and after the
  // guard appends its durable image/offload decision.
  // ---------------------------------------------------------------------------
  const decisionStep = guardedSteps.find((entry) => entry.step === IMAGE_COUNT);
  assert.ok(decisionStep !== undefined, 'step 24 must exist');
  const firstChanged = firstDifferentMessage(decisionStep.before, decisionStep.after);
  assert.ok(firstChanged > 0, `step 24 must modify a message after a non-empty prefix (got index ${firstChanged})`);
  assert.equal(
    sha256(decisionStep.before.slice(0, firstChanged)),
    sha256(decisionStep.after.slice(0, firstChanged)),
    'serialized messages before the first modified node must be byte-identical before/after the decision',
  );
  // The first modified node is the oldest retained occurrence (image 18), and
  // every node before it (preambles + 17 already-offloaded tool results) is stable.
  assert.match(
    JSON.stringify(decisionStep.after[firstChanged]),
    /"offloaded":true/,
    'the first modified message must be the occurrence the decision marked offloaded',
  );
  assert.match(JSON.stringify(decisionStep.after[firstChanged]), /shot-18\.png/);
  console.log(
    `[integration] prefix-stability step=${IMAGE_COUNT} firstChangedIndex=${firstChanged} ` +
      `prefixMessages=${firstChanged} prefixHash=${sha256(decisionStep.before.slice(0, firstChanged))}`,
  );

  // ---------------------------------------------------------------------------
  // Assertion 4b (cross-step cache stability): two consecutive steps with no
  // new image between them (steps 25/26) render the same request prefix up to
  // the first offload placeholder — here the whole derived history is unchanged,
  // so this is the strongest form of the same claim.
  // ---------------------------------------------------------------------------
  const quietSteps = guardedSteps.slice(IMAGE_COUNT);
  assert.equal(quietSteps.length, EXTRA_STEPS);
  const [firstQuiet, secondQuiet] = quietSteps;
  assert.deepEqual(
    firstQuiet.request.body.input,
    secondQuiet.request.body.input,
    'consecutive no-new-image steps must serialize identical model input',
  );
  const prefixIndex = firstOffloadIndex(secondQuiet.request.body);
  assert.ok(prefixIndex >= 1, `the body must have a non-empty prefix before the first placeholder (got ${prefixIndex})`);
  const quietPrefixHash = sha256(secondQuiet.request.body.input.slice(0, prefixIndex));
  assert.equal(
    sha256(firstQuiet.request.body.input.slice(0, prefixIndex)),
    quietPrefixHash,
    'the request prefix up to the first offload placeholder must be byte-identical across quiet steps',
  );
  assert.match(firstQuiet.after[0].content[0].text, /session preamble/);
  console.log(
    `[integration] prefix-stability steps=${firstQuiet.step}->${secondQuiet.step} ` +
      `prefixEntries=${prefixIndex} prefixHash=${quietPrefixHash} fullInputEqual=true`,
  );

  // ---------------------------------------------------------------------------
  // Diagnostic (not the failing control): an unguarded surface that is still
  // *below* the 20 MiB adapter ceiling DOES reach the wire, so its size can be
  // measured directly. Twenty ~973 KB occurrences produce a ~19.5 MB request
  // body — already 3x the guard's 6 MiB budget — and the adapter accepts it.
  // This is the concrete "without the guard" body measurement; the 24-image
  // control below is the one that is refused before serialization.
  // ---------------------------------------------------------------------------
  const twentyImageSession = ctx.sessions.create('unguarded-body-session');
  twentyImageSession.append('user/message', preamble('session preamble'), { surfaceOp: 'append' });
  twentyImageSession.append('user/message', preamble('workspace context: fake pi-ai gateway'), { surfaceOp: 'append' });
  for (let step = 1; step <= 20; step += 1) {
    twentyImageSession.append('step/start', { turn: 1, step });
    twentyImageSession.append(
      'tool/result',
      {
        turn: 1,
        step,
        message: createToolResultMessage({
          callId: ToolCallId(`unguarded-call-${step}`),
          content: [
            { type: 'text', text: `tool output for screenshot ${step}` },
            { type: 'image', attachment: saved[step - 1] },
          ],
          isError: false,
        }),
      },
      { surfaceOp: 'append' },
    );
    twentyImageSession.append('step/end', { turn: 1, step });
  }
  const unguardedPostsBefore = gateway.requests.filter(isResponsePost).length;
  const unguarded = await collectStream(
    ctx.llm.stream({ provider: PROVIDER, model: MODEL, messages: twentyImageSession.deriveMessages() }),
  );
  const unguardedPosts = gateway.requests.filter(isResponsePost).slice(unguardedPostsBefore);
  assert.equal(unguardedPosts.length, 1, 'the 20-image unguarded request must reach the wire');
  assert.equal(unguarded.finish?.reason.kind, 'stop', 'the 20-image unguarded request is below the adapter ceiling');
  const unguardedBodyStats = imagePayloadStats(unguardedPosts[0].body);
  assert.equal(
    unguardedBodyStats.base64Bytes,
    requestVersions.slice(0, 20).reduce((sum, entry) => sum + entry.base64Bytes, 0),
    'the unguarded wire body must carry exactly the 20 request versions',
  );
  assert.ok(unguardedBodyStats.base64Bytes > GUARD_BUDGET, 'the unguarded body must exceed the guard budget');
  assert.ok(unguardedBodyStats.base64Bytes <= ADAPTER_CEILING, 'the unguarded body must stay under the adapter ceiling');
  console.log(
    `[integration] control (no guard, below ceiling): recordedBodyBase64=${unguardedBodyStats.base64Bytes}B ` +
      `(${(unguardedBodyStats.base64Bytes / 1024 / 1024).toFixed(2)} MiB) images=${unguardedBodyStats.count}`,
  );

  // ---------------------------------------------------------------------------
  // Assertion 5 (control): the SAME scenario WITHOUT the guard trips the
  // unmitigated 20 MiB adapter ceiling with IMAGE_OFFLOAD_REQUIRED. The live
  // guarded session cannot be rewound (image/offload events are append-only),
  // so the control is a twin session built from the identical attachment refs
  // and the identical pre-guard event sequence; its derived messages are the
  // same surface the guard decided on at step 24/26.
  // ---------------------------------------------------------------------------
  const controlSession = ctx.sessions.create('control-session');
  controlSession.append('user/message', preamble('session preamble'), { surfaceOp: 'append' });
  controlSession.append('user/message', preamble('workspace context: fake pi-ai gateway'), { surfaceOp: 'append' });
  for (let step = 1; step <= IMAGE_COUNT; step += 1) {
    controlSession.append('step/start', { turn: 1, step });
    controlSession.append(
      'tool/result',
      {
        turn: 1,
        step,
        message: createToolResultMessage({
          callId: ToolCallId(`control-call-${step}`),
          content: [
            { type: 'text', text: `tool output for screenshot ${step}` },
            { type: 'image', attachment: saved[step - 1] },
          ],
          isError: false,
        }),
      },
      { surfaceOp: 'append' },
    );
    controlSession.append('step/end', { turn: 1, step });
  }

  const controlPostsBefore = gateway.requests.filter(isResponsePost).length;
  const control = await collectStream(
    ctx.llm.stream({ provider: PROVIDER, model: MODEL, messages: controlSession.deriveMessages() }),
  );
  const controlPosts = gateway.requests.filter(isResponsePost).length - controlPostsBefore;
  assert.equal(
    controlPosts,
    0,
    'the unguarded adapter must refuse before serializing an over-ceiling image payload (no HTTP body is recorded)',
  );
  assert.equal(control.finish?.reason.kind, 'error', 'the unguarded request must fail terminally');
  assert.equal(control.finish.reason.failure.code, 'IMAGE_OFFLOAD_REQUIRED');
  // The normalized failure keeps the `offloadImages` count (dsh-llm
  // failureSnapshot validates and preserves it), which is exactly what
  // compaction-image-offload consumes from `agent/request-error`.
  assert.ok(
    control.finish.reason.failure.offloadImages >= 1,
    'the failure must name how many oldest images to offload',
  );
  assert.match(control.finish.reason.failure.message, /base64 bound/);

  // Prove the failure was produced by the DEFAULT 20 MiB ceiling, not by some
  // smaller policy: recompute the adapter's exact `requiredImageOffload()`
  // prefix count over the recorded request-version byte lengths.
  assert.ok(
    totalImageBase64 > ADAPTER_CEILING,
    `the unguarded payload (${totalImageBase64}B) must exceed the 20 MiB adapter ceiling (${ADAPTER_CEILING}B)`,
  );
  assert.ok(totalImageBase64 > GUARD_BUDGET, 'the unguarded payload must also exceed the guard budget');
  const excess = totalImageBase64 - ADAPTER_CEILING;
  let removedBytes = 0;
  let expectedOffload = 0;
  while (expectedOffload < requestVersions.length && removedBytes < excess) {
    removedBytes += requestVersions[expectedOffload].base64Bytes;
    expectedOffload += 1;
  }
  assert.equal(
    control.finish.reason.failure.offloadImages,
    expectedOffload,
    'offloadImages must equal the prefix count for the 20 MiB default ceiling',
  );
  console.log(
    `[integration] control (no guard): IMAGE_OFFLOAD_REQUIRED offloadImages=${control.finish.reason.failure.offloadImages} ` +
      `unguardedPayload=${totalImageBase64}B ceiling=${ADAPTER_CEILING}B recordedBodies=0`,
  );

  // ---------------------------------------------------------------------------
  // Summary numbers (also asserted above).
  // ---------------------------------------------------------------------------
  assert.ok(peakBodyBase64 <= GUARD_BUDGET);
  console.log(
    `[integration] summary: guarded peakBodyBase64=${peakBodyBase64}B at step=${peakBodyStep} (budget ${GUARD_BUDGET}B); ` +
      `unguardedRecordedBodyBase64=${unguardedBodyStats.base64Bytes}B; ` +
      `unmitigatedPayload=${totalImageBase64}B (adapter ceiling ${ADAPTER_CEILING}B); ` +
      `offloadEvents=${guardedSteps.filter((entry) => entry.decision.action === 'offloaded').length}; ` +
      `imageOffloadRequiredObserved=${guardedSteps.filter((entry) => entry.finish?.reason?.failure?.code === 'IMAGE_OFFLOAD_REQUIRED').length}`,
  );
  assert.equal(imageDataUris(finalBody).length, 6, 'the final body must inline exactly six images');
});
