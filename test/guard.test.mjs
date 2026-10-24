/**
 * Guard decision tests against a real Cordis `Context`, a real `SessionStore`,
 * the real `image/offload` projection, a real `LlmRuntime` with a fake
 * `LlmAdapter`, and a fake `AttachmentStore` service.
 *
 * Why the real `LlmRuntime`: the guard's contract includes two adapter-owned
 * facts that a hand-written stand-in would fake away —
 * `resolveModelInfo().inputModalities` (image capability) and
 * `imageRequestTarget()` (the exact request version of one occurrence). A fake
 * `LlmAdapter` subclass therefore supplies `stream`, `resolveModel`, and
 * `imageRequestTarget`, and the runtime performs its own validation of the
 * returned metadata, exactly as it does in production.
 *
 * Why a real `AttachmentStore` subclass: `ctx.get('attachments')` returns the
 * service proxy, so registering a subclass of the real abstract service is the
 * same seam the production plugin mounts (`new FakeAttachments(ctx,
 * 'attachments')` → `Service` registers the name on that context). Only
 * `readImageRequest()` is exercised; every other abstract member throws, so an
 * unexpected call fails the test instead of silently returning a fake value.
 *
 * Run: `node --test test/guard.test.mjs` (from the package root, after `pnpm build`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { SessionStore, Session, SessionId } from '@deepseek-ai/dsh-session';
import {
  LlmRuntime,
  LlmAdapter,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection';

import {
  ConfigSchema,
  apply,
  createGuard,
  ensureImageOffloadProjection,
  hasImageOffloadProjection,
  recentStepBoundary,
  surfaceImageOccurrences,
} from '../dist/index.js';

/** The one provider route every test registers. */
const PROVIDER = 'test-provider';
/** The one model every test resolves. */
const MODEL = 'test-model';
/** Always-valid resolved call config for the fake route. */
const RESOLVED = { provider: PROVIDER, model: MODEL };

/** One image reference with a fixed intrinsic size; `bytes` is the raw size. */
function image(attachmentId) {
  return { attachmentId, mediaType: 'image/png', bytes: 300, width: 640, height: 480 };
}

/**
 * Build one isolated world.
 *
 * @param {{
 *   modalities?: readonly string[] | 'absent' | null,
 *   configurable?: readonly object[],
 *   requestBytes?: number | Record<string, number>,
 *   readThrows?: boolean,
 *   registerProjection?: boolean,
 *   mountAttachments?: boolean,
 *   resolveThrows?: boolean,
 *   targetThrows?: boolean,
 * }} [options]
 */
