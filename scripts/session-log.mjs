#!/usr/bin/env node
/**
 * Decode, parse, and rebuild a DeepSeek Harness session log for offline replay.
 *
 * A DSH session log is JSONL (optionally zstd-compressed). Line 1 is the
 * `session` header record; every following line is one event whose `seq` starts
 * at 0 and increases contiguously. Reconstructing a session therefore needs
 * three steps, all exposed here so the replay and any future harness can share
 * exactly one parser:
 *
 *   1. {@link decodeSessionLog} — shell out to `zstd -dc` (no runtime dependency).
 *   2. {@link parseSessionLog} — validate the header and event envelope, keep
 *      the original records byte-for-byte.
 *   3. {@link rebuildSession} — `Session.create(id, events, header, 0,
 *      [imageOffloadProjection])`, the recipe from `docs/DESIGN.md` §6.3.
 *
 * There is also an incremental player. A replay cannot simply hand the whole
 * log to `Session.create` when it also runs the guard: guard decisions append
 * events, which shifts every later replay sequence number, so a later
 * event's `sourceEventSeqs` / replacement `surfaceOp` must be rewritten through
 * the original-seq → replay-seq map. {@link SessionPlayer} does that per event.
 *
 * @module image-budget-guard/scripts/session-log
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionSeq,
} from '@deepseek-ai/dsh-session';
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection';

/** Message-producing events whose log records carry surface placement metadata. */
export const SURFACE_EVENT_TYPES = Object.freeze(
  new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']),
);

/**
 * Projections required to rebuild a log that may contain `image/offload`.
 * `dsh-session` refuses to fold that event type without an interpreter, and
 * this one is the same definition the plugin and `compaction-image-offload` use.
 */
export const DEFAULT_PROJECTIONS = Object.freeze([imageOffloadProjection]);

/** Upper bound for one decompressed log (a 5 MB log expands to a few MB of JSON). */
const DECODE_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Read a session log and return its decompressed JSONL text.
 *
 * `.zstd`/`.zst` files go through the `zstd` CLI so the package keeps zero
 * runtime dependencies; any other suffix is read as plain UTF-8. The CLI is
 * invoked with `-dc -- <path>`, so a filename starting with `-` is still safe.
 *
 * @param {string} logPath - path to a `.jsonl`, `.jsonl.zstd`, or `.jsonl.zst` log.
 * @returns {string} the decoded JSONL text.
 * @throws when the path is missing, is not a regular file, or `zstd` fails.
 */
export function decodeSessionLog(logPath) {
  const stat = statSync(logPath);
  if (!stat.isFile()) throw new Error(`session log is not a regular file: ${logPath}`);
  if (/\.(?:zstd|zst)$/i.test(logPath)) {
    return execFileSync('zstd', ['-dc', '--', logPath], {
      maxBuffer: DECODE_MAX_BUFFER,
      encoding: 'utf8',
    });
  }
  return readFileSync(logPath, 'utf8');
}

/**
 * Parse decoded JSONL into the session header and its contiguous events.
 *
 * Only envelope-level facts are validated: the header must be a `session`
 * record at the current format version, every record must parse, and event
 * `seq` values must be `0..n-1` with no gaps. Payload-level validity is left to
 * `Session.create`, which is the authority on the event contract.
 *
 * @param {string} text - decoded log text.
 * @returns {{header: object, events: object[], recordCount: number, warnings: string[]}}
 * @throws when the log is empty, the header is not a v4 `session` record, or the
 *   event sequence is not contiguous.
 */
export function parseSessionLog(text) {
  const warnings = [];
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('session log is empty');
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`session log header is not JSON: ${error.message}`);
  }
  if (header?.type !== 'session') {
    throw new Error(`session log line 1 is ${JSON.stringify(header?.type)}, not a session header`);
  }
  if (header.version !== SESSION_FORMAT_VERSION) {
    // Translate-only policy: the installed harness understands exactly one
    // logical version. Refuse rather than guess at a newer log's semantics.
    throw new Error(
      `session log format v${header.version} is not supported by this harness (v${SESSION_FORMAT_VERSION})`,
    );
  }
  const events = [];
  for (let index = 1; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch (error) {
      throw new Error(`session log line ${index + 1} is not JSON: ${error.message}`);
    }
    const expected = index - 1;
    if (event.seq !== expected) {
      throw new Error(
        `session log line ${index + 1} has seq ${event.seq}, expected ${expected} (the log must be contiguous)`,
      );
    }
    if (typeof event.type !== 'string' || typeof event.time !== 'number' || event.data === undefined) {
      throw new Error(`session log line ${index + 1} has an invalid event envelope`);
    }
    if (event.ignorable === true) {
      warnings.push(`event seq ${event.seq} (${event.type}) is marked ignorable and was replayed anyway`);
    }
    events.push(event);
  }
  return { header, events, recordCount: lines.length, warnings };
}

