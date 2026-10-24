# Observing `image-budget-guard`

This guide shows how to confirm, from evidence rather than from configuration,
that the guard is doing what `docs/DESIGN.md` promises:

1. over-budget image history produces durable `image/offload` events whose
   positions are the oldest eligible occurrences;
2. the retained request payload fits `maxRequestImageBytes` (inline route) or
   `maxRequestImages` (Files route) whenever the eligible set can reach it;
3. `IMAGE_OFFLOAD_REQUIRED` never fires and image-related `llm/retry` events stay
   at zero;
4. measured request bodies stay bounded in the lab and, optionally, on the wire.

Everything here is read-only. The one exception is the optional proxy in §5.2,
which temporarily edits the `llm-pi-ai` row of the profile patch layer and must
be reverted.

## 1. Where the evidence lives

| Source | Location | What it proves |
| --- | --- | --- |
| Session log | `$DSH_HOME/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd` | the durable `image/offload` record, retries, turn errors, request routes |
| Process log | stdout/stderr of the `dsh web` process | the guard's own decisions: `offloaded`, `dry-run-summary`, warnings |
| Lab recording | `test/integration.test.mjs` + `test/helpers/fake-pi-gateway.mjs` | exact HTTP bodies, base64 totals, zero adapter refusal |
| Wire capture | temporary logging proxy (§5.2) | real end-to-end request-body sizes |
| Offline replay | `pnpm replay` → `docs/reports/replay.md`, `docs/reports/replay-series.json` | before/after per-step payload on the reference session |

### 1.1 Session-log shape

The session log is zstd-compressed JSON Lines:

- **line 1** is the `session` header record (`{"type":"session","version":4,...}`),
  not an event;
- **every following line** is one event, in order, with contiguous `seq` from 0:
  `{"type": "<event>", "seq": <n>, "time": <ms>, "data": {...}}`.

`image/offload` is a log-only durable event. Its `data` payload is exactly:

```json
{"targets":[{"seq":51,"imageIndexes":[0]},{"seq":101,"imageIndexes":[2,3]}]}
```

`seq` is the message-producing event's sequence (a `user/message` or a
`tool/result`), and `imageIndexes` are zero-based depth-first image positions
inside that message, strictly increasing. The guard never edits the message
event; the projection registered for `image/offload` folds this record into the
derived request. That is why the decision survives replay and fork.

The workspace slug is the workspace path with `/` replaced by `-`, wrapped in
`--` (for example `/home/me/src/app` becomes `--home-me-src-app--`):

```text
$DSH_HOME/sessions/<workspace-slug>/
```

Session directories are named after the session id (some are `session-<uuid>`,
some are the bare `<uuid>`); the `*/session.v4.jsonl.zstd` glob covers both.

### 1.2 Process-log shape

The plugin writes one JSON object per line through `ctx.logger`, prefixed with
`[image-budget-guard] `; the first JSON field is always `severity`:

```text
2026-10-24T02:00:00.000Z info [image-budget-guard] {"severity":"info","event":"offloaded",...}
```

The prefix and any harness-added timestamp/level are outside the JSON. Extract
the JSON with `sed -n 's/^.*\[image-budget-guard\] //p'` (see §4).

Cordis maps `error` / `info` / `warn` / `debug` to levels 0 / 1 / 2 / 3, and the
harness's default log exporter (configured with no level, so its threshold is 1)
accepts only `error` and `info`. The plugin therefore chooses the *channel* so
that every record at severity `info`, `warn`, or `error` is captured without
extra configuration, and carries the real severity inside the JSON. No
warn-or-above record is ever routed to a channel the default exporter drops:

| record `severity` | logger channel | level | captured by the default exporter? |
| --- | --- | --- | --- |
| `error` | `error` | 0 | yes |
| `warn` | `info` | 1 | yes |
| `info` | `info` | 1 | yes |
| `debug` | `debug` | 3 | no — opt-in only |

`logLevel` filters records before they are emitted (`silent` < `error` < `warn` <
`info` < `debug`), so the default `info` shows error, warn, and info records.
Raising `logLevel` to `debug` is **not** enough to see debug records: the
exporter's level must also accept level 3. The documented evidence path is
therefore the session log (`image/offload` events) plus the info/warn records
below — never the debug lines.

If the app was started in a terminal, redirect its output the next time you
restart (the command is from `docs/setup.md` §5):

