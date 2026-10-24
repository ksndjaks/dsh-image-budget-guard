/**
 * Configuration schema and route-resolution tests (`dist/config.js`).
 *
 * The schema is validated by the Harness loader through the Standard Schema
 * interface (`ConfigSchema['~standard'].validate`), so these tests exercise
 * both the plain `.parse()` path and that interface: a typo must be a load-time
 * rejection, never a silently ignored key (DESIGN.md §4).
 *
 * Run: `node --test test/config.test.mjs` (from the package root, after `pnpm build`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigSchema,
  resolveRouteBudget,
  routeCapabilityOverride,
  routeEnabled,
} from '../dist/config.js';

/** Parse a raw config, failing the test on an unexpected rejection. */
function parsed(raw = {}) {
  return ConfigSchema.parse(raw);
}

/** Assert a raw config is rejected, and return the first issue. */
function rejected(raw) {
  const result = ConfigSchema.safeParse(raw);
  assert.equal(result.success, false, `expected ${JSON.stringify(raw)} to be rejected`);
  return result.error.issues[0];
}

test('defaults: every field is optional and defaulted', () => {
  const config = parsed();

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.representation, 'auto');
  assert.equal(config.maxRequestImageBytes, 6 * 1024 * 1024, '6 MiB inline budget');
  assert.equal(config.maxRequestImages, 60);
  assert.equal(config.minRetainImages, 6);
  assert.equal(config.retainSteps, 12);
  assert.equal(config.quanta, 4);
  assert.deepEqual(config.perRoute, []);
  assert.equal(config.logLevel, 'info');
});

test('defaults: an empty object and an explicit undefined both produce the defaults', () => {
  assert.deepEqual(parsed({}), parsed({ perRoute: undefined }));
});

test('defaults: a partial config keeps defaults for omitted fields', () => {
  const config = parsed({ dryRun: true, maxRequestImageBytes: 1024 });
  assert.equal(config.dryRun, true);
  assert.equal(config.maxRequestImageBytes, 1024);
  assert.equal(config.minRetainImages, 6, 'unrelated defaults survive');
  assert.equal(config.logLevel, 'info');
});

test('strict: unknown top-level keys are rejected', () => {
  const issue = rejected({ nope: 1 });
  assert.equal(issue.code, 'unrecognized_keys');
  assert.deepEqual(issue.keys, ['nope']);
});

test('strict: unknown perRoute keys are rejected', () => {
  const issue = rejected({ perRoute: [{ provider: 'p', model: 'm', nope: 1 }] });
  assert.equal(issue.code, 'unrecognized_keys');
  assert.deepEqual(issue.keys, ['nope']);
  assert.deepEqual(issue.path, ['perRoute', 0]);
});

test('strict: the Standard Schema interface rejects unknown keys too', () => {
  // This is the path cordis uses at load time (`~standard.validate`), so the
  // rejection has to happen here and not only in `.parse()`.
  const standard = ConfigSchema['~standard'];
  assert.equal(typeof standard?.validate, 'function');

  const bad = standard.validate({ nope: 1 });
  assert.ok(bad.issues !== undefined, 'a rejected load reports issues');
  assert.equal(bad.issues[0].code, 'unrecognized_keys');
  assert.deepEqual(bad.issues[0].keys, ['nope']);

  const good = standard.validate({ dryRun: true });
  assert.equal(good.issues, undefined);
  assert.equal(good.value.dryRun, true);
  assert.equal(good.value.enabled, true);
});

test('strict: nested unknown keys inside an otherwise valid perRoute entry are rejected', () => {
  const issue = rejected({
    perRoute: [
      { provider: 'p', model: 'm', enabled: true },
      { provider: 'q', model: 'n', quanta: 2, typo: 'x' },
    ],
  });
  assert.equal(issue.code, 'unrecognized_keys');
  assert.deepEqual(issue.path, ['perRoute', 1]);
});

test('bad values: non-positive byte and image budgets are rejected', () => {
  for (const raw of [{ maxRequestImageBytes: 0 }, { maxRequestImageBytes: -1 }, { maxRequestImages: 0 }]) {
    const issue = rejected(raw);
    assert.equal(issue.code, 'too_small', `${JSON.stringify(raw)} must be too small`);
  }
});

