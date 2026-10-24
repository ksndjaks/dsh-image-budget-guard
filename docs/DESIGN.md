# Design contract — `@ksndjaks/dsh-image-budget-guard`

This file is the frozen interface between the implementation (`src/`) and the
test/replay/documentation work. Read it before touching `test/`, `scripts/`, or
`docs/`.

## 1. Problem this package solves

DSH session logs are append-only and every agent step re-sends the whole derived
history. On an inline (`base64`) route, historical images are re-encoded and
re-uploaded every step **by byte count, not by token count**: a 1920×1080
screenshot costs at most 1024 visual tokens but ~0.7 MB of request payload. The
compaction threshold (tokens) therefore fires long after the HTTP body has
already grown into the 10–20 MB range, and the only existing byte backstop,
`compaction-image-offload`, fires only *after* the adapter rejects the request
with `IMAGE_OFFLOAD_REQUIRED` — one slow request, one failure, one retry each
time.

`image-budget-guard` makes the same durable decision **before** the request is
assembled: it records `image/offload` for the oldest occurrences until the
represented payload fits a configured budget, while always keeping the newest
`minRetainImages` occurrences and everything admitted in the last `retainSteps`
steps.

## 2. Harness facts the implementation relies on (verified against source)

| Fact | Source (installed package) |
| --- | --- |
| `agent/request` waterfall payload is `{agent, turn, step, signal}` and returns the final `LlmCallConfig`; listeners chain through `next()`. | `dsh-agent/lib/types/runtime-types.d.ts:327` |
| Model selection rewrites `provider`/`model` **inside** a listener that awaits `next()`. The outermost listener therefore sees the final route; a `pre-step` listener does not. | `dsh-agent/lib/index.js:173-195` |
| `step()` order is: `prepareRequest()` (→ `agent/request`) → `system/message` + `user/message` appends → `buildRequest()` → `session.deriveMessages()` → `llm.stream()`. | `dsh-agent-loop/lib/index.js:1039-1085` |
| `request/header` is appended by `buildRequest()` only; nothing may fake it. | `dsh-agent-loop/lib/index.js:1215-1245` |
| `image/offload` is a durable, log-only event: `{targets: [{seq, imageIndexes[]}]}`, targets must be current surface nodes of type `user/message`/`tool/result`, indexes strictly increasing, one target per seq. | `dsh-compaction-image-offload/lib/types/projection.d.ts:5-26` |
| Folding an `image/offload` event **requires** a registered message projection; without one `planSurfaceEvent()` throws. | `dsh-session/lib/index.js:440`, `dsh-session/lib/types/known-event-types.js:86-88` |
| `SessionStore.registerMessageProjection()` throws on a duplicate event type. | `dsh-session/lib/index.js:1729-1736` |
| `SessionStore.messageProjections` is the live borrowed array of registered definitions. | `dsh-session/lib/index.js:1719-1721` |
| `Session.surface.nodes` is the request order; `deriveEventMessage()` applies every committed projection; `deriveMessages()` feeds `buildRequest()`. | `dsh-session/lib/index.js:1672-1696` |
| A compaction transaction is an unmatched `compaction/start` (open lock) until `compaction/end`. | `dsh-compaction-basic/lib/index.js:706-727` (inspectCompactionEntryState) |
| Inline route budget accounting: `requiredImageOffload()` sums base64 length (`ceil(bytes/3)*4`) of retained occurrences oldest-first and removes whole prefix quanta. | `dsh-llm/lib/index.js:692-728` |
| The pi-ai adapter checks `requiredImageOffload(..., {representation:'base64', maxBytes: maxRequestImageBytes})` and throws `IMAGE_OFFLOAD_REQUIRED` before serializing. | `dsh-llm-pi-ai/lib/index.js:1397-1402` |
| Exact request-version bytes come from `attachments.readImageRequest(ref, llm.imageRequestTarget(provider, model, ref))`, which reuses the on-disk `request-images` cache keyed by `(attachmentId, target)`. | `dsh-attachment/lib/types/index.d.ts:122-129`, `dsh-attachment-local/lib/index.js:858-888` |
| Image capability is `LlmResolvedModelInfo.inputModalities`; absent means unknown. Text-only routes are converted to placeholder text by the runtime before dispatch. | `dsh-llm/lib/types/types.d.ts:184-198`, `dsh-llm/lib/index.js:2337` |
| No public adapter API states the request representation (inline vs Files); `LlmAdapter` exposes only `imageRequestTarget` + `imageRequestPricing`. | `dsh-llm/lib/types/index.d.ts:150-165` |
| DeepSeek's Messages adapter uploads through `/v1/files` and registers a configurable-provider entry whose `settingsNs` is its plugin row id (`llm-deepseek*`); pi-ai uses `llm-pi-ai`. | `dsh-llm-deepseek-api-key/lib/index.js:52-55`, `dsh-llm-pi-ai/lib/index.js:2864,2920` |

## 3. Public API (built to `dist/`)

`dist/index.js` exports:

```ts
export const name = 'image-budget-guard';
export const inject = ['sessions', 'llm'];
/** Zod 4 strict schema; cordis validates it through `~standard.validate`. */
export const Config: z.ZodObject<...>;
export function apply(ctx: Context, config: ImageBudgetGuardConfig): void;
export function createGuard(ctx: Context, config: ImageBudgetGuardConfig): Guard;
export function runGuard(state: GuardState, facts: GuardRequestFacts, resolved: LlmCallConfig): Promise<GuardDecision>;
export function planImageOffload(occurrences: readonly ImageOccurrence[], budget: SelectionBudget): SelectionResult;
export function base64Length(bytes: number): number;
export function resolveRouteBudget(config, provider, model, hint): RouteBudgetPolicy;
export function routeEnabled(config, provider, model): boolean;
export function routeCapabilityOverride(config, provider, model): boolean | undefined;
export function isCompactionInProgress(session): boolean;
export function recentStepBoundary(session, retainSteps): number;
export function surfaceImageOccurrences(session): SurfaceImageOccurrence[];
export function validateOffloadTargets(session, targets): string | undefined;
export function appendImageOffloadDecision(session, targets): number;
export function ensureImageOffloadProjection(ctx): 'reused' | 'registered';
export function hasImageOffloadProjection(ctx): boolean;
```

`dist/config.js`, `dist/select.js`, `dist/projection.js` are also exported
subpaths by `package.json`.

### `GuardDecision`

```ts
{
  action: 'noop' | 'offloaded' | 'would-offload';
  reason: string;              // stable machine code, see below
  provider?: string;
  model?: string;
  policy?: RouteBudgetPolicy;
  plan?: SelectionResult;
  eventSeq?: number;           // seq of the appended image/offload event
  selected?: { seq: number; imageIndexes: number[] }[];
}
```

Stable `reason` values:

| reason | meaning |
| --- | --- |
| `disabled` | `enabled: false` |
| `aborted` | turn signal already aborted |
| `no-route` | resolved provider/model empty |
| `route-disabled` | `perRoute[].enabled: false` for this pair |
| `compaction-in-progress` | unmatched `compaction/start` |
| `no-images` | surface carries no image occurrence |
| `no-attachments` | no `attachments` service mounted (logged once) |
| `route-not-image-capable` | modalities absent or exclude `image` |
| `estimate-failed` | `readImageRequest`/`imageRequestTarget` threw; **no** event written |
| `within-budget` | nothing to do |
| `no-candidates` | every occurrence is protected or already omitted, budget still over |
| `selected` | a decision was written and the budget fits afterwards |
| `exhausted-candidates` | every eligible occurrence omitted, budget still over |
| `stale-surface` | decision failed pre-append validation |
| `append-failed` | `session.append` threw; the log is unchanged |
| `would-offload` | dry run: positions logged, nothing written |

### `SelectionResult`

```ts
{
  targets: { seq: number; imageIndexes: number[] }[];
  retainedCount: number; payloadBytes: number;
  retainedAfter: number; payloadAfterBytes: number;
  removedCount: number; candidateCount: number;
  budgetSatisfied: boolean;
  reason: 'within-budget' | 'no-candidates' | 'selected' | 'exhausted-candidates';
}
```

## 4. Configuration semantics

```yaml
enabled: true                 # master switch
dryRun: false                 # log selected positions, write nothing
representation: auto          # auto | inline-base64 | files
maxRequestImageBytes: 6291456 # 6 MiB, inline base64 budget
maxRequestImages: 60          # Files route occurrence budget
minRetainImages: 6            # newest retained occurrences, never omitted
retainSteps: 12               # steps whose admitted images stay verbatim
quanta: 4                     # minimum occurrences per decision
perRoute:                     # exact (provider, model) overrides; later wins
  - provider: example-provider
    model: deepseek/deepseek-v4.1-flash
    maxRequestImageBytes: 6291456
logLevel: info                # silent | error | warn | info | debug
```

Rules:

- Unknown keys are rejected at load time (Zod `.strict()` through the Standard
  Schema interface cordis uses).
- `representation` selects the budget dimension: `inline-base64` → bytes;
  `files` → occurrence count. The non-primary budget is `Infinity`.
- `auto` resolves from `llm.listConfigurableProviders()`:
  `settingsNs /^llm-deepseek/` → `files`; `/^llm-pi-ai/` → `inline-base64`;
  anything else → `inline-base64` (conservative). `perRoute[].representation`
  beats both.
- `perRoute` matches on exact `provider` **and** `model`; a later entry for the
  same pair wins.
- `retainSteps` counts `step/start` events back from the tail, including the
  current step.

## 5. Invariants the tests must prove

1. **Budget**: after a guard pass, the represented payload (sum of base64
   lengths of retained occurrences, in the exact request version the adapter
   sends) is `<= maxRequestImageBytes` whenever the eligible set can reach it.
2. **Retention**: the newest `minRetainImages` retained occurrences are never
   included in a decision, nor is anything with `seq >= recentStepBoundary`.