function makeWorld(options = {}) {
  const {
    modalities = ['text', 'image'],
    configurable = [],
    requestBytes = 300,
    readThrows = false,
    registerProjection = true,
    mountAttachments = true,
    resolveThrows = false,
    targetThrows = false,
  } = options;

  const ctx = new Context();
  new SessionStore(ctx);

  const llm = new LlmRuntime(ctx);
  class FakeAdapter extends LlmAdapter {
    async *stream() {
      // Never dispatched by the guard; present because it is the one required member.
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    async resolveModel(provider, model) {
      if (resolveThrows) throw new Error('adapter resolveModel failed');
      return {
        provider,
        id: model,
        name: model,
        ...(modalities === 'absent' || modalities === null ? {} : { inputModalities: modalities }),
      };
    }
    imageRequestTarget(provider, model, attachment) {
      if (targetThrows) throw new Error('adapter imageRequestTarget failed');
      return { width: attachment.width, height: attachment.height, maxBytes: 262_144 };
    }
  }
  llm.registerAdapter([PROVIDER], new FakeAdapter());
  if (configurable.length > 0) llm.registerConfigurableProviders(configurable);

  let requestCalls = 0;
  if (mountAttachments) {
    class FakeAttachments extends AttachmentStore {
      get imageLimits() {
        return {
          maxImageBytes: 10 * 1024 * 1024,
          maxImagesPerMessage: 20,
          maxMessageImageBytes: 20 * 1024 * 1024,
          maxImagePixels: 4096 * 4096,
          maxImageDimension: 4096,
          mediaTypes: ['image/png'],
        };
      }
      async readImageRequest(ref) {
        requestCalls += 1;
        if (readThrows) throw new Error('attachment bytes are unreadable');
        const bytes = typeof requestBytes === 'number' ? requestBytes : (requestBytes[ref.attachmentId] ?? 300);
        return { bytes, data: new Uint8Array(0) };
      }
      async validateImage() {
        throw new Error('FakeAttachments.validateImage must not be called');
      }
      async saveImage() {
        throw new Error('FakeAttachments.saveImage must not be called');
      }
      async readImage() {
        throw new Error('FakeAttachments.readImage must not be called');
      }
    }
    new FakeAttachments(ctx, 'attachments');
  }

  if (registerProjection) ctx.sessions.registerMessageProjection(imageOffloadProjection);

  return {
    ctx,
    llm,
    /** How many times the guard asked the store for request bytes. */
    get requestCalls() {
      return requestCalls;
    },
  };
}

/** Guard hook facts for one session. */
function factsFor(session, overrides = {}) {
  return {
    agent: { session, options: {} },
    turn: 9,
    step: 9,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Append one closed step carrying one user/message with the given content. */
function appendUserStep(session, step, content) {
  session.append('step/start', { turn: 1, step });
  const event = session.append(
    'user/message',
    createUserMessage({ content, source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  );
  session.append('step/end', { turn: 1, step });
  return event.seq;
}

/** A single-image user message step. */
function appendImageStep(session, step, attachmentId, extraBlocks = []) {
  return appendUserStep(session, step, [
    ...extraBlocks,
    { type: 'image', attachment: image(attachmentId) },
  ]);
}

/** Flat `seq:imageIndex` strings of one decision's targets. */
function positions(targets = []) {
  return targets.flatMap((target) => target.imageIndexes.map((index) => `${target.seq}:${index}`));
}

/** All `image/offload` events currently in a session log. */
function offloadEvents(session) {
  return session.snapshotEvents().filter((event) => event.type === 'image/offload');
}

/**
 * Capture the guard's own structured JSON log records.
 *
 * The exporter must opt into every severity: an exporter without `levels` only
 * receives `error` and `info` records from cordis, so `warn`/`debug` records
 * would silently disappear from the capture.
 */
function captureLogs(ctx) {
  const records = [];
  ctx.logger.exporter({
    levels: { default: 4 },
    export(message) {
      const first = message.args?.[0];
      if (typeof first !== 'string' || !first.startsWith('[image-budget-guard] ')) return;
      try {
        records.push(JSON.parse(first.slice('[image-budget-guard] '.length)));
      } catch {
        records.push({ event: 'unparsed', raw: first });
      }
    },
  });
  return records;
}

test('projection: registered lazily on first decision, then reused', async () => {
  const { ctx } = makeWorld({ registerProjection: false });
  const session = ctx.sessions.create('lazy');
  appendImageStep(session, 1, 'att-1');

  assert.equal(hasImageOffloadProjection(ctx), false, 'nothing is registered before the first decision');
  assert.equal(ctx.sessions.messageProjections.length, 0);

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'offloaded');
  assert.equal(hasImageOffloadProjection(ctx), true);
  assert.deepEqual(
    ctx.sessions.messageProjections.map((projection) => projection.type),
    ['image/offload'],
    'exactly one interpreter exists after the first decision',
  );
  assert.equal(ensureImageOffloadProjection(ctx), 'reused', 'a second call reuses the registration');
});

test('projection: an already-mounted offload plugin wins (reused, no duplicate registration)', async () => {
  const { ctx } = makeWorld({ registerProjection: true });
  const session = ctx.sessions.create('mounted');
  appendImageStep(session, 1, 'att-1');

  assert.equal(ensureImageOffloadProjection(ctx), 'reused');
  assert.equal(ctx.sessions.messageProjections.length, 1);

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);
  assert.equal(decision.action, 'offloaded', 'the guard still writes a decision through the mounted projection');
  assert.equal(ctx.sessions.messageProjections.length, 1, 'no second registration was attempted');

  // The store itself rejects duplicates; the guard must never trigger that.
  assert.throws(
    () => ctx.sessions.registerMessageProjection(imageOffloadProjection),
    /already registered/,
  );
});

test('offload: one event, selected targets, and offloaded placeholders in the derived history', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('happy');
  const firstSeq = appendImageStep(session, 1, 'att-1');
  const secondSeq = appendImageStep(session, 2, 'att-2');
  const thirdSeq = appendImageStep(session, 3, 'att-3');
  const fourthSeq = appendImageStep(session, 4, 'att-4');
  const before = session.deriveMessages();

  // 4 × 400 B = 1600 B represented; keep the newest 1, budget 800 B.
  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 800, minRetainImages: 1, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'offloaded');
  assert.equal(decision.reason, 'selected');
  assert.equal(decision.provider, PROVIDER);
  assert.equal(decision.model, MODEL);
  assert.equal(decision.eventSeq, session.seq - 1, 'eventSeq names the appended event');
  assert.equal(decision.plan.payloadBytes, 1600);
  assert.equal(decision.plan.payloadAfterBytes, 800);
  assert.equal(decision.plan.removedCount, 2);
  assert.equal(decision.plan.retainedAfter, 2);
  assert.equal(decision.plan.budgetSatisfied, true);
  assert.deepEqual(positions(decision.selected), [`${firstSeq}:0`, `${secondSeq}:0`]);
  assert.deepEqual(positions(decision.plan.targets), positions(decision.selected));

  const events = offloadEvents(session);
  assert.equal(events.length, 1, 'exactly one durable event is written');
  assert.deepEqual(events[0].data.targets, decision.selected, 'the log records the decision verbatim');

  const after = session.deriveMessages();
  assert.deepEqual(
    after.map((message) => message.id),
    before.map((message) => message.id),
    'message identity is preserved; only the projection changes',
  );
  const imageState = after.map((message) =>
    message.content
      .filter((block) => block.type === 'image')
      .map((block) => `${block.attachment.attachmentId}${block.offloaded === true ? '*' : ''}`),
  );
  assert.deepEqual(imageState, [['att-1*'], ['att-2*'], ['att-3'], ['att-4']]);

  // Retention: the newest occurrence keeps its bytes, so the suffix is untouched.
  assert.equal(JSON.stringify(after[2]), JSON.stringify(before[2]), 'att-3 is protected by minRetainImages');
  assert.equal(JSON.stringify(after[3]), JSON.stringify(before[3]), 'att-4 is protected by minRetainImages');
  assert.ok(thirdSeq > secondSeq, 'request order follows the append order');
  assert.ok(fourthSeq > thirdSeq);
});

test('prefix stability: JSON before the first modified message is byte-identical', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('prefix');
  // A leading system prompt and a text-only user message precede every image
  // node, so they must survive the decision byte-for-byte (DESIGN §5.5).
  session.append(
    'system/message',
    { turn: 1, step: 1, message: createSystemMessage('you are a careful reviewer') },
    { surfaceOp: 'append' },
  );
  appendUserStep(session, 1, [{ type: 'text', text: 'only text, never selected' }]);
  for (let step = 2; step <= 5; step += 1) appendImageStep(session, step, `att-${step}`);

  const nodes = [...session.surface.nodes];
  assert.equal(nodes.length, 6, 'system + text + four image messages');
  const before = session.deriveMessages();
  const beforeJson = before.map((message) => JSON.stringify(message));

  // 4 × 400 B represented; keep the newest 2, so the two oldest image messages
  // (surface positions 2 and 3) are selected and the last two stay untouched.
  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 800, minRetainImages: 2, retainSteps: 0, quanta: 2 }));
  const decision = await guard.run(factsFor(session), RESOLVED);
  assert.deepEqual(positions(decision.selected), [`${nodes[2]}:0`, `${nodes[3]}:0`]);

  const after = session.deriveMessages();
  assert.equal(after.length, before.length, 'the surface membership did not change');

  // Unmodified prefix: everything before the first selected node.
  const firstModified = after.findIndex((message, index) => JSON.stringify(message) !== beforeJson[index]);
  assert.equal(firstModified, 2, 'the first modified message is the first image message');
  for (let index = 0; index < firstModified; index += 1) {
    assert.equal(JSON.stringify(after[index]), beforeJson[index], `message ${index} is byte-identical`);
  }

  // Unmodified suffix: retention keeps the newest two untouched.
  assert.equal(JSON.stringify(after[4]), beforeJson[4]);
  assert.equal(JSON.stringify(after[5]), beforeJson[5]);

  // Identity is stable everywhere, including modified messages.
  assert.deepEqual(after.map((message) => message.id), before.map((message) => message.id));
});