test('bad values: non-integer numeric budgets are rejected', () => {
  for (const raw of [
    { maxRequestImageBytes: 1.5 },
    { maxRequestImages: 2.5 },
    { minRetainImages: 1.5 },
    { retainSteps: 0.5 },
    { quanta: 1.5 },
  ]) {
    assert.equal(rejected(raw).code, 'invalid_type', `${JSON.stringify(raw)} must be rejected`);
  }
});

test('bad values: negative retention fields are rejected', () => {
  assert.equal(rejected({ minRetainImages: -1 }).code, 'too_small');
  assert.equal(rejected({ retainSteps: -1 }).code, 'too_small');
  // Zero is legal for both retention knobs: it disables the corresponding floor.
  assert.equal(parsed({ minRetainImages: 0, retainSteps: 0 }).minRetainImages, 0);
});

test('bad values: quanta must be positive', () => {
  assert.equal(rejected({ quanta: 0 }).code, 'too_small');
  assert.equal(rejected({ quanta: -3 }).code, 'too_small');
});

test('bad values: non-boolean switches and unknown enum members are rejected', () => {
  assert.equal(rejected({ enabled: 'yes' }).code, 'invalid_type');
  assert.equal(rejected({ dryRun: 1 }).code, 'invalid_type');
  assert.equal(rejected({ representation: 'raw' }).code, 'invalid_value');
  assert.equal(rejected({ logLevel: 'trace' }).code, 'invalid_value');
});

test('bad values: an empty provider or model in perRoute is rejected', () => {
  assert.equal(rejected({ perRoute: [{ provider: '', model: 'm' }] }).code, 'too_small');
  assert.equal(rejected({ perRoute: [{ provider: 'p', model: '' }] }).code, 'too_small');
  assert.equal(rejected({ perRoute: [{}] }).code, 'invalid_type');
});

test('bad values: perRoute must be an array', () => {
  assert.equal(rejected({ perRoute: { provider: 'p', model: 'm' } }).code, 'invalid_type');
});

test('perRoute: every documented override key is accepted', () => {
  const config = parsed({
    perRoute: [
      {
        provider: 'commandcode',
        model: 'deepseek/deepseek-v4.1-flash',
        enabled: false,
        representation: 'inline-base64',
        imageCapable: true,
        maxRequestImageBytes: 1024,
        maxRequestImages: 5,
        minRetainImages: 0,
        retainSteps: 0,
        quanta: 1,
      },
    ],
  });
  assert.equal(config.perRoute.length, 1);
  assert.equal(config.perRoute[0].provider, 'commandcode');
  assert.equal(config.perRoute[0].imageCapable, true);
});

test('resolveRouteBudget: inline-base64 hint selects the byte dimension', () => {
  const config = parsed({ maxRequestImageBytes: 4096, maxRequestImages: 7 });
  const policy = resolveRouteBudget(config, 'p', 'm', 'inline-base64');

  assert.equal(policy.provider, 'p');
  assert.equal(policy.model, 'm');
  assert.equal(policy.representation, 'inline-base64');
  assert.equal(policy.dimension, 'bytes');
  assert.equal(policy.maxBytes, 4096);
  assert.equal(policy.maxImages, Number.POSITIVE_INFINITY, 'the non-primary budget is unbounded');
  assert.ok(Object.isFrozen(policy), 'the resolved policy is frozen');
});

test('resolveRouteBudget: files hint selects the count dimension', () => {
  const config = parsed({ maxRequestImageBytes: 4096, maxRequestImages: 7 });
  const policy = resolveRouteBudget(config, 'p', 'm', 'files');

  assert.equal(policy.representation, 'files');
  assert.equal(policy.dimension, 'count');
  assert.equal(policy.maxImages, 7);
  assert.equal(policy.maxBytes, Number.POSITIVE_INFINITY);
});

