/**
 * Packaging contract: installing this package must be all a user has to do.
 *
 * A DSH plugin becomes a profile layer by declaring
 * `"dsh": { "bundle": { "patch": ... } }`. After `dsh plugin --profile <p> add
 * <package>` succeeds, the plugin manager's `reconcile()` reads exactly that
 * field, validates every declared patch file with `loadOverlayPatches()`, and
 * appends the package name to `dsh.profile.bundles`
 * (`@deepseek-ai/dsh-plugin-manager/lib/index.js:322-350`). The launcher then
 * applies the layer in `dsh.profile.bundles` order
 * (`@deepseek-ai/dsh-app-boot/lib/index.js:490-505`).
 *
 * This test pins that contract against the same validator the installer uses,
 * so a manifest or patch edit that would break install-time auto-registration
 * fails `pnpm test` instead of the user's install.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundlePatchPaths, evaluatePluginCompatibility, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';

import { ConfigSchema } from '../dist/index.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

test('package declares a dsh bundle patch layer', () => {
  assert.equal(typeof manifest.dsh, 'object', 'package.json must declare dsh.bundle');
  const bundle = manifest.dsh.bundle;
  assert.ok(bundle !== undefined, 'dsh.bundle must be present');
  assert.ok(
    typeof bundle.patch === 'string' || Array.isArray(bundle.patch),
    'dsh.bundle.patch must be a path or a list of paths',
  );
  const paths = bundlePatchPaths(PACKAGE_ROOT, bundle);
  assert.ok(paths.length >= 1, 'at least one patch file must be declared');
  for (const file of paths) {
    assert.ok(existsSync(file), `declared bundle patch is missing: ${file}`);
  }
});

test('the bundle patch ships with the package', () => {
  const bundle = manifest.dsh.bundle;
  const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch;
  for (const relative of declared) {
    const normalized = relative.replace(/^\.\//, '');
    assert.ok(
      Array.isArray(manifest.files) && manifest.files.includes(normalized),
      `"${normalized}" must be listed in package.json#files so a packed install keeps the layer`,
    );
  }
});

test('the patch layer validates with the installer parser and inserts the guard row', () => {
  const [patchPath] = bundlePatchPaths(PACKAGE_ROOT, manifest.dsh.bundle);
  const patches = loadOverlayPatches('dsh', patchPath);
  assert.ok(Array.isArray(patches) && patches.length >= 1, 'the layer must be a nonempty patch list');

  const inserted = patches.flatMap((patch) => patch.insert ?? []);
  const ours = inserted.filter((entry) => entry.id === 'image-budget-guard');
  assert.equal(ours.length, 1, 'the layer must insert exactly one image-budget-guard row');
  assert.equal(ours[0].name, manifest.name, 'the row name must be the package name');
  assert.ok(ours[0].config !== undefined, 'the row must carry a configuration');

  // Unknown keys would be rejected by the loader at activation; catch them here.
  const validation = ConfigSchema['~standard'].validate(ours[0].config);
  assert.equal(validation.issues, undefined, `shipped config must be valid: ${JSON.stringify(validation.issues)}`);
  assert.equal(validation.value.enabled, true);
  assert.equal(validation.value.dryRun, false);
  assert.ok(validation.value.maxRequestImageBytes > 0);
  assert.ok(validation.value.minRetainImages >= 0);
  assert.ok(validation.value.retainSteps >= 0);
});

test('the layer touches nothing but its own row', () => {
  const [patchPath] = bundlePatchPaths(PACKAGE_ROOT, manifest.dsh.bundle);
  const patches = loadOverlayPatches('dsh', patchPath);
  for (const patch of patches) {
    assert.deepEqual(
      Object.keys(patch).sort(),
      ['insert'],
      'a bundle layer must only insert rows; overrides belong to the profile layer',
    );
    for (const entry of patch.insert ?? []) {
      assert.equal(entry.disabled, undefined, `${entry.id} must not disable another row`);
      assert.equal(entry.group, undefined, `${entry.id} must not restructure other rows`);
    }
  }
});

test('declares the verified dsh support matrix', () => {
  // The harness checks `engines.dsh` first and only falls back to dsh peers
  // (`unmetRequirements()` in @deepseek-ai/dsh-app-boot). rc.1, rc.2 and rc.3
  // were each verified against this package; the 0.2.1 release is included
  // because the same sources are published for it, while 0.2.2 must be
  // re-verified before it is admitted.
  for (const runtime of ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1']) {
    assert.equal(
      evaluatePluginCompatibility(manifest, {}, runtime),
      undefined,
      `manifest must be compatible with dsh ${runtime}`,
    );
  }
  for (const runtime of ['0.2.0', '0.2.2-rc.1', '0.1.10']) {
    assert.notEqual(
      evaluatePluginCompatibility(manifest, {}, runtime),
      undefined,
      `manifest must reject unverified dsh ${runtime}`,
    );
  }
});

test('the built entry points exist and resolve as ESM', () => {
  const main = join(PACKAGE_ROOT, manifest.main);
  assert.ok(existsSync(main), `main is missing: ${manifest.main}`);
  const exportsRoot = manifest.exports['.'];
  assert.equal(exportsRoot.default, './dist/index.js');
  assert.ok(existsSync(join(PACKAGE_ROOT, exportsRoot.default)));
  assert.ok(existsSync(join(PACKAGE_ROOT, exportsRoot.types)));
});
