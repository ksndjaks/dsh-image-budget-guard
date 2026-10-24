# Installing `dsh-image-budget-guard`

The package is a native DSH bundle: installing it is the only step. There is no
manual `cordis.patch.yml` edit, and nothing is written outside the profile's own
package manager state.

## Requirements

- DeepSeek Harness `0.2.1-rc.1`, `0.2.1-rc.2` or `0.2.1-rc.3` (anything in `>=0.2.1-rc.1 <=0.2.1`).
- Node.js `>=22`.
- `pnpm` on `PATH` (`dsh plugin` runs it for you).
- A built `dist/` when installing from a local checkout (`pnpm build`).

## Install

Pick the spec that matches where the package lives:

```sh
# a published package
dsh plugin --profile web add @scope/dsh-image-budget-guard

# a git repository; it must ship the built dist/ or declare a prepare script
dsh plugin --profile web add github:<owner>/<repo>

# a local checkout
dsh plugin --profile web add link:/absolute/path/to/dsh-image-budget-guard
```

Restart the profile afterwards (`web` reloads its patch layer live, but a new
package is only picked up on the next boot).

### What happens on install

1. `dsh plugin` runs `pnpm add <spec>` inside
   `$DSH_HOME/profiles/<profile>/`.
2. The plugin manager's `reconcile()` sees the new dependency, reads its
   `package.json#dsh.bundle`, validates every declared patch file, and appends
   the package name to `dsh.profile.bundles`.
3. On the next boot the launcher applies the bundle's layer, which inserts the
   `image-budget-guard` row.

A package that declares no `dsh.bundle` is installed as a plain dependency and
the CLI prints:

```
dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

That warning means the install did **not** create a profile layer; use a package
and version that ship the bundle declaration.

## Verify

```sh
# the row and its config must appear in the composed tree
dsh --profile web --dump-config | grep -A14 'image-budget-guard'

# from the package checkout: bundle registration, layer composition, live mount
cd /absolute/path/to/dsh-image-budget-guard
pnpm verify:profile
```

`pnpm verify:profile` prints four lines and exits non-zero if any fails:

```
PASS link: resolution        — the built entry resolves from a profile-shaped node_modules
PASS bundle auto-registration — manifest + patch parse; the row auto-registers on install
PASS patch/composition       — the layer composes over the real web profile with no new stderr
PASS runtime mount           — cordis activates the plugin and one decision reaches the log
```

At runtime the plugin logs `[image-budget-guard] {"severity":...}` lines; see
[observability.md](observability.md) for the record shapes and the session-log
queries.

## After a DSH upgrade

A plugin version pins the DSH releases it was verified against. When DSH is
upgraded and the installed plugin no longer matches, the launcher skips the whole
bundle with:

```
dsh: skipping profile bundle "@scope/dsh-image-budget-guard": Error: Plugin ... is incompatible with dsh <version>: requirements {...}
```

The plugin is inactive until it is reinstalled at a version that declares the new
runtime. Pull the current repository state and reinstall:

```sh
dsh plugin --profile web remove @scope/dsh-image-budget-guard
dsh plugin --profile web add github:<owner>/<repo>
```

`dsh --profile web --dump-config` should then list the `image-budget-guard` row
again with no `skipping profile bundle` line.

## Configure

The bundle ships a working row. Override it from the profile layer instead of
editing the package:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: image-budget-guard
  config:
    dryRun: true          # observe first, write nothing
    retainSteps: 4        # narrow the verbatim window
    perRoute:
      - provider: my-provider
        model: my-vision-model
        maxRequestImageBytes: 4194304
```

Recommended rollout:

1. `dryRun: true`, use the session normally for a few image-heavy turns.
2. Read the `would-offload` / `dry-run-summary` lines (or the replay report for
   the expected sizes).
3. Set `dryRun: false` and restart.

## Uninstall and rollback

```sh
dsh plugin --profile web remove @scope/dsh-image-budget-guard
```

Removal drops the dependency; the next `dsh plugin` run reconciles the bundle
list and the row disappears. Two faster options stop the behaviour without
touching the install:

- `enabled: false` in the row's config — every hook becomes a no-op.
- `dryRun: true` — decisions are logged, nothing is written.

Already-written `image/offload` events stay in old session logs and keep
replaying through the same projected placeholders, so removing the plugin never
corrupts history. The messages simply show the placeholder text from then on.

## Local development install

```sh
cd /absolute/path/to/dsh-image-budget-guard
pnpm install            # dev dependencies only
pnpm build              # runs link-peers, then tsc
dsh plugin --profile web add link:$PWD
```

`pnpm build`/`pnpm test` run `scripts/link-peers.mjs` first. It finds the
installed harness (`$DSH_PACKAGE_DIR`, `npm root -g`, or a platform default) and
symlinks the peer packages into this package's `node_modules`:

```
node_modules/@deepseek-ai/cordis              -> <harness>/node_modules/@deepseek-ai/cordis
node_modules/@deepseek-ai/dsh-llm             -> <harness>/node_modules/@deepseek-ai/dsh-llm
...
```

Why symlinks: a `link:`-installed plugin is resolved through its real path, so
Node loads its `@deepseek-ai/*` imports from the package directory, not from the
profile. Symlinking keeps one module instance per package — the same `Context`,
the same service graph — while preserving the harness version the profile booted.
The script is idempotent (`0 linked, N already current`).

Set `DSH_PACKAGE_DIR` when the script cannot find the installation:

```sh
DSH_PACKAGE_DIR=/path/to/node_modules/@deepseek-ai/dsh node scripts/link-peers.mjs
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `--dump-config` has no `image-budget-guard` row | package installed without `dsh.bundle`, or the profile was not restarted | check the install warning; reinstall with a package that declares the bundle |
| `dsh: patch: entry "image-budget-guard" not found` in the profile layer | an override targets the row before the bundle layer supplies it | update the bundle or remove the override |
| Plugin inactive, `cannot get required service` in logs | `sessions` or `llm` is not mounted in this profile | mount a profile that provides both |
| `skipping profile bundle ... is incompatible with dsh <version>` | the installed plugin version does not declare support for this runtime | reinstall/update the plugin (see “After a DSH upgrade”) |
| No `image/offload` events and no log lines | route has no image capability, no images on the surface, or `enabled: false` | check `reason` codes in [observability.md](observability.md) |
| `budget-unsatisfiable` on every image-heavy step | retention floor exceeds the budget | reduce `retainSteps`/`minRetainImages` or raise `maxRequestImageBytes` (see README “Tuning”) |