test('resolveRouteBudget: auto falls back to the conservative inline byte budget', () => {
  const config = parsed({ representation: 'auto' });
  const policy = resolveRouteBudget(config, 'p', 'm', undefined);

  assert.equal(policy.representation, 'inline-base64');
  assert.equal(policy.dimension, 'bytes');
});

test('resolveRouteBudget: a configured representation beats the hint', () => {
  const inline = parsed({ representation: 'inline-base64' });
  assert.equal(resolveRouteBudget(inline, 'p', 'm', 'files').representation, 'inline-base64');
  assert.equal(resolveRouteBudget(inline, 'p', 'm', 'files').dimension, 'bytes');

  const files = parsed({ representation: 'files' });
  assert.equal(resolveRouteBudget(files, 'p', 'm', 'inline-base64').representation, 'files');
  assert.equal(resolveRouteBudget(files, 'p', 'm', 'inline-base64').dimension, 'count');
});

test('resolveRouteBudget: perRoute representation beats the global setting and the hint', () => {
  const config = parsed({
    representation: 'files',
    perRoute: [{ provider: 'p', model: 'm', representation: 'inline-base64' }],
  });
  const policy = resolveRouteBudget(config, 'p', 'm', 'files');

  assert.equal(policy.representation, 'inline-base64');
  assert.equal(policy.dimension, 'bytes');
  assert.equal(policy.maxBytes, config.maxRequestImageBytes, 'the byte budget comes from the global default');
});

test('resolveRouteBudget: perRoute matches on both provider and model', () => {
  const config = parsed({
    perRoute: [{ provider: 'p', model: 'm', maxRequestImageBytes: 111 }],
  });

  assert.equal(resolveRouteBudget(config, 'p', 'm', 'inline-base64').maxBytes, 111);
  assert.equal(
    resolveRouteBudget(config, 'p', 'other-model', 'inline-base64').maxBytes,
    config.maxRequestImageBytes,
    'a different model on the same provider does not inherit the override',
  );
  assert.equal(
    resolveRouteBudget(config, 'other-provider', 'm', 'inline-base64').maxBytes,
    config.maxRequestImageBytes,
    'a different provider with the same model does not inherit the override',
  );
});

test('resolveRouteBudget: perRoute last-wins for the same pair', () => {
  const config = parsed({
    perRoute: [
      { provider: 'p', model: 'm', maxRequestImageBytes: 111, minRetainImages: 1, quanta: 2, retainSteps: 3 },
      { provider: 'p', model: 'm', maxRequestImageBytes: 222, minRetainImages: 4, quanta: 5, retainSteps: 6 },
    ],
  });
  const policy = resolveRouteBudget(config, 'p', 'm', 'inline-base64');

  assert.equal(policy.maxBytes, 222);
  assert.equal(policy.minRetainImages, 4);
  assert.equal(policy.quanta, 5);
  assert.equal(policy.retainSteps, 6);
});

test('resolveRouteBudget: last-wins is per field, not an object merge', () => {
  // The later entry sets only one field; the earlier entry's other fields do
  // not survive, because the later entry is the matching override.
  const config = parsed({
    perRoute: [
      { provider: 'p', model: 'm', maxRequestImageBytes: 111, quanta: 9 },
      { provider: 'p', model: 'm', maxRequestImageBytes: 222 },
    ],
  });
  const policy = resolveRouteBudget(config, 'p', 'm', 'inline-base64');

  assert.equal(policy.maxBytes, 222);
  assert.equal(policy.quanta, config.quanta, 'the later entry replaces the earlier override entirely');
});

test('resolveRouteBudget: the override budget for the non-primary dimension is ignored', () => {
  const config = parsed({
    maxRequestImages: 10,
    perRoute: [{ provider: 'p', model: 'm', maxRequestImages: 3, maxRequestImageBytes: 5 }],
  });

  const inline = resolveRouteBudget(config, 'p', 'm', 'inline-base64');
  assert.equal(inline.maxBytes, 5, 'byte override applies on an inline route');
  assert.equal(inline.maxImages, Number.POSITIVE_INFINITY);

  const files = resolveRouteBudget(config, 'p', 'm', 'files');
  assert.equal(files.maxImages, 3, 'count override applies on a files route');
  assert.equal(files.maxBytes, Number.POSITIVE_INFINITY);
});

