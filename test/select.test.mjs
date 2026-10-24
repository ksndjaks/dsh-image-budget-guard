/**
 * Pure selection-algorithm tests (`dist/select.js`).
 *
 * Everything here is a table test over `planImageOffload()` and
 * `base64Length()`: no session, no service, no I/O. The assertions encode the
 * frozen contract in `docs/DESIGN.md` §3 (`SelectionResult`) and §5
 * (invariants 1–3), plus the two adapter policies this module mirrors:
 *
 * - `dsh-llm` `requiredImageOffload()` removes *whole prefix quanta* from the
 *   oldest end, which is why `removedCount >= max(needed, quanta)`.
 * - `dsh-compaction-image-offload` accepts one target per message with
 *   strictly increasing image indexes, which is what `groupTargets()` emits.
 *
 * Run: `node --test test/select.test.mjs` (from the package root, after `pnpm build`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { base64Length, planImageOffload } from '../dist/select.js';

/**
 * An inline-base64 route budget.
 * @param {Record<string, unknown>} [overrides] budget fields to replace.
 */
function budget(overrides = {}) {
  return {
    dimension: 'bytes',
    maxBytes: 1000,
    maxImages: Number.POSITIVE_INFINITY,
    minRetainImages: 0,
    quanta: 1,
    ...overrides,
  };
}

/** A Files/reference route budget: occurrences are counted, bytes are unbounded. */
function countBudget(overrides = {}) {
  return budget({
    dimension: 'count',
    maxBytes: Number.POSITIVE_INFINITY,
    maxImages: 3,
    ...overrides,
  });
}

/**
 * One retained occurrence in request order.
 * @param {number} seq message-producing event sequence.
 * @param {number} imageIndex depth-first image index within that message.
 * @param {number} bytes represented request bytes.
 * @param {{ attachmentId?: string, offloaded?: boolean, recent?: boolean }} [extra]
 */
function occ(seq, imageIndex, bytes, extra = {}) {
  return {
    seq,
    imageIndex,
    attachmentId: extra.attachmentId ?? `att-${seq}-${imageIndex}`,
    bytes,
    offloaded: extra.offloaded ?? false,
    recent: extra.recent ?? false,
  };
}

/** `count` single-image messages of `bytes` each, seqs `1..count`. */
function chain(count, bytes) {
  return Array.from({ length: count }, (_, index) => occ(index + 1, 0, bytes));
}

/** Flatten a decision's targets back into `seq:imageIndex` position strings. */
function positions(targets) {
  return targets.flatMap((target) => target.imageIndexes.map((index) => `${target.seq}:${index}`));
}

test('base64Length: padded inline wire length', () => {
  assert.equal(base64Length(0), 0);
  assert.equal(base64Length(1), 4);
  assert.equal(base64Length(2), 4);
  assert.equal(base64Length(3), 4);
  assert.equal(base64Length(4), 8);
  assert.equal(base64Length(6), 8);
  assert.equal(base64Length(6144), 8192);
  // Exactly ceil(bytes / 3) * 4, including the final quantum's padding.
  for (const bytes of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12345]) {
    assert.equal(base64Length(bytes), Math.ceil(bytes / 3) * 4);
  }
});

test('within-budget: payload exactly at maxBytes selects nothing', () => {
  const occurrences = chain(2, 100);
  const result = planImageOffload(occurrences, budget({ maxBytes: 200 }));

  assert.deepEqual(result, {
    targets: [],
    retainedCount: 2,
    payloadBytes: 200,
    retainedAfter: 2,
    payloadAfterBytes: 200,
    removedCount: 0,
    candidateCount: 0,
    budgetSatisfied: true,
    reason: 'within-budget',
  });
});

test('within-budget: one byte over maxBytes selects the oldest occurrence', () => {
  const occurrences = chain(2, 100);
  const result = planImageOffload(occurrences, budget({ maxBytes: 199, quanta: 1 }));

  assert.equal(result.reason, 'selected');
  assert.equal(result.budgetSatisfied, true);
  assert.equal(result.removedCount, 1);
  assert.equal(result.retainedAfter, 1);
  assert.equal(result.payloadAfterBytes, 100);
  assert.deepEqual(result.targets, [{ seq: 1, imageIndexes: [0] }]);
});

test('within-budget: count dimension boundary at maxImages', () => {
  const occurrences = chain(3, 9999);
  const atLimit = planImageOffload(occurrences, countBudget({ maxImages: 3 }));
  assert.equal(atLimit.reason, 'within-budget');
  assert.deepEqual(atLimit.targets, []);
  assert.equal(atLimit.payloadBytes, 3 * 9999, 'count dimension still reports represented bytes');

  const overLimit = planImageOffload(occurrences, countBudget({ maxImages: 2 }));
  assert.equal(overLimit.reason, 'selected');
  assert.equal(overLimit.removedCount, 1);
  assert.equal(overLimit.retainedAfter, 2);
  assert.equal(overLimit.budgetSatisfied, true);
  assert.deepEqual(overLimit.targets, [{ seq: 1, imageIndexes: [0] }]);
});

