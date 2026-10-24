# dsh-image-budget-guard

[中文](README.zh.md) · English

**Proactive image budget guard for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
It trims the oldest request images on the session surface *before* a model
request is assembled, so an inline base64 body never grows into the range that
makes requests slow, flaky, or rejected.

- [Why](#why) - [Features](#features) - [Install](#install) - [Configuration](#configuration) - [How it works](#how-it-works) - [Relationship to the compaction plugins](#relationship-to-the-compaction-plugins)
- [The durable record](#the-durable-record) - [Tuning](#tuning) - [Known limitations](#known-limitations) - [Measured](#measured) - [Development](#development) - [License](#license)

## Why

Have you run into this: the official DeepSeek API keeps latency low across long,
image-heavy tasks, while a third-party gateway (e.g. commandcode) gets slower as
the model handles more images — average first-token latency climbs, connections
fail more often, and 503s start showing up? This plugin exists to fix that.

The protocol decides how an image reaches the model, not the model quality. The
same upstream model is reached through two very different transports:

- **Official route** (`deepseek-official`, `@deepseek-ai/dsh-llm-deepseek`):
  each image is uploaded once to `/v1/files` and referenced by file id, and the
  budgets are byte- and count-based (`maxRequestFilesBytes` 128 MiB,
  `maxImagesPerRequest` 600 by default). The cost is one upload per new image
  (a 60 s per-image deadline), file ids expire after 7 days, and refreshing an
  upload replaces its id, which breaks prefix cache from that image onward.
- **Third-party gateway** (e.g. `commandcode`, `@deepseek-ai/dsh-llm-pi-ai`):
  there is no Files API, so images are inlined as base64 inside `messages` and
  every request re-encodes and re-uploads every retained image. The budgets are
  per-image `requestImagePixelBudget` (4 MP default) and
  `requestImageMaxBytes` (1 MiB default) plus a per-request
  `maxRequestImageBytes` (20 MiB base64 default) — and exceeding the request
  budget is failure-driven: assemble, reject with `IMAGE_OFFLOAD_REQUIRED`, and
  only then does `compaction-image-offload` drop the oldest images and retry.

| Aspect | Official (Files) | Third-party (inline) |
| --- | --- | --- |
| How images reach the model | Uploaded once, referenced by file id | Base64 inlined every turn |
| Bytes per request | Roughly independent of image count | Grows linearly with retained images |
| Budget | 128 MiB + 600 images | 20 MiB base64 (default) |
| On overflow | High-water batch eviction | Fail once, then evict and retry |
| Per-image cost | One upload (60 s/image), 7-day refresh | Re-encode and re-send every turn |
| Failure mode | Upload timeout or expiry → inline fallback | Large POST → 502/504/reset → `SERVER`/`TRANSPORT` retries |

This causes four classes of problems:

1. **History is append-only and replayed in full on every step.** An image costs
   every step, not once. A 1920×1080 screenshot is about 0.7 MB as a request
   version; twenty of them are about 14 MB raw and about 19 MB in base64.
2. **Tokens and bytes are different scales.** A single image is capped at 1024
   visual tokens, while compaction triggers on token pressure (about 550k tokens
   for a typical 1M-context, 384k-output configuration). The body can already be
   10–20 MB long before tokens come close to the threshold.
3. **Caching does not help the wire.** Even when the gateway reuses a server-side
   prefix, the base64 payload still has to be uploaded again; the Files route
   only trades bytes for ids.
4. **Retries amplify the problem.** Gateway body limits and proxy timeouts turn
   tens-of-megabytes POSTs into 502/504/connection resets, which DSH records as
   `SERVER`/`TRANSPORT` and retries with the same history — same bytes, stacked
   latency. The symptom is “it gets slower and flakier the longer the session
   runs”.

The official route has the same failure mode in disguise: when Files resolution
fails or times out it rebuilds the whole request inline from base64, which
degrades it to exactly the third-party behaviour. This plugin therefore covers
both: a byte budget for inline routes and a count guard for Files routes,
sharing the same `image/offload` events and replay semantics.

For reference: a 213-step image-heavy session on such a gateway accumulated 19
retries after step 50 (8×`TRANSPORT`, 11×`SERVER`); after tightening per-image
to 1 MP / 256 KiB and the request image cap to 6 MiB, the 20-image payload fell
from about 19 MB to about 4.6 MB — at the cost of downscaling and re-encoding
every image, which loses history fidelity. This plugin instead leaves per-image
quality alone and omits the oldest images.

## Features

- **Pre-request trimming.** Hooks the `agent/request` waterfall, measures the
  surface the request will be built from, and records one durable
  `image/offload` event for the oldest occurrences until the payload fits.
- **Retention floors.** The newest `minRetainImages` occurrences and every image
  admitted in the last `retainSteps` steps are never omitted, even when that
  leaves the budget unsatisfied (it is reported, not violated).
- **Per-route budget dimension.** Inline base64 routes use a byte budget;
  Files/reference routes use an occurrence budget; routes without image
  capability are a no-op.
- **Exact accounting.** Sizes come from the same request-image projection the
  adapter sends (`llm.imageRequestTarget()` + `attachments.readImageRequest()`),
  cached per request version, so a warm guard never re-encodes history.
- **Durable and replayable.** No hidden clipping state: the decision is a log
  event interpreted by the existing `image/offload` projection, and it replays,
  forks and survives restarts like any other session record.
- **Cache-friendly.** Only the oldest end is trimmed, so everything before the
  first modified message stays byte-identical between requests.
- **Never fails a turn.** Estimation errors, a missing projection, a stale
  surface or an adapter refusal all degrade to a structured no-op.

## Install

### npm registry install (not available yet)

```sh
dsh plugin --profile web add dsh-image-budget-guard
```

### Install from the GitHub repository

```sh
dsh plugin --profile web add github:ksndjaks/dsh-image-budget-guard
```

Or add it from the DSH plugin panel: paste this repository's URL and install.

The desktop app has not been tested yet.

Restart the profile afterwards. `<package-spec>` is an npm name, a git reference
(`github:<owner>/<repo>`), or a local path (`link:/absolute/path`). A local
checkout must be built once.

Supports DeepSeek Harness `0.2.1-rc.1` and `0.2.1-rc.2`
(peer range `>=0.2.1-rc.1 <=0.2.1`) and Node.js `>=22`.

## Configuration

Every field is optional; the values below are the schema defaults. The bundle's
shipped row sets `enabled`, `dryRun`, `maxRequestImageBytes`, `minRetainImages`,
`retainSteps`, `quanta` and `logLevel` explicitly — see
[`cordis.patch.yml`](cordis.patch.yml).

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` makes every request hook a no-op. |
| `dryRun` | `false` | Decide and log, but write no session event. |
| `representation` | `auto` | `auto` \| `inline-base64` \| `files`. Selects the budget dimension. |
| `maxRequestImageBytes` | `6291456` | Inline base64 route budget: accumulated encoded request bytes. |
| `maxRequestImages` | `60` | Files/reference route budget: represented image occurrences. |
| `minRetainImages` | `6` | Newest occurrences that are never omitted. |
| `retainSteps` | `12` | Images admitted in the last N steps are never omitted (`0` disables the window). |
| `quanta` | `4` | Minimum occurrences omitted per decision; fewer only when fewer are eligible. |
| `perRoute` | `[]` | Exact `(provider, model)` overrides; a later entry for the same pair wins. |
| `logLevel` | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug`. |

`perRoute[]` accepts `provider`, `model`, and any of `enabled`, `representation`,
`imageCapable`, `maxRequestImageBytes`, `maxRequestImages`, `minRetainImages`,
`retainSteps`, `quanta`.

Override the installed row from the profile layer instead of editing the
package:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: image-budget-guard
  config:
    dryRun: true
```

Unknown keys are rejected at load time: the exported `Config` is a strict Zod
schema and the launcher validates it through the Standard Schema interface.

## How it works

1. **Hook.** The guard listens on the `agent/request` waterfall with `prepend`
   and awaits `next()`. That is the only public seam that observes the final
   `(provider, model)` — model selection rewrites it inside the same waterfall —
   and it still runs before `buildRequest()` derives the surface, so an event
   appended here belongs to the request being built.
2. **Occurrences.** It walks the current surface in request order and collects
   every image occurrence of `user/message` and `tool/result` nodes, counting
   indexes depth-first and including occurrences already projected to
   placeholders. Assistant nodes are excluded: `image/offload` targets input
   nodes only, and current adapters declare text-only output.
3. **Sizing.** For each retained occurrence it resolves the route's
   `imageRequestTarget` and reads the exact request version through the
   attachment store, summing base64 length (inline) or occurrence count (Files).
4. **Selection.** It removes a prefix of the eligible occurrences, oldest first,
   at least `quanta` at a time, stopping as soon as the budget fits. The newest
   `minRetainImages` occurrences and everything inside `retainSteps` are
   protected; already-omitted occurrences are never selected again.
5. **Record.** One `image/offload` event with `{ targets: [{ seq, imageIndexes }] }`.
   Every route then sends the standard placeholder text for those occurrences;
   message identities and node ids are untouched.

Nothing else is written. In particular the request header stays owned by the
agent loop, and the guard never rewrites the adapter's own image policy.

## Relationship to the compaction plugins

| Plugin | Trigger | What it does |
| --- | --- | --- |
| `compaction-basic` | token pressure before a step or on context overflow | Summarizes and replaces a surface range. |
| `compaction-image-offload` | adapter failure `IMAGE_OFFLOAD_REQUIRED` | Records `image/offload` for the oldest occurrences and retries. |
| **this plugin** | every request, before assembly | Records the same `image/offload` decision proactively. |

They compose rather than compete:

- The guard writes the same event type and reuses the projection that
  `compaction-image-offload` registers. If that plugin is not mounted, the guard
  registers the same definition itself on first use — `dsh-session` refuses to
  fold an `image/offload` event without an interpreter.
- Occurrences already projected as placeholders are skipped, so the two paths
  never omit the same position twice.
- While a compaction transaction is open (an unmatched `compaction/start`), the
  guard does not select or write anything: it lets compaction change the surface
  first.

## The durable record

```jsonc
// image/offload — log-only, no surface operation
{ "targets": [ { "seq": 1497, "imageIndexes": [0] } ] }
```

- `seq` is a current message-producing event (`user/message` or `tool/result`).
- `imageIndexes` are strictly increasing depth-first image indexes within that
  message, counting already-omitted occurrences.
- The message node and its id are unchanged; only the projected content changes.
- The event is validated before it is appended and the same decision over an
  unchanged surface writes nothing (idempotent). Replay, restore and fork apply
  it through the registered projection, so a restarted process re-derives the
  same placeholders.

## Tuning

- **Budget below the adapter ceiling.** Keep `maxRequestImageBytes` at or below
  the adapter's own limit. `llm-pi-ai` defaults to 20 MiB per request; a guard
  budget of 6 MiB therefore acts long before the adapter would refuse.
- **Size the floors against the per-image cost.** Rule of thumb:
  `maxRequestImageBytes >= minRetainImages × perImageBase64`, plus whatever the
  `retainSteps` window admits. On an inline route that re-encodes at ~1 MiB per
  image, one decoded image is ~1.33 MiB base64, so six retained images are
  ~8 MiB — raise the budget or lower the floor.
- **`retainSteps` protects whole messages.** Every image admitted in a recent
  step is protected with it, so a single pasted batch of N images pins N
  occurrences at once. If a budget still cannot be met, reduce `retainSteps`
  first (`0` keeps only the `minRetainImages` floor), then `minRetainImages`,
  then raise the budget.
- **Files routes** (`dsh-llm-deepseek` `/v1/files`) count occurrences, not bytes;
  set `perRoute[].representation: files` if the automatic detection cannot prove
  the representation.
- When the budget is unreachable the guard logs `budget-unsatisfiable` once per
  route and model, and keeps the floor. It never omits a protected occurrence.

## Known limitations

- **Omission is irreversible.** An omitted occurrence stays a placeholder for the
  rest of the session; the attachment itself is untouched and still readable
  through the normalized path in the placeholder text.
- **Prompt-cache reuse ends at the first modified message.** Trimming from the
  oldest end keeps the prefix stable, but the first trimmed node breaks byte
  equality from that point on.
- **Per-step cost is O(surface nodes).** Reading the surface is linear, and the
  derived-message cache is rebuilt whenever the content generation changes —
  which a decision causes. Negligible against serializing megabytes, non-zero on
  very long sessions.
- **Files routes budget occurrences, not bytes**, because the provider receives
  references rather than inline data.
- **Representation auto-detection is a heuristic.** The adapter API exposes
  request geometry and pricing but not whether bytes travel inline or through a
  Files endpoint; `auto` reads the configurable-provider directory and falls
  back to the conservative inline byte budget. `perRoute` is the escape hatch.
- **A single message that alone exceeds the budget cannot be fixed at the
  protection floor.** With `minRetainImages: 6`, a batch of six maximal images
  is retained by design; lower the floor or raise the budget.
- **It does not prevent non-image failures.** Transport and server retries are
  outside its scope.

## Measured

An offline replay of a recorded 213-step session (66 image occurrences over 53
unique attachments, 8 compaction transactions) at a 6 MiB guard budget:

| Scenario | Peak before | Peak after | `image/offload` | Adapter refusals |
| --- | --- | --- | --- | --- |
| inline route, per-image target 256 KiB, adapter ceiling 6 MiB | 5.98 MiB | 5.98 MiB (no-op) | 0 | 0 |
| inline route, per-image target 1 MiB, adapter ceiling 20 MiB, `retainSteps 12` | 17.06 MiB | 11.49 MiB¹ | 8 | 0 |
| inline route, per-image target 1 MiB, adapter ceiling 20 MiB, `retainSteps 0` | 17.06 MiB | **5.96 MiB** | 8 | 0 |

¹ The retention floor, not the budget, is binding on this image-dense session:
with `minRetainImages 6` and a 12-step window the protected suffix alone is
11.49 MiB. Every guarded pass keeps the projected `IMAGE_OFFLOAD_REQUIRED`
count at zero.

A local fake gateway wired to the real `llm-pi-ai` adapter reproduces the same
behaviour: with the adapter at its defaults, 24 screenshots produce a
22.27 MiB payload and an `IMAGE_OFFLOAD_REQUIRED` refusal without the guard, and
peak at 5.84 MiB with it. The full report and per-step series live in
[`docs/reports/replay.md`](docs/reports/replay.md).

## Development

```sh
pnpm install          # dev dependencies (typescript, @types/node)
pnpm build            # links harness peers, then tsc -> dist/
pnpm test             # packaging + selection + guard + integration (node:test)
pnpm replay           # offline replay -> docs/reports/
pnpm verify:profile   # bundle registration, layer composition, live mount
```

`scripts/link-peers.mjs` symlinks the harness packages from the installed
`@deepseek-ai/dsh` into this package's `node_modules`, so a `link:`-installed
plugin shares the one module instance per package with the running harness
instead of loading a second copy. `DSH_PACKAGE_DIR` overrides the detected
installation.

```
src/config.ts       strict Zod schema, per-route policy resolution
src/select.ts       pure selection algorithm
src/projection.ts   image/offload plumbing and session-surface reads
src/index.ts        the agent/request hook and the plugin entry
```

## License

MIT