test('idempotency: a second pass appends nothing', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('idem');
  for (let step = 1; step <= 4; step += 1) appendImageStep(session, step, `att-${step}`);

  const config = ConfigSchema.parse({ maxRequestImageBytes: 800, minRetainImages: 1, retainSteps: 0, quanta: 1 });
  const guard = createGuard(ctx, config);

  const first = await guard.run(factsFor(session), RESOLVED);
  assert.equal(first.action, 'offloaded');
  const seqAfterFirst = session.seq;
  const derivedAfterFirst = JSON.stringify(session.deriveMessages());

  const second = await guard.run(factsFor(session), RESOLVED);
  assert.equal(second.action, 'noop');
  assert.equal(second.reason, 'within-budget');
  assert.equal(session.seq, seqAfterFirst, 'the log did not grow');
  assert.equal(offloadEvents(session).length, 1, 'still exactly one decision');
  assert.equal(JSON.stringify(session.deriveMessages()), derivedAfterFirst, 'the derived history did not change');
});

test('idempotency: a second pass reports no-candidates when retention makes the budget unreachable', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('idem-nocand');
  for (let step = 1; step <= 4; step += 1) appendImageStep(session, step, `att-${step}`);

  // Keep the newest 1 but demand a 1-byte budget: the guard cannot satisfy it.
  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 1, retainSteps: 0, quanta: 1 }));
  const first = await guard.run(factsFor(session), RESOLVED);
  assert.equal(first.action, 'offloaded');
  assert.equal(first.reason, 'exhausted-candidates');
  assert.equal(first.plan.budgetSatisfied, false);

  const seqAfterFirst = session.seq;
  const second = await guard.run(factsFor(session), RESOLVED);
  assert.equal(second.action, 'noop');
  assert.equal(second.reason, 'no-candidates');
  assert.equal(second.plan.budgetSatisfied, false);
  assert.equal(session.seq, seqAfterFirst);
  assert.equal(offloadEvents(session).length, 1);
});