3. **Oldest-first prefix**: selected occurrences are a prefix of the eligible
   sequence; no newer occurrence is selected while an older eligible one is not.
4. **Idempotency**: running twice over the same surface state appends at most
   one event; the second run is `within-budget` (or `no-candidates`) and writes
   nothing.
5. **Prefix stability**: JSON of the derived messages before the first modified
   message is byte-identical before and after a decision.
6. **Dry run**: `dryRun: true` writes no event and changes no derived message,
   but reports `seq + imageIndex + attachmentId + bytes` per selected position.
7. **No-op paths**: text-only route, missing `attachments`, open compaction,
   empty surface, assistant-only images → `noop`, no throw.
8. **No failures**: the guard never throws out of `runGuard` for expected
   operational problems, and never turns a step into an error.

## 6. Test harness recipes

### 6.1 Real session + fake services (unit / guard tests)

```js
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionSeq } from '@deepseek-ai/dsh-session';
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection';
import { ConfigSchema, createGuard } from '../dist/index.js';

const ctx = new Context();
new SessionStore(ctx);
ctx.sessions.registerMessageProjection(imageOffloadProjection);
const session = ctx.sessions.create('test');
session.append('step/start', { turn: 1, step: 1 });
session.append('user/message', msg, { surfaceOp: 'append' });
session.append('step/end', { turn: 1, step: 1 });
```

Services can be replaced for tests by defining `ctx.llm` / `ctx.attachments`
stand-ins **only if** the real service class is not needed; prefer the real
`LlmRuntime` + a fake `LlmAdapter` subclass (see §6.2) because capability
resolution and `imageRequestTarget` are part of the contract.

`package.json` dev-links `@deepseek-ai/dsh-attachment-local` and
`@deepseek-ai/dsh-llm-pi-ai` for the integration harness.

### 6.2 Fake pi-ai gateway

- Real `LlmRuntime`, real `PiAiAdapter` (mount `@deepseek-ai/dsh-llm-pi-ai`'s
  exported `apply` with `providers.testroute = {api:'openai-responses',
  baseURL:'http://127.0.0.1:<port>/v1', maxRequestImageBytes: 6291456,
  requestImagePixelBudget: 1048576, requestImageMaxBytes: 262144,
  apiKeyEnv: 'TEST_PI_KEY', models:[{id:'test-model', input:['text','image'],
  contextWindow: 1000000, maxTokens: 384000}]}`).
- Set `process.env.TEST_PI_KEY` before mounting.
- Real `LocalAttachmentStore` rooted at a temporary `dshHome`; create images with
  `sharp` (available as a transitive dep of attachment-local) or hand-built PNG
  buffers through `saveImage`.
- The stub server records every request body, returns a minimal SSE stream that
  the adapter accepts (mirror the adapter's expected chunk protocol; if that is
  impractical, assert at the body level by using `llm.stream` and tolerating a
  terminal `error` chunk after the body was received).
- Assertions: HTTP body base64 total <= budget; no `IMAGE_OFFLOAD_REQUIRED`
  anywhere; newest K attachment ids still present as image data; prefix bytes
  unchanged between two steps.

### 6.3 Replay of the real session

Sample: a recorded session log (`$DSH_HOME/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`;
1532 lines, 213 steps, 66 image occurrences, 53 unique attachments, 19
`llm/retry`, 8 compactions, 0 `image/offload`).

- First line is the `session` header, not an event; the rest are events with
  contiguous `seq` starting at 0.
- Reconstruct with `Session.create(id, events, header, 0, [imageOffloadProjection])`.
- Offline replay must isolate the attachment cache: build a temp home with
  `tmp/attachments/v1` symlinked to `$DSH_HOME/attachments/v1` and an empty
  `tmp/cache` so encoding is deterministic and the user cache is untouched.
- Per step: append `step/start` (from the log), run the guard decision for the
  surface as of that step **without** appending synthetic user messages, then
  measure the represented payload of the derived messages.
- Report: per-step curve (image count / estimated payload / whether an offload
  was emitted) for "before" (no guard) and "after" (guard), plus peak payload,
  emitted `image/offload` count, and the retry count observed in the original
  log.

## 7. Work split and write scopes

| Owner | Files |
| --- | --- |
| lead | `src/**`, `docs/DESIGN.md`, `scripts/link-peers.mjs`, `scripts/verify-profile.mjs`, `package.json`, `tsconfig*.json` |
| unit-tester | `test/select.test.mjs`, `test/guard.test.mjs`, `test/config.test.mjs` |
| integration-tester | `test/integration.test.mjs`, `test/helpers/**` |
| replay-analyst | `scripts/session-log.mjs`, `scripts/replay-session.mjs`, `docs/reports/**` |
| docs-writer | `README.md`, `README.zh.md`, `cordis.patch.yml`, `docs/observability.md`, `docs/setup.md` |

Do not edit another owner's files. Do not edit `src/`: report a needed change to
the lead instead. Do not add runtime dependencies (`zod` and the harness peers
are the only ones). Tests use `node:test` and must run with `pnpm test`.
