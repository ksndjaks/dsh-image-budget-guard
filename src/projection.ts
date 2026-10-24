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
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionSeq } from '@deepseek-ai/dsh-session';

/** The one durable event type this guard writes. */
export const IMAGE_OFFLOAD_EVENT = 'image/offload';

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
export function hasImageOffloadProjection(ctx: Context): boolean {
  return ctx.sessions.messageProjections.some((projection) => projection.type === IMAGE_OFFLOAD_EVENT);
}

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
export function ensureImageOffloadProjection(ctx: Context): ProjectionMode {
  if (hasImageOffloadProjection(ctx)) return 'reused';
  try {
    ctx.sessions.registerMessageProjection(imageOffloadProjection);
    return 'registered';
  } catch (error) {
    // A concurrent registration between the check and the call means the
    // projection exists after all; any other failure must reach the caller.
    if (hasImageOffloadProjection(ctx)) return 'reused';
    throw error;
  }
}

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
export function surfaceImageOccurrences(session: Session): SurfaceImageOccurrence[] {
  const occurrences: SurfaceImageOccurrence[] = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue;
    const message = session.deriveEventMessage(event);
    if (message === null) continue;
    let imageIndex = 0;
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      occurrences.push({
        seq,
        imageIndex,
        attachment: block.attachment,
        offloaded: block.offloaded === true,
      });
      imageIndex += 1;
    }
  }
  return occurrences;
}

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
export function validateOffloadTargets(
  session: Session,
  targets: readonly OffloadTargetShape[],
): string | undefined {
  if (targets.length === 0) return 'no targets';
  const nodes = new Set<number>(session.surface.nodes);
  const seen = new Set<number>();
  for (const target of targets) {
    if (seen.has(target.seq)) return `duplicate target seq ${target.seq}`;
    seen.add(target.seq);
    if (!nodes.has(target.seq)) return `target seq ${target.seq} is not a current surface node`;
    const event = session.eventAt(SessionSeq(target.seq));
    if (event === undefined) return `target seq ${target.seq} is not in the log`;
    if (event.type !== 'user/message' && event.type !== 'tool/result') {
      return `target seq ${target.seq} is ${event.type}, not user/message or tool/result`;
    }
    const message = session.deriveEventMessage(event);
    if (message === null) return `target seq ${target.seq} derives no message`;
    // Walk occurrences, not array offsets: `imageIndex` is the depth-first image
    // ordinal, and a message may interleave text and image blocks freely.
    const offloadedByIndex = new Map<number, boolean>();
    let ordinal = 0;
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      offloadedByIndex.set(ordinal, block.offloaded === true);
      ordinal += 1;
    }
    let previous = -1;
    for (const index of target.imageIndexes) {
      if (!Number.isSafeInteger(index) || index < 0) return `target seq ${target.seq} has a non-canonical image index`;
      if (index <= previous) return `target seq ${target.seq} image indexes are not strictly increasing`;
      if (!offloadedByIndex.has(index)) return `target seq ${target.seq} has no image index ${index}`;
      if (offloadedByIndex.get(index) === true) {
        return `target seq ${target.seq} image index ${index} is already offloaded`;
      }
      previous = index;
    }
  }
  return undefined;
}

/**
 * Append one durable omission decision.
 * @param session - session receiving the decision.
 * @param targets - validated decision payload.
 * @returns the appended event sequence.
 */
export function appendImageOffloadDecision(
  session: Session,
  targets: readonly OffloadTargetShape[],
): SessionSeq {
  const event = session.append(IMAGE_OFFLOAD_EVENT, {
    targets: targets.map((target) => ({
      seq: SessionSeq(target.seq),
      imageIndexes: [...target.imageIndexes],
    })),
  });
  return SessionSeq(event.seq);
}

/** Incremental fold of the durable compaction lock. */
interface CompactionFold {
  scannedThrough: number;
  active: boolean;
}

const compactionFolds = new WeakMap<Session, CompactionFold>();

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
export function isCompactionInProgress(session: Session): boolean {
  const end = session.seq;
  let fold = compactionFolds.get(session);
  if (fold === undefined) {
    fold = { scannedThrough: 0, active: false };
    compactionFolds.set(session, fold);
  }
  for (let seq = fold.scannedThrough; seq < end; seq += 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    // The compaction marker pair is owned by `@deepseek-ai/dsh-compaction`; this
    // guard only reads the documented log vocabulary and never writes it, so it
    // does not take a dependency on that service just to name the two events.
    const type: string = event.type;
    if (type === 'compaction/start') fold.active = true;
    else if (type === 'compaction/end') fold.active = false;
  }
  fold.scannedThrough = end;
  return fold.active;
}

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
export function recentStepBoundary(session: Session, retainSteps: number): number {
  if (retainSteps <= 0) return session.seq;
  let found = 0;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event?.type !== 'step/start') continue;
    found += 1;
    if (found === retainSteps) return seq;
  }
  return 0;
}