test('dryRun: writes nothing, reports would-offload and every selected position', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('dry');
  const firstSeq = appendImageStep(session, 1, 'att-1');
  appendImageStep(session, 2, 'att-2');
  const derivedBefore = JSON.stringify(session.deriveMessages());
  const seqBefore = session.seq;
  const logs = captureLogs(ctx);

  const guard = createGuard(
    ctx,
    ConfigSchema.parse({ dryRun: true, maxRequestImageBytes: 400, minRetainImages: 1, retainSteps: 0, quanta: 1 }),
  );
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'would-offload');
  assert.equal(decision.reason, 'selected');
  assert.equal(decision.plan.payloadBytes, 800);
  assert.equal(decision.plan.payloadAfterBytes, 400);
  assert.equal(decision.eventSeq, undefined, 'a dry run has no event sequence');
  assert.equal(session.seq, seqBefore, 'the log did not grow');
  assert.equal(offloadEvents(session).length, 0, 'no decision was written');
  assert.equal(JSON.stringify(session.deriveMessages()), derivedBefore, 'the derived history is unchanged');
  assert.deepEqual(positions(decision.selected), [`${firstSeq}:0`]);

  // DESIGN §5.6: the dry run reports seq + imageIndex + attachmentId + bytes
  // per selected position. Those fields live on the structured log record.
  const wouldOffload = logs.filter((record) => record.event === 'would-offload');
  assert.equal(wouldOffload.length, 1);
  assert.equal(wouldOffload[0].seq, firstSeq);
  assert.equal(wouldOffload[0].imageIndex, 0);
  assert.equal(wouldOffload[0].attachmentId, 'att-1');
  assert.equal(wouldOffload[0].bytes, 400, 'reported bytes are the base64 request length');
  assert.equal(wouldOffload[0].provider, PROVIDER);
  assert.equal(wouldOffload[0].model, MODEL);
  assert.ok(
    logs.some((record) => record.event === 'dry-run-summary'),
    'the summary record is emitted once',
  );
});

test('replay: Session.create over the same events reproduces the same decision', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('original');
  for (let step = 1; step <= 4; step += 1) appendImageStep(session, step, `att-${step}`);

  const config = ConfigSchema.parse({ maxRequestImageBytes: 800, minRetainImages: 1, retainSteps: 0, quanta: 1 });
  const guard = createGuard(ctx, config);
  const original = await guard.run(factsFor(session), RESOLVED);
  assert.equal(original.action, 'offloaded');

  // Replay the exact pre-decision prefix into a detached session.
  const prefix = session.snapshotEvents(0, original.eventSeq);
  const replay = Session.create(SessionId('replay'), prefix, undefined, 0, [imageOffloadProjection]);

  const { ctx: replayCtx } = makeWorld();
  const replayGuard = createGuard(replayCtx, config);
  const replayed = await replayGuard.run(factsFor(replay), RESOLVED);

  assert.equal(replayed.action, original.action);
  assert.equal(replayed.reason, original.reason);
  assert.deepEqual(replayed.selected, original.selected, 'selection is deterministic over the durable log');
  assert.equal(replayed.plan.payloadBytes, original.plan.payloadBytes);
  assert.equal(replayed.plan.payloadAfterBytes, original.plan.payloadAfterBytes);
  assert.equal(replayed.policy.dimension, original.policy.dimension);
  // The detached seed appends its own `session/end-seed` marker, so the
  // absolute event seq shifts by that one marker; the decisions are identical.
  assert.equal(replay.seq, prefix.length + 2, 'seed marker plus the replayed decision');
  assert.equal(replayed.eventSeq, prefix.length + 1, 'the decision lands right after the seed marker');
  assert.deepEqual(replayed.selected, original.selected);
  assert.equal(replay.deriveMessages().flatMap((message) => message.content).filter((block) => block.type === 'image' && block.offloaded === true).length, 2);
});

