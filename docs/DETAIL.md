# Image budget guard

A DSH session log is append-only, so every model request re-sends the whole history. Images are cheap in tokens and expensive in bytes: a 1920×1080 screenshot costs at most ~1024 visual tokens but roughly 0.7 MB of request body, so a long session grows the body into the tens of megabytes while token-based compaction is still far from its threshold.

This plugin replaces the oldest images with placeholder text **before** the request is assembled, until the request fits its budget:

- **Proactive** — no failed request and no retry; the request is already smaller.
- **Two budgets** — an inline route bounds both bytes and image count; a Files route bounds the count only.
- **Retention floors** — the newest occurrences and everything admitted in the last few steps are never omitted.
- **Replayable** — the decision is an `image/offload` event in the session log, so restarts, restores, and forks behave identically.

## Two settings worth reading first

- **`mistralImageLimit`** — Mistral rejects the 21st image even when the body is only a few MiB. When enabled, routes whose provider is named `mistral` cap at 20 images; other providers are unaffected.
- **`dryRun`** — logs what would be omitted without writing an event or changing the request. A good first step on an image-heavy session.

Omission is irreversible: an omitted image stays a placeholder for the rest of the session. See the repository README for the full configuration and tuning.