test('quanta: removal count is max(needed, quanta)', () => {
  // 10 × 100 B = 1000 B; removing one already fits 950 B, but quanta is 4.
  const result = planImageOffload(chain(10, 100), budget({ maxBytes: 950, quanta: 4 }));

  assert.equal(result.reason, 'selected');
  assert.equal(result.removedCount, 4);
  assert.equal(result.retainedAfter, 6);
  assert.equal(result.payloadAfterBytes, 600);
  assert.equal(result.candidateCount, 10);
  assert.equal(result.budgetSatisfied, true);
  assert.deepEqual(result.targets.map((target) => target.seq), [1, 2, 3, 4]);
});

test('quanta: never exceeds the eligible count', () => {
  // Three occurrences, the newest one protected: two are eligible while the
  // floor asks for ten. Removing both still cannot fit the budget.
  const result = planImageOffload(chain(3, 100), budget({ maxBytes: 1, minRetainImages: 1, quanta: 10 }));

  assert.equal(result.candidateCount, 2);
  assert.equal(result.removedCount, 2, 'the eligible set caps the quantum floor');
  assert.equal(result.retainedAfter, 1);
  assert.equal(result.payloadAfterBytes, 100);
  assert.equal(result.reason, 'exhausted-candidates');
  assert.equal(result.budgetSatisfied, false);
  assert.deepEqual(positions(result.targets), ['1:0', '2:0']);
});

test('quanta: removing every eligible occurrence that makes it fit is "selected"', () => {
  // All three are eligible and removing them fits the budget, so the decision
  // succeeds rather than reporting exhaustion.
  const result = planImageOffload(chain(3, 100), budget({ maxBytes: 1, quanta: 10 }));

  assert.equal(result.removedCount, 3);
  assert.equal(result.retainedAfter, 0);
  assert.equal(result.payloadAfterBytes, 0);
  assert.equal(result.reason, 'selected');
  assert.equal(result.budgetSatisfied, true);
  assert.deepEqual(positions(result.targets), ['1:0', '2:0', '3:0']);
});

test('quanta: stops exactly at the floor when the budget already fits', () => {
  // 8 × 100 B; 4 removals fit 400 ≤ 500. quanta 4 is satisfied in one step.
  const result = planImageOffload(chain(8, 100), budget({ maxBytes: 500, quanta: 4 }));
  assert.equal(result.removedCount, 4);
  assert.equal(result.payloadAfterBytes, 400);
  assert.equal(result.reason, 'selected');
});

test('quanta: does not overshoot past the last needed occurrence', () => {
  // 5 × 100 B, maxBytes 250: needs 3 removals (200 ≤ 250); quanta 2 is below.
  const result = planImageOffload(chain(5, 100), budget({ maxBytes: 250, quanta: 2 }));
  assert.equal(result.removedCount, 3);
  assert.equal(result.payloadAfterBytes, 200);
  assert.equal(result.reason, 'selected');
});

test('minRetainImages: the newest K are retained even when the budget cannot be met', () => {
  const occurrences = chain(5, 100);
  const result = planImageOffload(occurrences, budget({ maxBytes: 100, minRetainImages: 4, quanta: 1 }));

  assert.equal(result.candidateCount, 1, 'only the oldest occurrence is eligible');
  assert.equal(result.removedCount, 1);
  assert.deepEqual(result.targets, [{ seq: 1, imageIndexes: [0] }]);
  assert.equal(result.retainedAfter, 4);
  assert.equal(result.payloadAfterBytes, 400);
  assert.equal(result.budgetSatisfied, false, 'budget cannot fit while four are protected');
  assert.equal(result.reason, 'exhausted-candidates');
});

test('minRetainImages: nothing eligible reports no-candidates', () => {
  const result = planImageOffload(chain(2, 100), budget({ maxBytes: 1, minRetainImages: 5 }));
  assert.equal(result.reason, 'no-candidates');
  assert.equal(result.budgetSatisfied, false);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.retainedAfter, result.retainedCount);
  assert.equal(result.payloadAfterBytes, result.payloadBytes);
  assert.deepEqual(result.targets, []);
});