test('fork: a child session decides independently and never mutates the parent', async () => {
  const { ctx } = makeWorld();
  const parent = ctx.sessions.create('parent');
  for (let step = 1; step <= 4; step += 1) appendImageStep(parent, step, `att-${step}`);

  const parentSeqBefore = parent.seq;
  const parentDerivedBefore = JSON.stringify(parent.deriveMessages());
  const child = ctx.sessions.fork(parent);

  assert.equal(parent.seq, parentSeqBefore, 'forking does not append to the parent');
  assert.equal(JSON.stringify(parent.deriveMessages()), parentDerivedBefore);
  assert.deepEqual(child.surface.nodes, parent.surface.nodes, 'the child inherits the same surface');

  const config = ConfigSchema.parse({ maxRequestImageBytes: 800, minRetainImages: 1, retainSteps: 0, quanta: 1 });
  const childGuard = createGuard(ctx, config);
  const childDecision = await childGuard.run(factsFor(child), RESOLVED);
  assert.equal(childDecision.action, 'offloaded');
  assert.equal(offloadEvents(child).length, 1, 'the decision landed on the child');
  assert.equal(offloadEvents(parent).length, 0, 'the parent log is untouched');
  assert.equal(parent.seq, parentSeqBefore);
  assert.equal(JSON.stringify(parent.deriveMessages()), parentDerivedBefore);

  // The parent now makes the same decision on its own log.
  const parentGuard = createGuard(ctx, config);
  const parentDecision = await parentGuard.run(factsFor(parent), RESOLVED);
  assert.deepEqual(parentDecision.selected, childDecision.selected, 'the child forked from an identical surface');
  assert.equal(offloadEvents(parent).length, 1);
});

test('no-op: a surface with no image occurrences', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('no-images');
  appendUserStep(session, 1, [{ type: 'text', text: 'just text' }]);
  const seqBefore = session.seq;

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'no-images');
  assert.equal(decision.plan, undefined);
  assert.equal(session.seq, seqBefore);
});

test('no-op: an assistant-only image surface is not a request input', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('assistant-only');
  session.append('step/start', { turn: 1, step: 1 });
  // Only user/message and tool/result nodes may carry request images; an
  // assistant node with an image block is skipped by surfaceImageOccurrences().
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'image', attachment: image('att-a') }],
        source: { provider: PROVIDER, model: MODEL },
      }),
      stream: [],
    },
    { surfaceOp: 'append' },
  );

  assert.deepEqual(surfaceImageOccurrences(session), [], 'no occurrence is read from a non-request node');

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);
  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'no-images');
});

test('no-op: no attachments service mounted', async () => {
  const { ctx } = makeWorld({ mountAttachments: false });
  const session = ctx.sessions.create('no-attachments');
  appendImageStep(session, 1, 'att-1');
  const seqBefore = session.seq;

  assert.equal(ctx.get('attachments'), undefined, 'the service is genuinely absent');
  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'no-attachments');
  assert.equal(session.seq, seqBefore);

  // The missing-service warning is logged once per guard instance.
  const second = await guard.run(factsFor(session), RESOLVED);
  assert.equal(second.reason, 'no-attachments');
});

test('no-op: text-only route is not image capable', async () => {
  const { ctx } = makeWorld({ modalities: ['text'] });
  const session = ctx.sessions.create('text-only');
  appendImageStep(session, 1, 'att-1');
  const seqBefore = session.seq;

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'route-not-image-capable');
  assert.equal(session.seq, seqBefore, 'nothing was measured or written');
});

test('no-op: unknown modalities are treated as not image capable', async () => {
  const { ctx } = makeWorld({ modalities: 'absent' });
  const session = ctx.sessions.create('unknown-modalities');
  appendImageStep(session, 1, 'att-1');

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);
  assert.equal(decision.reason, 'route-not-image-capable');
});

test('no-op: an open compaction transaction holds the lock', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('compacting');
  appendImageStep(session, 1, 'att-1');
  session.append('compaction/start', {});
  const seqBefore = session.seq;

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const open = await guard.run(factsFor(session), RESOLVED);
  assert.equal(open.action, 'noop');
  assert.equal(open.reason, 'compaction-in-progress');
  assert.equal(session.seq, seqBefore);

  // Once the transaction closes, the guard participates again.
  session.append('compaction/end', {});
  const closed = await guard.run(factsFor(session), RESOLVED);
  assert.equal(closed.action, 'offloaded');
});

test('no-op: an already-aborted turn signal', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('aborted');
  appendImageStep(session, 1, 'att-1');
  const seqBefore = session.seq;

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session, { signal: AbortSignal.abort() }), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'aborted');
  assert.equal(session.seq, seqBefore);
});

