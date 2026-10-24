/**
 * Pure selection algorithm: which image occurrences to omit, in which order.
 *
 * The algorithm mirrors the two request-image policies the Harness already
 * uses, so a guarded request and an adapter-side offload agree on what "fits":
 *
 * - `@deepseek-ai/dsh-llm` `requiredImageOffload()` measures retained
 *   occurrences oldest-first, expands each byte count to its base64 length for
 *   inline routes, and removes whole prefix quanta until the budget fits.
 * - `@deepseek-ai/dsh-compaction-image-offload` records the selected oldest
 *   occurrences in one `image/offload` event and never touches the message
 *   nodes themselves.
 *
 * This module adds the retention floor the adapter policy does not have: the
 * newest `minRetainImages` occurrences and every occurrence admitted within the
 * last `retainSteps` steps are never candidates. Selection always starts at the
 * oldest end, so the request prefix before the first modified message is
 * untouched and stays cacheable.
 *
 * @module @ksndjaks/dsh-image-budget-guard/select
 */
import type { RouteBudgetPolicy } from './config.js';
/** One image occurrence in model-request order. */
export interface ImageOccurrence {
    /** Current message-producing session event sequence. */
    readonly seq: number;
    /** Zero-based depth-first image index within that message, counting every occurrence. */
    readonly imageIndex: number;
    /** Durable normalized attachment identity. */
    readonly attachmentId: string;
    /** Represented request bytes for this route (base64 length for inline routes). */
    readonly bytes: number;
    /** Whether the surface already projects this occurrence to its placeholder. */
    readonly offloaded: boolean;
    /** Whether this occurrence was admitted within the retained recent-step window. */
    readonly recent: boolean;
}
/** One message's selected occurrence indexes, strictly increasing. */
export interface OffloadTarget {
    readonly seq: number;
    readonly imageIndexes: number[];
}
/** Why a decision did or did not select occurrences. */
export type SelectionReason = 
/** The retained payload already fits the route budget. */
'within-budget'
/** Nothing is eligible: every occurrence is protected or already omitted. */
 | 'no-candidates'
/** Occurrences were selected and the budget now fits. */
 | 'selected'
/** Every eligible occurrence was selected and the budget still does not fit. */
 | 'exhausted-candidates';
/** Complete outcome of one planning pass. */
export interface SelectionResult {
    readonly targets: readonly OffloadTarget[];
    /** Retained (not yet offloaded) occurrences the request would carry before this decision. */
    readonly retainedCount: number;
    /** Represented bytes those retained occurrences contribute before the decision. */
    readonly payloadBytes: number;
    /** Retained occurrences left after the decision. */
    readonly retainedAfter: number;
    /** Represented bytes left after the decision. */
    readonly payloadAfterBytes: number;
    /** Occurrences the decision omits. */
    readonly removedCount: number;
    /** Occurrences eligible for this decision (oldest end, unprotected). */
    readonly candidateCount: number;
    /** Whether the budget fits after the decision. */
    readonly budgetSatisfied: boolean;
    readonly reason: SelectionReason;
}
/** Budget fields the planner needs from a resolved route policy. */
export type SelectionBudget = Pick<RouteBudgetPolicy, 'dimension' | 'maxBytes' | 'maxImages' | 'minRetainImages' | 'quanta'>;
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
export declare function planImageOffload(occurrences: readonly ImageOccurrence[], budget: SelectionBudget): SelectionResult;
/** Base64 length of raw bytes, including padding; the inline wire representation. */
export declare function base64Length(bytes: number): number;
//# sourceMappingURL=select.d.ts.map