/**
 * Rebuild a detached session from parsed records.
 *
 * This is the DESIGN §6.3 recipe verbatim: `Session.create(id, events, header,
 * 0, [imageOffloadProjection])`, where `0` is the inherited fork prefix length
 * (a standalone replay has none).
 *
 * @param {object} header - the log's `session` header record.
 * @param {object[]} events - contiguous events starting at seq 0.
 * @param {readonly object[]} [projections] - message projections required by the log.
 * @returns {import('@deepseek-ai/dsh-session').Session} the reconstructed session.
 */
export function rebuildSession(header, events, projections = DEFAULT_PROJECTIONS) {
  return Session.create(SessionId(header.id), events, header, 0, projections);
}

/**
 * Decode, parse, and rebuild one log in a single call.
 *
 * @param {string} logPath - path to the session log.
 * @param {{projections?: readonly object[]}} [options] - projection override.
 * @returns {{logPath: string, header: object, events: object[], recordCount: number,
 *   eventCount: number, session: object, warnings: string[]}}
 */
export function loadSessionLog(logPath, options = {}) {
  const text = decodeSessionLog(logPath);
  const { header, events, recordCount, warnings } = parseSessionLog(text);
  const session = rebuildSession(header, events, options.projections ?? DEFAULT_PROJECTIONS);
  return { logPath, header, events, recordCount, eventCount: events.length, session, warnings };
}

/**
 * Content array of a message-producing log record.
 *
 * `user/message` and `system/message` keep their content at `data.content`,
 * while `tool/result` and `assistant/message` wrap it in `data.message.content`.
 *
 * @param {object} event - one log event.
 * @returns {object[]|undefined} the content blocks, when the record has any.
 */
export function messageContent(event) {
  const data = event.data;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.message?.content)) return data.message.content;
  return undefined;
}

/** Throw with a stable message when an original sequence was never replayed. */
function requireSeq(seqMap, seq, what) {
  const mapped = seqMap.get(seq);
  if (mapped === undefined) {
    throw new Error(`${what} references seq ${seq}, which has not been replayed yet`);
  }
  return mapped;
}

/** Translate a log `surfaceOp` into the intent `Session.append()` accepts. */
function remapSurfaceOp(surfaceOp, seqMap) {
  if (surfaceOp === 'append' || surfaceOp === undefined) return 'append';
  if (surfaceOp?.op !== 'replace') {
    throw new Error(`unexpected surfaceOp ${JSON.stringify(surfaceOp)}`);
  }
  return {
    op: 'replace',
    startSeq: SessionSeq(requireSeq(seqMap, surfaceOp.startSeq, 'surfaceOp.startSeq')),
    endSeq: SessionSeq(requireSeq(seqMap, surfaceOp.endSeq, 'surfaceOp.endSeq')),
  };
}

/**
 * Translate the targets of a durable `image/offload` record.
 *
 * A rebuilt log can already contain offload decisions (the sample session does
 * not, but a guarded production log will). Their target seqs are original log
 * seqs, so they must follow the same map as every other reference.
 */
function remapOffloadData(data, seqMap) {
  if (!Array.isArray(data?.targets)) return data;
  return {
    ...data,
    targets: data.targets.map((target) => ({
      seq: SessionSeq(requireSeq(seqMap, target.seq, 'image/offload target')),
      imageIndexes: [...target.imageIndexes],
    })),
  };
}

/**
 * Replay one log's events into a live session, one record at a time.
 *
 * `Session.append` assigns fresh seq numbers, so an original seq is not the
 * replay seq. The player records the mapping and rewrites every reference that
 * must point at an earlier event: `surfaceOp` replacement windows and
 * `sourceEventSeqs` on message events, plus `image/offload` targets. Guard
 * events appended between log records consume replay seqs on their own; they
 * are never targets of other references, so no remapping is needed for them.
 */
export class SessionPlayer {
  /** @param {object} session - live session that receives the events. */
  constructor(session) {
    this.session = session;
    /** Original log seq → replay session seq. */
    this.seqMap = new Map();
  }