test('no-op: disabled switch, disabled route, and an empty route', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('switches');
  appendImageStep(session, 1, 'att-1');

  const disabled = createGuard(ctx, ConfigSchema.parse({ enabled: false, maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  assert.deepEqual(
    (({ action, reason }) => ({ action, reason }))(await disabled.run(factsFor(session), RESOLVED)),
    { action: 'noop', reason: 'disabled' },
  );

  const routeDisabled = createGuard(
    ctx,
    ConfigSchema.parse({
      maxRequestImageBytes: 1,
      minRetainImages: 0,
      retainSteps: 0,
      quanta: 1,
      perRoute: [{ provider: PROVIDER, model: MODEL, enabled: false }],
    }),
  );
  assert.equal((await routeDisabled.run(factsFor(session), RESOLVED)).reason, 'route-disabled');

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const noRoute = await guard.run(factsFor(session), { provider: '', model: '' });
  assert.equal(noRoute.action, 'noop');
  assert.equal(noRoute.reason, 'no-route');
});

test('stale-surface: a surface that changes during estimation writes nothing', async () => {
  // `readImageRequest()` is the guard's one await between reading the surface
  // and appending; a `surfaceOp: 'replace'` during it (a compaction landing
  // concurrently) makes the planned target stale.
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('stale');
  const imageSeq = appendImageStep(session, 1, 'att-1');

  let race = true;
  let seqAfterReplace;
  const store = ctx.get('attachments');
  const original = store.readImageRequest.bind(store);
  store.readImageRequest = async (ref, target, signal) => {
    if (race) {
      race = false;
      session.append(
        'user/message',
        createUserMessage({ content: [{ type: 'text', text: 'compacted summary' }], source: { kind: 'user' } }),
        { surfaceOp: { op: 'replace', startSeq: imageSeq, endSeq: imageSeq }, sourceEventSeqs: [imageSeq] },
      );
      seqAfterReplace = session.seq;
    }
    return original(ref, target, signal);
  };

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'stale-surface');
  assert.equal(decision.plan.targets.length, 1, 'the plan was computed against the pre-replace surface');
  assert.equal(session.seq, seqAfterReplace, 'the guard appended nothing after the concurrent replace');
  assert.equal(offloadEvents(session).length, 0);
});

test('append-failed: a throwing session append leaves the log unchanged', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('append-fails');
  appendImageStep(session, 1, 'att-1');
  const seqBefore = session.seq;

  // A Proxy is the only way to make `Session.append` throw for a validated
  // decision without patching src; every other read forwards to the real log.
  const proxy = new Proxy(session, {
    get(target, property, receiver) {
      if (property === 'append') return () => { throw new Error('storage is full'); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(proxy), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'append-failed');
  assert.equal(session.seq, seqBefore, 'the durable log is unchanged');
  assert.equal(offloadEvents(session).length, 0);
});

test('estimate-failed: an unreadable request version is a no-op with no event', async () => {
  const { ctx } = makeWorld({ readThrows: true });
  const session = ctx.sessions.create('unreadable');
  appendImageStep(session, 1, 'att-1');
  const seqBefore = session.seq;
  const logs = captureLogs(ctx);

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'estimate-failed');
  assert.equal(decision.policy.representation, 'inline-base64', 'the resolved policy is still reported');
  assert.equal(session.seq, seqBefore, 'no event was written');
  assert.equal(offloadEvents(session).length, 0);
  assert.ok(logs.some((record) => record.event === 'estimate-failed'), 'the failure is logged with its cause');
});

test('estimate-failed: a throwing imageRequestTarget is a no-op with no event', async () => {
  const { ctx } = makeWorld({ targetThrows: true });
  const session = ctx.sessions.create('bad-target');
  appendImageStep(session, 1, 'att-1');
  const seqBefore = session.seq;

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'estimate-failed');
  assert.equal(session.seq, seqBefore);
});

test('never throws: a failing model resolution downgrades to a no-op', async () => {
  const { ctx } = makeWorld({ resolveThrows: true });
  const session = ctx.sessions.create('resolve-fails');
  appendImageStep(session, 1, 'att-1');
  const seqBefore = session.seq;

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'route-not-image-capable', 'unresolvable capability is negative capability');
  assert.equal(session.seq, seqBefore);
});

test('perRoute imageCapable: true forces a capability the adapter does not declare', async () => {
  const { ctx } = makeWorld({ modalities: ['text'] });
  const session = ctx.sessions.create('forced');
  appendImageStep(session, 1, 'att-1');

  const guard = createGuard(
    ctx,
    ConfigSchema.parse({
      maxRequestImageBytes: 1,
      minRetainImages: 0,
      retainSteps: 0,
      quanta: 1,
      perRoute: [{ provider: PROVIDER, model: MODEL, imageCapable: true }],
    }),
  );
  const decision = await guard.run(factsFor(session), RESOLVED);
  assert.equal(decision.action, 'offloaded');
  assert.equal(decision.reason, 'selected');
});

test('perRoute imageCapable: false vetoes a capable adapter', async () => {
  const { ctx } = makeWorld({ modalities: ['text', 'image'] });
  const session = ctx.sessions.create('vetoed');
  appendImageStep(session, 1, 'att-1');

  const guard = createGuard(
    ctx,
    ConfigSchema.parse({
      maxRequestImageBytes: 1,
      minRetainImages: 0,
      retainSteps: 0,
      quanta: 1,
      perRoute: [{ provider: PROVIDER, model: MODEL, imageCapable: false }],
    }),
  );
  const decision = await guard.run(factsFor(session), RESOLVED);
  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'route-not-image-capable');
});