test('minRetainImages vs quanta: retention wins over the quantum floor', () => {
  // 8 images, minRetain 6 → 2 eligible; quanta 4 must not force 4.
  const result = planImageOffload(chain(8, 100), budget({ maxBytes: 100, minRetainImages: 6, quanta: 4 }));

  assert.equal(result.candidateCount, 2);
  assert.equal(result.removedCount, 2, 'the eligible set caps the quantum floor');
  assert.equal(result.retainedAfter, 6);
  assert.equal(result.payloadAfterBytes, 600);
  assert.equal(result.budgetSatisfied, false);
  assert.equal(result.reason, 'exhausted-candidates');
  assert.deepEqual(positions(result.targets), ['1:0', '2:0']);
});

test('retainSteps: recent occurrences are never selected', () => {
  // Oldest two are marked recent; retention protects the newest two.
  const occurrences = [
    occ(1, 0, 100, { recent: true }),
    occ(2, 0, 100, { recent: true }),
    occ(3, 0, 100),
    occ(4, 0, 100),
    occ(5, 0, 100),
    occ(6, 0, 100),
    occ(7, 0, 100),
    occ(8, 0, 100),
  ];
  const result = planImageOffload(occurrences, budget({ maxBytes: 1, minRetainImages: 2, quanta: 1 }));

  assert.equal(result.candidateCount, 4, 'recent prefix occurrences are not candidates');
  assert.equal(result.removedCount, 4);
  assert.deepEqual(positions(result.targets), ['3:0', '4:0', '5:0', '6:0']);
  for (const target of result.targets) {
    assert.ok(target.seq >= 3 && target.seq <= 6, `seq ${target.seq} must be eligible`);
  }
  // Selection is still a prefix of the eligible sequence: no newer eligible
  // occurrence is skipped.
  const eligible = [3, 4, 5, 6];
  const selected = result.targets.map((target) => target.seq);
  assert.deepEqual(selected, eligible.slice(0, selected.length));
});

test('duplicate attachment referenced twice counts as two occurrences', () => {
  const occurrences = [
    occ(1, 0, 100, { attachmentId: 'att-shared' }),
    occ(2, 0, 100, { attachmentId: 'att-shared' }),
    occ(3, 0, 100, { attachmentId: 'att-new' }),
  ];
  const result = planImageOffload(occurrences, budget({ maxBytes: 100, quanta: 1 }));

  assert.equal(result.removedCount, 2, 'each occurrence is measured on its own');
  assert.equal(result.payloadBytes, 300);
  assert.deepEqual(result.targets.map((target) => target.seq), [1, 2]);
});

test('one message with multiple images becomes one target with ascending indexes', () => {
  const occurrences = [occ(7, 0, 100), occ(7, 1, 100), occ(7, 2, 100), occ(9, 0, 100)];
  const result = planImageOffload(occurrences, budget({ maxBytes: 50, quanta: 1 }));

  assert.deepEqual(result.targets, [
    { seq: 7, imageIndexes: [0, 1, 2] },
    { seq: 9, imageIndexes: [0] },
  ]);
  for (const target of result.targets) {
    for (let index = 1; index < target.imageIndexes.length; index += 1) {
      assert.ok(target.imageIndexes[index] > target.imageIndexes[index - 1], 'indexes are strictly increasing');
    }
  }
});

test('one message with multiple images stops mid-message once the budget fits', () => {
  // 4 × 100 B, maxBytes 120: three removals fit exactly; the fourth stays.
  const occurrences = [occ(7, 0, 100), occ(7, 1, 100), occ(7, 2, 100), occ(9, 0, 100)];
  const result = planImageOffload(occurrences, budget({ maxBytes: 120, quanta: 1 }));

  assert.deepEqual(result.targets, [{ seq: 7, imageIndexes: [0, 1, 2] }]);
  assert.equal(result.retainedAfter, 1);
  assert.equal(result.payloadAfterBytes, 100);
  assert.equal(result.reason, 'selected');
});

test('empty occurrences: within-budget with zero payload', () => {
  const result = planImageOffload([], budget());
  assert.deepEqual(result, {
    targets: [],
    retainedCount: 0,
    payloadBytes: 0,
    retainedAfter: 0,
    payloadAfterBytes: 0,
    removedCount: 0,
    candidateCount: 0,
    budgetSatisfied: true,
    reason: 'within-budget',
  });
});

test('assistant-only images: the caller passes no occurrences, so it is within-budget', () => {
  // `surfaceImageOccurrences()` skips assistant/system/developer nodes, so an
  // assistant-only surface reaches the planner as an empty list.
  const result = planImageOffload([], budget({ maxBytes: 1 }));
  assert.equal(result.reason, 'within-budget');
  assert.deepEqual(result.targets, []);
});