  /**
   * Append one parsed log event.
   * @param {object} event - the original log event.
   * @returns {object} the appended, freshly sealed event.
   */
  append(event) {
    const isSurface = SURFACE_EVENT_TYPES.has(event.type);
    const data = event.type === 'image/offload' ? remapOffloadData(event.data, this.seqMap) : event.data;
    let appended;
    if (isSurface) {
      const intent = { surfaceOp: remapSurfaceOp(event.surfaceOp, this.seqMap) };
      // Assistant messages embed their provider stream and forbid source refs.
      if (Array.isArray(event.sourceEventSeqs) && event.type !== 'assistant/message') {
        intent.sourceEventSeqs = event.sourceEventSeqs.map((seq) =>
          SessionSeq(requireSeq(this.seqMap, seq, 'sourceEventSeqs')),
        );
      }
      appended = this.session.append(event.type, data, intent);
    } else {
      appended = this.session.append(event.type, data);
    }
    if (this.seqMap.has(event.seq)) {
      throw new Error(`log seq ${event.seq} was replayed twice`);
    }
    this.seqMap.set(event.seq, appended.seq);
    return appended;
  }
}

/**
 * Aggregate the facts the replay report must re-verify, straight from the log.
 *
 * Nothing here is inferred from the session runtime: these are record counts,
 * so they can be compared with the numbers in the task brief independent of the
 * replay mechanics.
 *
 * @param {object[]} events - parsed log events.
 * @returns {object} record-level facts, including a type histogram and retry codes.
 */
export function collectSessionFacts(events) {
  const typeCounts = new Map();
  const retryCodes = new Map();
  const attachmentCounts = new Map();
  const imageOccurrencesByType = new Map();
  let stepStarts = 0;
  let imageOccurrences = 0;
  let rawImageBytes = 0;
  let compactionStarts = 0;
  let compactionEnds = 0;
  let imageOffloadEvents = 0;
  let largestImageMessage = null;

  for (const event of events) {
    typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
    switch (event.type) {
      case 'step/start':
        stepStarts += 1;
        break;
      case 'llm/retry': {
        const code = event.data?.failure?.code ?? 'UNKNOWN';
        retryCodes.set(code, (retryCodes.get(code) ?? 0) + 1);
        break;
      }
      case 'compaction/start':
        compactionStarts += 1;
        break;
      case 'compaction/end':
        compactionEnds += 1;
        break;
      case 'image/offload':
        imageOffloadEvents += 1;
        break;
      default:
        break;
    }
    const content = messageContent(event);
    if (content === undefined) continue;
    let messageImages = 0;
    let messageRawBytes = 0;
    for (const block of content) {
      if (block?.type !== 'image' || block.attachment === undefined) continue;
      messageImages += 1;
      messageRawBytes += block.attachment.bytes ?? 0;
      imageOccurrences += 1;
      rawImageBytes += block.attachment.bytes ?? 0;
      imageOccurrencesByType.set(event.type, (imageOccurrencesByType.get(event.type) ?? 0) + 1);
      const id = String(block.attachment.attachmentId);
      attachmentCounts.set(id, (attachmentCounts.get(id) ?? 0) + 1);
    }
    // The largest single message matters for the floor analysis: `retainSteps`
    // protects occurrences by owning event, so one batched paste can pin a whole
    // group of images inside the protected window at once.
    if (messageImages > 0 && (largestImageMessage === null || messageImages > largestImageMessage.images)) {
      largestImageMessage = {
        seq: event.seq,
        type: event.type,
        images: messageImages,
        rawBytes: messageRawBytes,
        source: event.data?.source?.kind ?? event.data?.message?.source?.kind ?? null,
      };
    }
  }

  const duplicated = [...attachmentCounts].filter(([, count]) => count > 1);
  const retryCount = [...retryCodes.values()].reduce((total, count) => total + count, 0);
  return {
    eventCount: events.length,
    stepStarts,
    imageOccurrences,
    imageOccurrencesByType: Object.fromEntries(imageOccurrencesByType),
    largestImageMessage,
    uniqueAttachments: attachmentCounts.size,
    duplicateAttachments: duplicated.length,
    duplicatedOccurrences: duplicated.reduce((total, [, count]) => total + count, 0),
    rawImageBytes,
    retryCount,
    retryCodes: Object.fromEntries([...retryCodes].sort(([a], [b]) => a.localeCompare(b))),
    compactionStarts,
    compactionEnds,
    imageOffloadEvents,
    typeCounts: Object.fromEntries([...typeCounts].sort((a, b) => b[1] - a[1])),
  };
}

/**
 * Locate every `step/start` record in the log.
 * @param {object[]} events - parsed log events.
 * @returns {{index: number, seq: number, turn: number, step: number}[]}
 */
export function stepStartRecords(events) {
  const records = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== 'step/start') continue;
    records.push({
      index,
      seq: event.seq,
      turn: event.data?.turn ?? 0,
      step: event.data?.step ?? 0,
    });
  }
  return records;
}

/** Convert bytes to MiB with two decimals, for report tables. */
export function toMiB(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}