test('representation: a Files-route adapter resolves the count dimension', async () => {
  const { ctx } = makeWorld({
    configurable: [{ provider: PROVIDER, displayName: 'DeepSeek', settingsNs: 'llm-deepseek-v4', settingsPath: [] }],
  });
  const session = ctx.sessions.create('files-route');
  for (let step = 1; step <= 5; step += 1) appendImageStep(session, step, `att-${step}`);

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImages: 3, minRetainImages: 1, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.policy.representation, 'files');
  assert.equal(decision.policy.dimension, 'count');
  assert.equal(decision.policy.maxBytes, Number.POSITIVE_INFINITY, 'the byte budget is unbounded on a count route');
  assert.equal(decision.policy.maxImages, 3);
  assert.equal(decision.action, 'offloaded');
  assert.equal(decision.plan.retainedAfter, 3);
  assert.equal(decision.plan.removedCount, 2);
});

test('representation: a pi-ai route keeps the inline base64 byte budget', async () => {
  const { ctx } = makeWorld({
    configurable: [{ provider: PROVIDER, displayName: 'pi-ai', settingsNs: 'llm-pi-ai', settingsPath: [] }],
  });
  const session = ctx.sessions.create('inline-route');
  appendImageStep(session, 1, 'att-1');

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 100, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.policy.representation, 'inline-base64');
  assert.equal(decision.policy.dimension, 'bytes');
  assert.equal(decision.plan.payloadBytes, 400, 'held bytes are base64 length, not raw size');
});

test('multiple images in one message become one target with ascending indexes', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('multi');
  const seq = appendUserStep(session, 1, [
    { type: 'image', attachment: image('att-a') },
    { type: 'text', text: 'a caption between the images' },
    { type: 'image', attachment: image('att-b') },
  ]);
  appendImageStep(session, 2, 'att-c');

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 400, minRetainImages: 1, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.deepEqual(decision.selected, [{ seq, imageIndexes: [0, 1] }]);
  const events = offloadEvents(session);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data.targets, [{ seq, imageIndexes: [0, 1] }]);
  const derived = session.deriveMessages()[0].content.filter((block) => block.type === 'image');
  assert.deepEqual(derived.map((block) => block.offloaded === true), [true, true]);
});

test('tool/result images are request occurrences too', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('tool');
  session.append('step/start', { turn: 1, step: 1 });
  const resultSeq = session.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'call-1',
        content: [{ type: 'image', attachment: image('att-tool') }],
        isError: false,
      }),
    },
    { surfaceOp: 'append' },
  ).seq;

  assert.deepEqual(surfaceImageOccurrences(session).map((occurrence) => `${occurrence.seq}:${occurrence.imageIndex}`), [`${resultSeq}:0`]);

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);
  assert.equal(decision.action, 'offloaded');
  assert.deepEqual(decision.selected, [{ seq: resultSeq, imageIndexes: [0] }]);
});

test('coexistence: an occurrence the sibling offload plugin already omitted is skipped', async () => {
  const world = makeWorld();
  const { ctx } = world;
  const session = ctx.sessions.create('pre-offloaded');
  const seqs = [];
  for (let step = 1; step <= 3; step += 1) seqs.push(appendImageStep(session, step, `att-${step}`));

  // `compaction-image-offload` recorded the oldest occurrence before this guard ran.
  session.append('image/offload', { targets: [{ seq: seqs[0], imageIndexes: [0] }] });
  const readsBefore = world.requestCalls;

  // 2 retained × 400 B = 800 B; budget 700 B ⇒ the next-oldest must go.
  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 700, minRetainImages: 1, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'offloaded');
  assert.equal(decision.reason, 'selected');
  assert.deepEqual(decision.selected, [{ seq: seqs[1], imageIndexes: [0] }], 'no duplicate omission of the offloaded occurrence');
  assert.equal(decision.plan.retainedCount, 2, 'the offloaded occurrence is not retained');
  assert.equal(decision.plan.payloadBytes, 800, 'its bytes are not represented');
  assert.equal(decision.plan.payloadAfterBytes, 400);
  assert.equal(offloadEvents(session).length, 2, 'the sibling decision and this one both exist');
  assert.equal(offloadEvents(session)[0].data.targets[0].seq, seqs[0], 'the older decision is untouched');
  assert.equal(world.requestCalls - readsBefore, 2, 'the already-omitted occurrence costs no read');
});

test('within-budget: an in-budget surface is a no-op that measures but writes nothing', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('in-budget');
  appendImageStep(session, 1, 'att-1');
  const seqBefore = session.seq;

  // 400 B represented against a 400 B budget: exactly at the limit.
  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 400, minRetainImages: 0, retainSteps: 0, quanta: 4 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.action, 'noop');
  assert.equal(decision.reason, 'within-budget');
  assert.equal(decision.plan.payloadBytes, 400);
  assert.equal(decision.plan.budgetSatisfied, true);
  assert.deepEqual(decision.plan.targets, []);
  assert.deepEqual(decision.selected, undefined);
  assert.equal(session.seq, seqBefore);
});