test('resolveRouteBudget: retention and quanta inherit from the global config', () => {
  const config = parsed({ minRetainImages: 2, retainSteps: 5, quanta: 3 });
  const policy = resolveRouteBudget(config, 'p', 'm', 'inline-base64');

  assert.equal(policy.minRetainImages, 2);
  assert.equal(policy.retainSteps, 5);
  assert.equal(policy.quanta, 3);
});

test('routeEnabled: true by default and false only for a matched enabled:false', () => {
  assert.equal(routeEnabled(parsed(), 'p', 'm'), true);

  const disabled = parsed({ perRoute: [{ provider: 'p', model: 'm', enabled: false }] });
  assert.equal(routeEnabled(disabled, 'p', 'm'), false);
  assert.equal(routeEnabled(disabled, 'p', 'other'), true, 'other models stay enabled');
  assert.equal(routeEnabled(disabled, 'other', 'm'), true, 'other providers stay enabled');
});

test('routeEnabled: the master switch wins over every perRoute entry', () => {
  const config = parsed({
    enabled: false,
    perRoute: [{ provider: 'p', model: 'm', enabled: true }],
  });
  assert.equal(routeEnabled(config, 'p', 'm'), false);
  assert.equal(routeEnabled(config, 'q', 'n'), false);
});

test('routeEnabled: perRoute last-wins for enabled', () => {
  const config = parsed({
    perRoute: [
      { provider: 'p', model: 'm', enabled: false },
      { provider: 'p', model: 'm', enabled: true },
    ],
  });
  assert.equal(routeEnabled(config, 'p', 'm'), true);

  const reDisabled = parsed({
    perRoute: [
      { provider: 'p', model: 'm', enabled: true },
      { provider: 'p', model: 'm', enabled: false },
    ],
  });
  assert.equal(routeEnabled(reDisabled, 'p', 'm'), false);
});

test('routeCapabilityOverride: undefined without an override, last-wins when set', () => {
  assert.equal(routeCapabilityOverride(parsed(), 'p', 'm'), undefined);

  const forced = parsed({ perRoute: [{ provider: 'p', model: 'm', imageCapable: true }] });
  assert.equal(routeCapabilityOverride(forced, 'p', 'm'), true);
  assert.equal(routeCapabilityOverride(forced, 'p', 'other'), undefined);

  const denied = parsed({ perRoute: [{ provider: 'p', model: 'm', imageCapable: false }] });
  assert.equal(routeCapabilityOverride(denied, 'p', 'm'), false);

  const lastWins = parsed({
    perRoute: [
      { provider: 'p', model: 'm', imageCapable: false },
      { provider: 'p', model: 'm', imageCapable: true },
    ],
  });
  assert.equal(routeCapabilityOverride(lastWins, 'p', 'm'), true);
});

test('routeCapabilityOverride: an entry without imageCapable does not reset an earlier one', () => {
  // Unlike `resolveRouteBudget`'s field-by-field replacement, the capability
  // lookup only considers entries that actually state a capability.
  const config = parsed({
    perRoute: [
      { provider: 'p', model: 'm', imageCapable: true },
      { provider: 'p', model: 'm', maxRequestImages: 4 },
    ],
  });
  assert.equal(routeCapabilityOverride(config, 'p', 'm'), true);
});

test('resolveRouteBudget: two routes resolve independently from one config', () => {
  const config = parsed({
    maxRequestImageBytes: 1000,
    maxRequestImages: 5,
    perRoute: [
      { provider: 'deepseek', model: 'chat', representation: 'files' },
      { provider: 'pi-ai', model: 'vision', representation: 'inline-base64', maxRequestImageBytes: 2 },
    ],
  });

  const files = resolveRouteBudget(config, 'deepseek', 'chat', undefined);
  assert.equal(files.dimension, 'count');
  assert.equal(files.maxImages, 5);

  const inline = resolveRouteBudget(config, 'pi-ai', 'vision', undefined);
  assert.equal(inline.dimension, 'bytes');
  assert.equal(inline.maxBytes, 2);
});