test('already-offloaded occurrences are skipped and do not contribute bytes', () => {
  const occurrences = [
    occ(1, 0, 999, { offloaded: true }),
    occ(2, 0, 100),
    occ(3, 0, 100),
  ];
  const result = planImageOffload(occurrences, budget({ maxBytes: 100, quanta: 1 }));

  assert.equal(result.retainedCount, 2, 'offloaded occurrences are not retained');
  assert.equal(result.payloadBytes, 200, 'offloaded bytes are not represented');
  assert.deepEqual(result.targets, [{ seq: 2, imageIndexes: [0] }], 'no duplicate omission');
  assert.equal(result.removedCount, 1);
  assert.equal(result.payloadAfterBytes, 100);
});

test('already-offloaded buffer is not treated as budget headroom', () => {
  // The offloaded 5000 B occurrence must not make an over-budget surface look
  // satisfied merely because the total surface is larger than the budget.
  const occurrences = [occ(1, 0, 5000, { offloaded: true }), ...chain(2, 100).map((o) => ({ ...o, seq: o.seq + 1 }))];
  const result = planImageOffload(occurrences, budget({ maxBytes: 150, quanta: 1 }));
  assert.equal(result.payloadBytes, 200);
  assert.equal(result.reason, 'selected');
  assert.deepEqual(result.targets, [{ seq: 2, imageIndexes: [0] }]);
});

test('count dimension: maxImages is enforced and bytes are unbounded', () => {
  const occurrences = chain(5, 10_000_000);
  const result = planImageOffload(occurrences, countBudget({ maxImages: 3 }));

  assert.equal(result.retainedCount, 5);
  assert.equal(result.payloadBytes, 50_000_000);
  assert.equal(result.removedCount, 2);
  assert.equal(result.retainedAfter, 3);
  assert.equal(result.budgetSatisfied, true);
  assert.equal(result.reason, 'selected');
});

test('count dimension: unbounded bytes never trigger a byte decision', () => {
  const occurrences = chain(3, Number.MAX_SAFE_INTEGER);
  const result = planImageOffload(occurrences, countBudget({ maxImages: 5 }));
  assert.equal(result.reason, 'within-budget');
  assert.deepEqual(result.targets, []);
});

test('bytes dimension: maxImages Infinity never triggers a count decision', () => {
  const occurrences = chain(200, 1);
  const result = planImageOffload(occurrences, budget({ maxBytes: 10_000, maxImages: Number.POSITIVE_INFINITY }));
  assert.equal(result.reason, 'within-budget');
});

test('invariant: selected occurrences are a strict prefix of the eligible sequence', () => {
  const occurrences = Array.from({ length: 12 }, (_, index) => occ(index + 1, 0, 137));
  const result = planImageOffload(occurrences, budget({ maxBytes: 700, minRetainImages: 3, quanta: 2 }));

  const selectedSeqs = result.targets.map((target) => target.seq);
  assert.deepEqual(selectedSeqs, [1, 2, 3, 4, 5, 6, 7].slice(0, selectedSeqs.length));
  assert.ok(result.retainedAfter >= 3, 'retention floor holds');
  assert.equal(result.retainedAfter + result.removedCount, result.retainedCount);
});

test('result counts are internally consistent for every decision', () => {
  const cases = [
    [chain(6, 100), budget({ maxBytes: 250, minRetainImages: 1, quanta: 2 })],
    [chain(3, 100), budget({ maxBytes: 1, quanta: 9 })],
    [chain(4, 0), budget({ maxBytes: 0 })],
    [chain(2, 5), countBudget({ maxImages: 1 })],
    [chain(9, 70), budget({ maxBytes: 300, minRetainImages: 3, quanta: 4 })],
  ];
  for (const [occurrences, policy] of cases) {
    const result = planImageOffload(occurrences, policy);

    assert.equal(result.retainedAfter, result.retainedCount - result.removedCount);
    assert.ok(result.removedCount <= result.candidateCount);
    assert.ok(result.candidateCount <= result.retainedCount);

    // Reconstruct the removal set from the targets and re-add its bytes: the
    // reported post-decision payload must be exactly that.
    const removedBytes = positions(result.targets).reduce((sum, position) => {
      const [seq, imageIndex] = position.split(':').map(Number);
      const match = occurrences.find((o) => o.seq === seq && o.imageIndex === imageIndex);
      assert.ok(match !== undefined, `target position ${position} must name a real occurrence`);
      assert.equal(match.offloaded, false, 'an offloaded occurrence is never selected again');
      return sum + match.bytes;
    }, 0);
    assert.equal(removedBytes, result.payloadBytes - result.payloadAfterBytes, 'payloadAfterBytes accounts every selected byte');
    assert.equal(positions(result.targets).length, result.removedCount, 'removedCount equals the number of selected positions');
    assert.equal(result.budgetSatisfied, result.payloadAfterBytes <= policy.maxBytes && result.retainedAfter <= policy.maxImages);
  }
});
