/** Whether a retained payload fits an already-resolved budget. */
function fits(payloadBytes, retainedCount, budget) {
    return payloadBytes <= budget.maxBytes && retainedCount <= budget.maxImages;
}
/**
 * Group selected occurrences into one `image/offload` payload.
 *
 * Occurrences arrive in request order, so grouping preserves ascending seqs and
 * ascending image indexes per message — the shape `imageOffloadProjection`
 * validates (`strictly increasing non-negative safe integers`, one target per
 * current surface node).
 */
function groupTargets(selected) {
    const targets = [];
    for (const occurrence of selected) {
        const last = targets.at(-1);
        if (last !== undefined && last.seq === occurrence.seq)
            last.imageIndexes.push(occurrence.imageIndex);
        else
            targets.push({ seq: occurrence.seq, imageIndexes: [occurrence.imageIndex] });
    }
    return targets;
}
/**
 * Plan the oldest-end omission of image occurrences for one request.
 *
 * Invariants:
 * - Already-omitted occurrences are never selected again, so this guard cannot
 *   duplicate an omission `compaction-image-offload` already recorded.
 * - The newest `minRetainImages` retained occurrences and every `recent`
 *   occurrence are never selected, even when the budget cannot then be met;
 *   the result reports `budgetSatisfied: false` instead.
 * - Selection is a prefix of the eligible (oldest-first) sequence, so no
 *   occurrence newer than an omitted one is ever touched out of order.
 * - At least `quanta` occurrences are omitted when at least that many are
 *   eligible; fewer only when the eligible set is smaller.
 *
 * @param occurrences - retained and already-omitted occurrences in request order.
 * @param budget - resolved route budget.
 * @returns the decision, including the post-decision estimate and its reason.
 */
export function planImageOffload(occurrences, budget) {
    const retained = occurrences.filter((occurrence) => !occurrence.offloaded);
    const retainedCount = retained.length;
    let payloadBytes = 0;
    for (const occurrence of retained)
        payloadBytes += occurrence.bytes;
    const base = {
        retainedCount,
        payloadBytes,
    };
    if (fits(payloadBytes, retainedCount, budget)) {
        return {
            ...base,
            targets: [],
            retainedAfter: retainedCount,
            payloadAfterBytes: payloadBytes,
            removedCount: 0,
            candidateCount: 0,
            budgetSatisfied: true,
            reason: 'within-budget',
        };
    }
    // The newest `minRetainImages` retained occurrences form a protected suffix.
    const protectedFrom = Math.max(0, retainedCount - budget.minRetainImages);
    const candidates = retained.slice(0, protectedFrom).filter((occurrence) => !occurrence.recent);
    if (candidates.length === 0) {
        return {
            ...base,
            targets: [],
            retainedAfter: retainedCount,
            payloadAfterBytes: payloadBytes,
            removedCount: 0,
            candidateCount: 0,
            budgetSatisfied: false,
            reason: 'no-candidates',
        };
    }
    let removedBytes = 0;
    let removedCount = 0;
    for (const candidate of candidates) {
        removedBytes += candidate.bytes;
        removedCount += 1;
        const remainingBytes = payloadBytes - removedBytes;
        const remainingCount = retainedCount - removedCount;
        if (removedCount >= budget.quanta && fits(remainingBytes, remainingCount, budget))
            break;
    }
    const selected = candidates.slice(0, removedCount);
    const payloadAfterBytes = payloadBytes - removedBytes;
    const retainedAfter = retainedCount - removedCount;
    const budgetSatisfied = fits(payloadAfterBytes, retainedAfter, budget);
    return {
        ...base,
        targets: groupTargets(selected),
        retainedAfter,
        payloadAfterBytes,
        removedCount,
        candidateCount: candidates.length,
        budgetSatisfied,
        reason: budgetSatisfied ? 'selected' : 'exhausted-candidates',
    };
}
/** Base64 length of raw bytes, including padding; the inline wire representation. */
export function base64Length(bytes) {
    return Math.ceil(bytes / 3) * 4;
}
//# sourceMappingURL=select.js.map