test('minRetainImages: the newest occurrences are never selected', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('retain-newest');
  const seqs = [];
  for (let step = 1; step <= 5; step += 1) seqs.push(appendImageStep(session, step, `att-${step}`));

  // 5 × 400 B = 2000 B; keep the newest 3 and demand 400 B: only 2 eligible.
  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 400, minRetainImages: 3, retainSteps: 0, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.plan.candidateCount, 2);
  assert.deepEqual(decision.selected, [
    { seq: seqs[0], imageIndexes: [0] },
    { seq: seqs[1], imageIndexes: [0] },
  ]);
  assert.equal(decision.plan.retainedAfter, 3);
  assert.equal(decision.plan.payloadAfterBytes, 1200);
  assert.equal(decision.plan.budgetSatisfied, false);
  assert.equal(decision.reason, 'exhausted-candidates');

  const offloaded = session
    .deriveMessages()
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'image' && block.offloaded === true);
  assert.equal(offloaded.length, 2, 'the newest three keep their bytes');
});

test('retainSteps: occurrences admitted in the recent window are never selected', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('retain-steps');
  const seqs = [];
  for (let step = 1; step <= 4; step += 1) seqs.push(appendImageStep(session, step, `att-${step}`));

  // The boundary names the step/start of the second-most-recent step.
  assert.equal(recentStepBoundary(session, 2), 6);
  assert.ok(seqs[2] > 6 && seqs[3] > 6, 'the last two messages are inside the window');

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 2, quanta: 1 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.plan.candidateCount, 2, 'only occurrences outside the window are eligible');
  assert.deepEqual(decision.selected.map((target) => target.seq), [seqs[0], seqs[1]]);
  for (const target of decision.selected) {
    assert.ok(target.seq < 6, 'no recent occurrence is selected');
  }
});

test('budget invariant: the represented payload fits whenever the eligible set can reach it', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('budget');
  for (let step = 1; step <= 6; step += 1) appendImageStep(session, step, `att-${step}`);

  const guard = createGuard(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1200, minRetainImages: 1, retainSteps: 0, quanta: 2 }));
  const decision = await guard.run(factsFor(session), RESOLVED);

  assert.equal(decision.plan.budgetSatisfied, true);
  assert.ok(decision.plan.payloadAfterBytes <= 1200, 'the post-decision estimate fits the budget');
  assert.ok(decision.plan.removedCount >= 2, 'the quantum floor was honored');

  // Verify against the real derived history, not just the plan: sum the base64
  // length of every retained image block.
  const retainedBytes = session
    .deriveMessages()
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'image' && block.offloaded !== true)
    .reduce((sum, block) => sum + Math.ceil(block.attachment.bytes / 3) * 4, 0);
  assert.equal(retainedBytes, decision.plan.payloadAfterBytes, 'the plan matches the derived request');
  assert.ok(retainedBytes <= 1200);
});

test('apply: the agent/request listener returns the config unchanged and decides before derivation', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('applied');
  appendImageStep(session, 1, 'att-1');

  apply(ctx, ConfigSchema.parse({ maxRequestImageBytes: 1, minRetainImages: 0, retainSteps: 0, quanta: 1 }));

  const resolved = { ...RESOLVED, maxTokens: 4096 };
  const returned = await ctx.waterfall(
    'agent/request',
    { agent: { session, options: {} }, turn: 1, step: 2, signal: new AbortController().signal },
    async () => resolved,
  );

  assert.equal(returned, resolved, 'the listener always returns the configuration it was given');
  assert.equal(offloadEvents(session).length, 1, 'the decision is part of the request');
  assert.equal(session.seq, 4, 'step/start + user/message + step/end + the decision');
  assert.equal(offloadEvents(session)[0].seq, 3, 'the event is appended before the caller derives messages');
  assert.equal(ctx.sessions.messageProjections.length, 1, 'apply did not double-register the projection');
});

test('surface occurrences: index counts every occurrence including offloaded ones', async () => {
  const { ctx } = makeWorld();
  const session = ctx.sessions.create('indexes');
  const seq = appendUserStep(session, 1, [
    { type: 'image', attachment: image('att-a') },
    { type: 'image', attachment: image('att-b') },
    { type: 'image', attachment: image('att-c') },
  ]);

  const before = surfaceImageOccurrences(session);
  assert.deepEqual(before.map((occurrence) => occurrence.imageIndex), [0, 1, 2]);

  session.append('image/offload', { targets: [{ seq, imageIndexes: [1] }] });

  const after = surfaceImageOccurrences(session);
  assert.deepEqual(after.map((occurrence) => occurrence.imageIndex), [0, 1, 2], 'indexes still count omitted occurrences');
  assert.deepEqual(after.map((occurrence) => occurrence.offloaded), [false, true, false]);
  assert.deepEqual(after.map((occurrence) => occurrence.attachment.attachmentId), ['att-a', 'att-b', 'att-c']);
});
