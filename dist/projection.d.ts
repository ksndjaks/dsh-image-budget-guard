/**
 * Durable `image/offload` plumbing and session-surface reads.
 *
 * The event shape, its validation, and its projection are owned by
 * `@deepseek-ai/dsh-compaction-image-offload`; this module never invents a
 * second record format. It only:
 *
 * 1. reuses the projection that plugin registered when it is mounted, and
 *    otherwise registers the *same* exported definition, because
 *    `dsh-session` refuses to fold an `image/offload` event without an
 *    interpreter (`MESSAGE_PROJECTION_EVENT_TYPES` → `planSurfaceEvent`), and
 * 2. appends one decision after validating it against the current surface.
 *
 * @module @ksndjaks/dsh-image-budget-guard/projection
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionSeq } from '@deepseek-ai/dsh-session';
/** The one durable event type this guard writes. */
export declare const IMAGE_OFFLOAD_EVENT = "image/offload";
/**
 * Decision shape this guard passes around.
 *
 * Deliberately a plain `number` seq: `select.ts` stays free of harness types and
 * the projection is the single place that brands a sequence for `Session.append`.
 */
export interface OffloadTargetShape {
    readonly seq: number;
    readonly imageIndexes: readonly number[];
}
/** How the projection this guard relies on became available. */
export type ProjectionMode = 'reused' | 'registered';
/** Whether an interpreter for `image/offload` is currently registered. */
export declare function hasImageOffloadProjection(ctx: Context): boolean;
/**
 * Make sure exactly one `image/offload` interpreter exists.
 *
 * Registration happens on first use rather than in `apply()` on purpose: the
 * mounted `compaction-image-offload` plugin registers the same definition, and
 * `SessionStore.registerMessageProjection()` throws on a duplicate type. Waiting
 * until the first decision means every plugin in the same boot wave has already
 * run `apply()`, so a mounted offload plugin always wins and this guard never
 * breaks its registration. The identical definition is used in both paths.
 *
 * @param ctx - plugin context owning the registration.
 * @returns which path was taken.
 */
export declare function ensureImageOffloadProjection(ctx: Context): ProjectionMode;
/** One image occurrence read from the current model-visible surface. */
export interface SurfaceImageOccurrence {
    readonly seq: number;
    readonly imageIndex: number;
    readonly attachment: ImageAttachmentRef;
    readonly offloaded: boolean;
}
/**
 * Read every image occurrence of the current request surface in request order.
 *
 * Assistant, system, and developer nodes are skipped: `image/offload` targets
 * only `user/message` and `tool/result` nodes (the projection rejects anything
 * else), and current adapters declare text-only output, so assistant images are
 * not a supported request input. Indexes count every occurrence of a message in
 * depth-first order, including occurrences already projected to placeholders.
 *
 * @param session - session whose surface defines the next request.
 * @returns occurrences oldest-first, exactly as `deriveMessages()` orders them.
 */
export declare function surfaceImageOccurrences(session: Session): SurfaceImageOccurrence[];
/**
 * Validate one decision against the current surface before appending it.
 *
 * A rejected decision becomes a logged no-op instead of a thrown append, so a
 * stale surface (a concurrent replacement, a fork boundary) can never fail the
 * model request.
 *
 * @param session - session the decision would apply to.
 * @param targets - candidate decision.
 * @returns undefined when valid, otherwise a stable diagnostic.
 */
export declare function validateOffloadTargets(session: Session, targets: readonly OffloadTargetShape[]): string | undefined;
/**
 * Append one durable omission decision.
 * @param session - session receiving the decision.
 * @param targets - validated decision payload.
 * @returns the appended event sequence.
 */
export declare function appendImageOffloadDecision(session: Session, targets: readonly OffloadTargetShape[]): SessionSeq;
/**
 * Whether a compaction transaction currently holds the session's durable lock.
 *
 * `compaction-basic` appends `compaction/start` before summarizing and exactly
 * one `compaction/end` afterwards; an unmatched start is the lock
 * (`inspectCompactionEntryState()` in that package). The fold consumes only new
 * events, so a step costs O(new events) after the first read.
 *
 * @param session - session to inspect.
 * @returns true while a compaction transaction is open.
 */
export declare function isCompactionInProgress(session: Session): boolean;
/**
 * First sequence number that belongs to the retained recent-step window.
 *
 * Walks back from the log tail and stops after `retainSteps` `step/start`
 * events, which makes the scan O(events in those steps) instead of O(log). The
 * current step counts as one of the retained steps; before any step exists the
 * boundary is 0, so every occurrence counts as recent and nothing is omitted.
 *
 * @param session - session to inspect.
 * @param retainSteps - steps whose admitted images stay verbatim.
 * @returns the inclusive sequence boundary, or `session.seq` when nothing is recent.
 */
export declare function recentStepBoundary(session: Session, retainSteps: number): number;
//# sourceMappingURL=projection.d.ts.map