```bash
dsh web > /tmp/dsh-web.log 2>&1
```

## 2. Session-log queries

Set the log path once. Replace the session id with the one you are auditing (or
pick the newest one for this workspace):

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
SLUG='--home-me-src-app--'          # your workspace slug
ls -lt "$DSH_HOME/sessions/$SLUG"/*/session.v4.jsonl.zstd | head

SID='<session-id>'                  # pick one from the listing above
LOG="$DSH_HOME/sessions/$SLUG/$SID/session.v4.jsonl.zstd"
zstd -dc "$LOG" > /tmp/session.jsonl
```

The worked example in this section is the reference session from
`docs/DESIGN.md` §6.3. Point `LOG` at that session's stored log:

```bash
LOG="$DSH_HOME/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd"
zstd -dc "$LOG" > /tmp/session.jsonl
wc -l /tmp/session.jsonl          # example: 1532
```

### 2.1 Count `image/offload` events and their targets

```bash
# number of durable offload events
tail -n +2 /tmp/session.jsonl | jq -c 'select(.type=="image/offload")' | wc -l

# every offloaded position: event seq -> target message seq + image indexes
tail -n +2 /tmp/session.jsonl \
  | jq -r 'select(.type=="image/offload")
           | .seq as $event
           | .data.targets[]
           | "event=\($event) messageSeq=\(.seq) imageIndexes=\(.imageIndexes | join(","))"'

# total number of omitted image occurrences
tail -n +2 /tmp/session.jsonl \
  | jq -s '[.[] | select(.type=="image/offload") | .data.targets[] | .imageIndexes | length] | add // 0'
```

The reference session (pre-guard) prints `0` for the first and third commands
and nothing for the second — it contains no `image/offload` event. In a guarded
session the count must be at least one per over-budget surface change, and every
`messageSeq` must be the `seq` of a `user/message` or `tool/result` event:

```bash
# cross-reference one selected target with the message it points at
tail -n +2 /tmp/session.jsonl | jq -c 'select(.seq==51) | {type, attachmentCount: ([.data.content // .data.message.content // [] | .[] | select(.type=="image")] | length)}'
```

The selected positions are always a oldest-first prefix of the eligible
occurrences: hot rows are `minRetainImages` (newest 6 by default) and everything
admitted in the last `retainSteps` steps (12 by default). If a target looks
"recent", compare it with the `step/start` boundary:

```bash
# step boundaries in the log (most recent last); the guard counts step/start
# events back from the tail, regardless of turn number
tail -n +2 /tmp/session.jsonl \
  | jq -r 'select(.type=="step/start") | "\(.seq)\tturn \(.data.turn) step \(.data.step)"' | tail -5
```

### 2.2 Whole-log image inventory

Useful to know how much image history a session carries before blaming the
guard:

```bash
# total image occurrences (all user/message + tool/result events)
jq -s '[.[] | select(.type=="user/message" or .type=="tool/result")
        | (.data.content // .data.message.content // [])[]
        | select(.type=="image")] | length' /tmp/session.jsonl      # 66 in the reference session

# unique attachments behind those occurrences
jq -s '[.[] | select(.type=="user/message" or .type=="tool/result")
        | (.data.content // .data.message.content // [])[]
        | select(.type=="image") | .attachment.attachmentId] | unique | length' /tmp/session.jsonl   # 53

# messages that carry at least one image
jq -s '[.[] | select(.type=="user/message" or .type=="tool/result")
        | {seq, n: ([ (.data.content // .data.message.content // [])[] | select(.type=="image") ] | length)}
        | select(.n > 0)] | length' /tmp/session.jsonl
```

This counts logged occurrences, not the current request surface: the surface is
the subset the session log's `surfaceOp` bookkeeping still exposes. For the
exact per-step surface measurement, use the replay report (§5.3).

### 2.3 Confirm zero `IMAGE_OFFLOAD_REQUIRED` and no image retries

`IMAGE_OFFLOAD_REQUIRED` is the pi-ai adapter's refusal code. If it escapes the
reactive path, it is recorded as a failed turn in `turn/end`
(`data.reason.kind == "error"`, `data.reason.error.code`) and appears in the
error message; the guard also logs an `image-offload-required-observed` line on
`agent/request-error`. Count all three:

```bash
# 1. any occurrence anywhere in the decoded session log (must be 0)
grep -c 'IMAGE_OFFLOAD_REQUIRED' /tmp/session.jsonl || true

# 2. failed turns and their codes (must print nothing for this code)
tail -n +2 /tmp/session.jsonl \
  | jq -r 'select(.type=="turn/end" and .data.reason.kind=="error")
           | "\(.data.reason.error.code)\t\(.data.reason.error.message)"'

# 3. retry events, grouped by failure code
tail -n +2 /tmp/session.jsonl \
  | jq -r 'select(.type=="llm/retry") | .data.failure.code' | sort | uniq -c
```

What to expect:

- `IMAGE_OFFLOAD_REQUIRED` count: **0**.
- `llm/retry` grouped by code: **no `IMAGE_OFFLOAD_REQUIRED` row**. Other codes
  can still appear; they are unrelated to images. The reference session, for
  example, logs 19 retries (11 `SERVER` + 8 `TRANSPORT`) with zero image
  refusals; they are provider and transport failures. The guard does not (and
  cannot) prevent those.

If `IMAGE_OFFLOAD_REQUIRED` does appear, it means a request reached the adapter
with more retained image bytes than `maxRequestImageBytes` — see §6 and the
`reason` table in §7 (usually `no-candidates` or `exhausted-candidates`).

### 2.4 Confirm the route and the request headers

The guard runs against the exact `(provider, model)` the loop resolved, which is
the same pair recorded in `request/header`:

```bash
tail -n +2 /tmp/session.jsonl \
  | jq -r 'select(.type=="request/header") | "\(.data.header.config.provider)/\(.data.header.config.model)"' \
  | sort | uniq -c
```

The output lists counts per `provider/model`. The reference session uses both
`example-provider/example-model` and its `-fast` variant.

The shipped row's `perRoute` entry only matches
`example-provider/example-model`. A session on
`deepseek/deepseek-v4.1-flash-fast` is still guarded by the top-level
configuration but does not inherit that override; add a second `perRoute` entry
if the fast route needs a different budget.

## 3. Process-log queries

```bash
WEB_LOG=/tmp/dsh-web.log   # whatever file captures the `dsh web` output

# all guard lines, newest last
grep -F '[image-budget-guard]' "$WEB_LOG" | tail -20

# strip the logger prefix and keep the JSON payload
sed -n 's/^.*\[image-budget-guard\] //p' "$WEB_LOG" | jq -c .

# count decisions by event name
sed -n 's/^.*\[image-budget-guard\] //p' "$WEB_LOG" | jq -r '.event' | sort | uniq -c

# one line per written decision
sed -n 's/^.*\[image-budget-guard\] //p' "$WEB_LOG" \
  | jq -c 'select(.event=="offloaded") | {provider, model, eventSeq, payloadBytes, payloadAfterBytes, removedCount, retainedAfter, budgetSatisfied}'
```

All `info`/`warn`-severity records are captured by the default exporter; only
`severity: "debug"` records need an exporter that accepts level 3 (see §1.2).
The guard's per-process state (size cache, model-info cache, and the `warned`
set) resets when the app restarts. Two consequences for observation:

- `no-attachments-service` and `budget-unsatisfiable` are logged **once per
  process** per route; do not expect a line for every step.
- `offloaded`/`would-offload` are per-decision, so their counts track the number
  of over-budget surface changes, not the number of requests.

## 4. JSON log-line catalog

Every line is one compact JSON object whose first field is `severity`; `event`
discriminates the shape. The values below are illustrative; the field set and
field names are exact.

| `severity` | Events |
| --- | --- |
| `error` | `guard-failed` |
| `warn` | `estimate-failed`, `budget-unsatisfiable`, `decision-rejected`, `append-failed`, `model-resolution-failed`, `no-attachments-service`, `image-offload-required-observed` |
| `info` | `offloaded`, `would-offload`, `dry-run-summary` |
| `debug` | `route-not-image-capable`, `representation-probe-failed` |

Warn records are emitted on the `info` channel and errors on the `error`
channel, so every warn-or-above record is visible with the default exporter;
debug records require an exporter that accepts level 3 (§1.2).

### 4.1 `offloaded` (severity `info`) — one durable decision was written

```json
{"severity":"info","event":"offloaded","provider":"example-provider","model":"example-model","representation":"inline-base64","projection":"reused","policy":{"representation":"inline-base64","dimension":"bytes","maxBytes":6291456,"maxImages":null,"minRetainImages":6,"retainSteps":12,"quanta":4},"payloadBytes":7340032,"payloadAfterBytes":5242880,"retainedCount":24,"retainedAfter":20,"removedCount":4,"budgetSatisfied":true,"eventSeq":1042,"targets":[{"seq":51,"imageIndex":0,"attachmentId":"sha256:95d9c9e56163ad7ca2af87feed457f17e4226fab440d9f796ef268d527981662","bytes":65973}]}
```

| Field | Meaning |
| --- | --- |
| `provider`, `model` | the final route observed in `agent/request` |
| `representation` | `inline-base64` (bytes budget) or `files` (occurrence budget) |
| `projection` | `reused` when `compaction-image-offload` registered the projection, `registered` when this guard registered the identical definition |
| `policy` | the resolved budget: `maxBytes` / `maxImages` is `null` for the non-primary dimension; `dimension` says which one is enforced |
| `payloadBytes` | retained represented bytes **before** the decision (base64 length on inline routes) |
| `payloadAfterBytes` | represented bytes after removing `removedCount` occurrences |
| `retainedCount` / `retainedAfter` | non-offloaded occurrences before/after |
| `removedCount` | occurrences omitted by this decision |
| `budgetSatisfied` | whether the post-decision payload fits the primary budget |
| `eventSeq` | `seq` of the appended `image/offload` event (use it to find the record in the session log) |
| `targets` | flattened selected positions: `seq`, `imageIndex`, `attachmentId`, `bytes` (represented bytes of that occurrence) |

### 4.2 `would-offload` (severity `info`) — dry-run position

One line per selected position, emitted for every candidate the enabled decision
would omit:

```json
{"severity":"info","event":"would-offload","provider":"example-provider","model":"example-model","representation":"inline-base64","seq":51,"imageIndex":0,"attachmentId":"sha256:95d9c9e56163ad7ca2af87feed457f17e4226fab440d9f796ef268d527981662","bytes":65973}
```

### 4.3 `dry-run-summary` (severity `info`) — dry-run aggregate

```json
{"severity":"info","event":"dry-run-summary","provider":"example-provider","model":"example-model","policy":{"representation":"inline-base64","dimension":"bytes","maxBytes":6291456,"maxImages":null,"minRetainImages":6,"retainSteps":12,"quanta":4},"payloadBytes":7340032,"payloadAfterBytes":5242880,"retainedCount":24,"retainedAfter":20,"removedCount":4,"budgetSatisfied":true}
```

Same aggregate fields as `offloaded`, without `eventSeq`/`targets`/`projection`
(nothing was written). Use `payloadAfterBytes <= maxRequestImageBytes` as the
dry-run acceptance check.

### 4.4 `budget-unsatisfiable` (severity `warn`, once per route per process)

The budget is still over after all eligible occurrences were omitted, or nothing
was eligible at all:

```json
{"severity":"warn","event":"budget-unsatisfiable","provider":"example-provider","model":"example-model","policy":{"representation":"inline-base64","dimension":"bytes","maxBytes":6291456,"maxImages":null,"minRetainImages":6,"retainSteps":12,"quanta":4},"payloadBytes":8126464,"retainedCount":8,"reason":"no-candidates"}
```

`reason` is the plan reason: `no-candidates` (all protected/already offloaded)
or `exhausted-candidates` (everything eligible was removed, still over). In
both cases the guard deliberately protects the retention floor and lets the
adapter/`compaction-image-offload` handle the remainder.

Mode B (pi-ai defaults, no config-layer stopgap) is where this warning is
expected: each retained image is up to ~1 MiB encoded (~1.33 MiB base64), so a
6 MiB budget holds only ~4–5 images and the retention floor can exceed it. See
`README.md` "Deployment modes" and `docs/setup.md` §3 for the budget/floor
adjustment.

### 4.5 `estimate-failed` (severity `warn`)

`readImageRequest` or `imageRequestTarget` threw. No event is written and the
request continues unchanged:

```json
{"severity":"warn","event":"estimate-failed","provider":"example-provider","model":"example-model","representation":"inline-base64","error":"ENOENT: no such file or directory, open '$DSH_HOME/attachments/v1/objects/95/d9...'"}
```

### 4.6 `image-offload-required-observed` (severity `warn`, bypasses `logLevel`)

The adapter still refused a request. The reactive `compaction-image-offload`
path owns the recovery; the guard only observes:

```json
{"severity":"warn","event":"image-offload-required-observed","provider":"example-provider","turn":1,"step":57,"offloadImages":7,"message":"pi-ai request images exceed the 6291456-byte base64 bound; 7 more oldest occurrence(s) must be offloaded."}
```

`offloadImages` is the adapter's count of additional oldest occurrences it needs
(the `offloadImages` failure detail), or `null` when absent. This record is
emitted directly on the `info` channel on every occurrence and bypasses
`logLevel`.

### 4.7 `route-not-image-capable` (severity `debug`, not captured by default)

The resolved route's `inputModalities` is absent or excludes `image`:

```json
{"severity":"debug","event":"route-not-image-capable","provider":"example-provider","model":"example-model","modalities":["text"]}
```

A `perRoute[].imageCapable` override skips this probe.

### 4.8 `no-attachments-service` (severity `warn`, once per process)

No `attachments` service is mounted, so no image can be measured:

```json
{"severity":"warn","event":"no-attachments-service","provider":"example-provider","model":"example-model"}
```

### 4.9 `guard-failed` (severity `error`, bypasses `logLevel`)

An unexpected exception escaped `runGuard`. The request is returned unchanged:

```json
{"severity":"error","event":"guard-failed","error":"...","provider":"example-provider","model":"example-model"}
```

This is always a bug worth reporting; the step is never failed because of it.
It is emitted directly on the `error` channel and bypasses `logLevel`.

### 4.10 `decision-rejected` (severity `warn`)

Pre-append validation failed — the surface changed between planning and append,
or a target is no longer current:

```json
{"severity":"warn","event":"decision-rejected","provider":"example-provider","model":"example-model","reason":"target seq 51 is not a current surface node"}
```

`reason` here is a validation diagnostic string, not a `GuardDecision.reason`.

### 4.11 `append-failed` (severity `warn`)

`session.append("image/offload", ...)` threw; the session log is unchanged:

```json
{"severity":"warn","event":"append-failed","provider":"example-provider","model":"example-model","error":"..."}
```

### 4.12 `model-resolution-failed` (severity `warn`)

`llm.resolveModelInfo()` threw while checking image capability (cached as
unknown for this route):

```json
{"severity":"warn","event":"model-resolution-failed","provider":"example-provider","model":"example-model","error":"..."}
```

### 4.13 `representation-probe-failed` (severity `debug`, not captured by default)

`llm.listConfigurableProviders()` threw while inferring inline-vs-Files; the
route keeps the conservative `inline-base64` byte budget:

```json
{"severity":"debug","event":"representation-probe-failed","provider":"example-provider","error":"..."}
```

## 5. Measuring request-body size

### 5.1 Lab: fake gateway in the integration test (Mode B)

`test/integration.test.mjs` mounts the real `LlmRuntime`, the real
`LocalAttachmentStore`, and the real pi-ai adapter, but points the provider at
`http://127.0.0.1:<port>/v1` — the stub in
`test/helpers/fake-pi-gateway.mjs`. The test deliberately runs **Mode B**: the
three provider keys are omitted, so the adapter uses pi-ai's defaults
(`maxRequestImageBytes` 20 MiB, `requestImagePixelBudget` 4 MP,
`requestImageMaxBytes` 1 MiB), while the guard enforces its own 6 MiB budget.
The stub records the **exact JSON body** of every `POST /v1/responses`; the
test then asserts, from those recorded bodies:

- base64 image bytes per request are `<= 6291456` (`maxRequestImageBytes`);
- `IMAGE_OFFLOAD_REQUIRED` is never thrown or observed (zero);
- the newest `minRetainImages` attachments are still present as image data;
- the request prefix up to the first modified message is byte-identical across
  consecutive steps; and
- a control run without the guard trips `IMAGE_OFFLOAD_REQUIRED`, proving the
  assertion would catch a regression.

The scenario uses 24 images of 1280×800; each saved PNG is ~3.07 MB, the
adapter's 1 MiB per-image target re-encodes it to a ~730 KB request version
(~973 KB base64). The guard config pins `retainSteps: 0` on purpose: with the
default 12-step window, twelve ~973 KB occurrences (~11.7 MB) would be
protected and the 6 MiB budget would be mathematically unsatisfiable, so the
test exercises only the `minRetainImages` floor.

Run it:

```bash
cd <package-dir>
node --test test/integration.test.mjs
```

The stub computes per-body stats with `imagePayloadStats()` (image count and
summed base64 bytes), and the test prints one line per step plus a summary.
Expected tail of a passing run:

```text
[integration] unmitigated inline image payload = 23351040B base64 (22.27 MiB) across 24 occurrences
[integration] guarded step=01 decision=noop/within-budget removed=0 retained=1 bodyImages=1 bodyBase64=972536B
[integration] guarded step=07 decision=offloaded/selected removed=1 retained=6 bodyImages=6 bodyBase64=5836544B
...
[integration] newest-6 retained: shot-19.png, shot-20.png, shot-21.png, shot-22.png, shot-23.png, shot-24.png; 18 older occurrences are placeholders
[integration] control (no guard, below ceiling): recordedBodyBase64=19458648B (18.56 MiB) images=20
[integration] control (no guard): IMAGE_OFFLOAD_REQUIRED offloadImages=3 unguardedPayload=23351040B ceiling=20971520B recordedBodies=0
[integration] summary: guarded peakBodyBase64=5838744B at step=24 (budget 6291456B); unguardedRecordedBodyBase64=19458648B; unmitigatedPayload=23351040B (adapter ceiling 20971520B); offloadEvents=18; imageOffloadRequiredObserved=0
✔ image-budget guard keeps real pi-ai request bodies under 6 MiB while the unmitigated route fails
```

Read the numbers as: the unguarded 24-image surface is 22.27 MiB of base64
images (over the 20 MiB adapter default, so the control must fail), while the
guarded peak stays at 5,838,744 B (≈5.57 MiB; `5838744 < 6291456`), with 18
occurrences offloaded and the newest 6 retained. A failed size assertion prints the
offending step and its measured `bodyBase64`. The 24-image control deliberately
records **zero** HTTP bodies: pi-ai refuses with `IMAGE_OFFLOAD_REQUIRED` before
serializing. The separate 20-image control stays under the 20 MiB ceiling and
does produce one real wire body — 19,458,648 B (18.56 MiB) of base64 images,
3.1× the guard's 6 MiB budget — which is the "unmitigated but accepted" case.

This path is deterministic (fixed PNGs, local stub, no network) and is the
right place to reproduce a budget regression before touching a real profile.
For the real session's measured curves, see `docs/reports/replay.md` (§5.3).

### 5.2 Field: logging reverse proxy

Use this when you need real request sizes against the live provider. The proxy
passes every request through to `https://api.example.com` unchanged, logs the
byte length of each request body, and streams the response back (including SSE).

Save it as `/tmp/dsh-log-proxy.mjs`:

```js
// Minimal logging reverse proxy: records the exact HTTP request-body size of
// every model call and streams the upstream response back unchanged.
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UPSTREAM = process.env.UPSTREAM ?? 'https://api.example.com';
const PORT = Number(process.env.PORT ?? 8788);
const SAVE_DIR = process.env.SAVE_DIR; // optional: keep each request body on disk

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const url = UPSTREAM + req.url;
  if (SAVE_DIR !== undefined) {
    mkdirSync(SAVE_DIR, { recursive: true });
    writeFileSync(join(SAVE_DIR, `${Date.now()}-${process.pid}.json`), body);
  }
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    method: req.method,
    url,
    requestBytes: body.length,
  }));

  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return;
      responseHeaders[key] = value;
    });
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body !== null) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error(`proxy error: ${String(error)}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`logging proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
```

Run it with body capture:

```bash
rm -rf /tmp/dsh-bodies
UPSTREAM=https://api.example.com PORT=8788 SAVE_DIR=/tmp/dsh-bodies \
  node /tmp/dsh-log-proxy.mjs > /tmp/dsh-proxy.log 2>/tmp/dsh-proxy.err &
```

Keep stdout (`/tmp/dsh-proxy.log`) separate: it is pure JSON Lines. The banner
and any proxy errors go to `/tmp/dsh-proxy.err`.

Then, **temporarily**, point the profiled provider at it. Back up the profile
patch first, edit only the `baseURL` line of that provider in the `llm-pi-ai`
row:

```bash
PROFILE=cordis.patch.yml   # $DSH_HOME/profiles/<profile>/cordis.patch.yml
cp "$DSH_HOME/profiles/<profile>/$PROFILE" /tmp/$PROFILE.before-proxy
# providers.<provider>.baseURL:
#   before: https://<upstream>/provider/v1
#   during: http://127.0.0.1:8788/provider/v1
```

Restart `dsh web` (see `docs/setup.md` §5), run one image-heavy session, then
restore the profile and restart again:

```bash
cp "/tmp/$PROFILE.before-proxy" "$DSH_HOME/profiles/<profile>/$PROFILE"
```

Read the per-request sizes:

```bash
jq -r 'select(.requestBytes) | "\(.at) \(.requestBytes) bytes"' /tmp/dsh-proxy.log
```

Summarize image bytes in a saved body by summing every `data:image/...;base64,`
string (splitting on the comma removes the data-URL prefix, leaving the base64
length the guard budgets):

```bash
for f in /tmp/dsh-bodies/*.json; do
  printf '%s total=%s imageBase64=%s\n' \
    "$(basename "$f")" \
    "$(wc -c < "$f")" \
    "$(jq -r '.. | strings | select(startswith("data:image/")) | split(",")[1] | length' "$f" | awk '{s+=$1} END {print s+0}')"
done | tail -20
```

Under enforcement, `imageBase64` should stay `<= 6291456`. The total body size
is larger (text, tools, and JSON overhead); the guard bounds only the image
share. Remember to kill the proxy process and remove `/tmp/dsh-bodies` when
done — request bodies contain your prompts and image data.

> The proxy is observation-only: it must not rewrite bodies or headers, and the
> temporary `baseURL` edit must be reverted. While the override is active, all
> model traffic for `example-provider` goes through the local process.

### 5.3 Offline replay

`pnpm replay` reconstructs the reference session offline and writes the
per-step before/after series to `docs/reports/replay-series.json`, with the
narrative report in `docs/reports/replay.md`. It measures the represented
request version (via `attachments.readImageRequest` and
`llm.imageRequestTarget`, base64-expanded) on a temp `dshHome` whose
`attachments/v1` is symlinked to the real store and whose `cache` is empty, so
the measurement is deterministic and does not write your user cache. Use it for
trends across many steps; use §5.1/§5.2 to validate the exact bytes a given
build sends.

The report covers both deployment modes plus two tuned floors at the same 6 MiB
plugin budget:

| | A · mitigated | B · unmitigated | C · tuned floor (`retainSteps 0` / `minRetainImages 6`) | C2 · floor sweep (`retainSteps 4` / `minRetainImages 4`) |
| --- | --- | --- | --- | --- |
| Adapter ceiling | 6 MiB | 20 MiB | 20 MiB | 20 MiB |
| Peak payload before guard | 5.98 MiB | 17.06 MiB | 17.06 MiB | 17.06 MiB |
| Peak payload after guard | 5.98 MiB | 11.49 MiB | **5.96 MiB** | 10.29 MiB |
| Steps over the 6 MiB plugin budget | 0 → 0 | 138 → 11 | **138 → 0** | 138 → 3 |
| `image/offload` events emitted | 0 | 8 | 8 | 8 |
| Retention-floor steps left over budget | 0 | 11 | **0** | 3 |
| `IMAGE_OFFLOAD_REQUIRED` after guard (projected) | 0 | 0 | 0 | 0 |

Mode A stays a no-op because the profile's own stopgap already keeps the
unguarded peak (5.98 MiB) under the budget. In Mode B the unguarded body first
crosses 6 MiB at step 45 (6.05 MiB) and peaks at 17.06 MiB; the guard cuts the
peak to 11.49 MiB and keeps 127 of the 138 over-budget steps under the line.
The remaining 11 steps are the retention-floor case, still under the 20 MiB
adapter ceiling, so the adapter predicate reports `IMAGE_OFFLOAD_REQUIRED = 0`.

C (`retainSteps 0` / `minRetainImages 6`) meets the budget on the same session:
peak 5.96 MiB (37,072 B of headroom under 6,291,456 B), 0 unsatisfiable steps,
8 events, 0 projected adapter rejections; the least-relaxed floor in the sweep
that still meets 6 MiB is `retainSteps 1` / `minRetainImages 6` at the same
peak. This pass is session-specific: the 6-image floor fits only while those
six request versions average ≲786 KB encoded each. Cold-vs-warm replay is
roughly 7× faster for A/B and ~1.5× for C/C2 when the guard's estimate cache is
warm (one run; absolute wall time varies, the data series is deterministic). C2
(`retainSteps 4` / `minRetainImages 4`) still peaks at 10.29 MiB with 3
unsatisfiable steps: a protected compact-checkpoint message (seq 518, 11 images
/ 32.34 MiB raw) cannot be trimmed from inside the step window, so lower
`retainSteps` before `minRetainImages`. The report explicitly notes that this
sample never reaches the 20 MiB ceiling; do not extrapolate a failure the log
does not show.

## 6. What "working" looks like

Run these checks on a guarded session that went over budget:

| Check | Command | Pass |
| --- | --- | --- |
| A durable decision exists | §2.1 count | `>= 1` |
| Budget satisfied | process log `offloaded` / `dry-run-summary` | `budgetSatisfied: true` for at least one decision |
| Adapter never refused | §2.3 `IMAGE_OFFLOAD_REQUIRED` | `0` |
| No image retries | §2.3 retry codes | no `IMAGE_OFFLOAD_REQUIRED` row |
| Oldest-first ordering | §2.1 targets + §2.1 step boundary | no target is in the newest `minRetainImages` / last `retainSteps` |
| Replayable | decode the log after a restart/replay | the same `image/offload` records are present and the derived request is unchanged |

A `budget-unsatisfiable` warning with `budgetSatisfied: false` is not a failure
of the guard: it means the protected suffix alone exceeds the budget (for
example a single newly pasted batch of screenshots). That is exactly the case
the reactive path still owns.

## 7. Troubleshooting by `reason`

`reason` values come from `GuardDecision.reason` in `docs/DESIGN.md` §3. Noop
reasons return without writing an event; several are logged only at `debug`
severity (not captured by the default exporter) or not at all, so the absence
of a line is not evidence of a bug. The evidence path stays the session log and
the info/warn records.

| `reason` | Meaning | What to do |
| --- | --- | --- |
| `disabled` | `enabled: false` | set `enabled: true` and restart |
| `aborted` | the turn's signal was already aborted | nothing; the request is not being sent |
| `no-route` | resolved `provider`/`model` is empty | check the model-selection / default-model rows |
| `route-disabled` | `perRoute[].enabled: false` for this exact pair | remove the override or set it to `true` |
| `compaction-in-progress` | unmatched `compaction/start` (open transaction) | wait for `compaction/end`; the guard intentionally does not interleave |
| `no-images` | the current surface carries no image occurrence | nothing; text-only request |
| `no-attachments` | no `attachments` service mounted | mount `@deepseek-ai/dsh-attachment-local`; logged once per process |
| `route-not-image-capable` | model modalities absent or exclude `image` | if the route really accepts images, set `perRoute[].imageCapable: true` |
| `estimate-failed` | `readImageRequest` / `imageRequestTarget` threw | check attachment-store health and the `error` field; no event was written |
| `within-budget` | retained payload already fits | nothing; expected steady state |
| `no-candidates` | every occurrence is protected or already offloaded, still over | raise `maxRequestImageBytes`, lower `minRetainImages`/`retainSteps`, or split the batch; see `budget-unsatisfiable` |
| `selected` | a decision was written and the budget fits | success |
| `exhausted-candidates` | every eligible occurrence was removed, still over | lower the budget expectations or raise the budget; the adapter may still refuse |
| `stale-surface` | the decision failed pre-append validation | retry the step; a concurrent surface change raced the decision (logged as `decision-rejected`) |
| `append-failed` | `session.append` threw | check the session-log writer; the log is unchanged |
| `would-offload` | dry run reported positions, wrote nothing | expected while `dryRun: true` |

## 8. Rollout checklist

1. `dryRun: true`; confirm `would-offload` positions and a
   `dry-run-summary` with `payloadAfterBytes <= 6291456`.
2. Confirm zero `image/offload` events were written while `dryRun` was on.
3. Flip `dryRun: false`, restart, and repeat §6 on a new over-budget session.
4. Keep `enabled: false` as the rollback switch (see `docs/setup.md` §8).
