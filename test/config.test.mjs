/**
 * Configuration schema and route-resolution tests (`dist/config.js`).
 *
 * The schema is a schemastery object because that is the only shape the Harness
 * plugin settings page can render (`isNativeConfigSchema()` requires
 * `Symbol.for('schemastery')`). Schemastery merges unknown keys instead of
 * rejecting them, so `parseConfig()` adds the strict check: a typo must be a
 * load-time rejection, never a silently ignored key (DESIGN.md §4).
 *
 * Run: `node --test test/config.test.mjs` (from the package root, after `pnpm build`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigSchema,
  MISTRAL_IMAGE_LIMIT,
  isMistralRoute,
  parseConfig,
  resolveRouteBudget,
  routeCapabilityOverride,
  routeEnabled,
} from '../dist/config.js';

/** Parse a raw config, failing the test on an unexpected rejection. */
function parsed(raw = {}) {
  return parseConfig(raw);
}

/** Assert a raw config is rejected, and return the thrown message. */
function rejected(raw) {
  try {
    parseConfig(raw);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail(`expected ${JSON.stringify(raw)} to be rejected`);
}

test('settings page: the exported Config is a native schemastery schema', () => {
  // The plugin settings page only renders a Config that carries this marker;
  // without it the row reports `unsupported` and there is no form at all.
  assert.equal(Reflect.get(ConfigSchema, Symbol.for('schemastery')), true);
  assert.equal(ConfigSchema.type, 'object');
  assert.equal(typeof ConfigSchema['~standard']?.validate, 'function', 'cordis validates through Standard Schema');
});

test('defaults: every field is optional and defaulted', () => {
  const config = parsed();

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.representation, 'auto');
  assert.equal(config.maxRequestImageBytes, 6 * 1024 * 1024, '6 MiB inline budget');
  assert.equal(config.maxRequestImages, 60, 'global count budget is not Mistral-tuned');
  assert.equal(config.mistralImageLimit, false, 'the Mistral optimisation is opt-in');
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
  const message = rejected({ nope: 1 });
  assert.match(message, /unknown config key "nope"/);
});

test('strict: unknown perRoute keys are rejected with their path', () => {
  const message = rejected({ perRoute: [{ provider: 'p', model: 'm', nope: 1 }] });
  assert.match(message, /unknown config key "perRoute\[0\]\.nope"/);
});

test('strict: nested unknown keys inside an otherwise valid perRoute entry are rejected', () => {
  const message = rejected({
    perRoute: [
      { provider: 'p', model: 'm', enabled: true },
      { provider: 'q', model: 'n', quanta: 2, typo: 'x' },
    ],
  });
  assert.match(message, /unknown config key "perRoute\[1\]\.typo"/);
});

test('strict: the Standard Schema interface still validates values', () => {
  // This is the path cordis uses at load time (`~standard.validate`).
  const standard = ConfigSchema['~standard'];
  assert.equal(typeof standard?.validate, 'function');

  const good = standard.validate({ dryRun: true });
  assert.equal(good.issues, undefined);
  assert.equal(good.value.dryRun, true);
  assert.equal(good.value.enabled, true);

  const bad = standard.validate({ enabled: 'yes' });
  assert.ok(bad.issues !== undefined, 'a rejected load reports issues');
});

test('bad values: non-positive byte and image budgets are rejected', () => {
  assert.match(rejected({ maxRequestImageBytes: 0 }), /invalid config/);
  assert.match(rejected({ maxRequestImages: 0 }), /invalid config/);
});

test('bad values: negative retention fields are rejected', () => {
  assert.match(rejected({ minRetainImages: -1 }), /invalid config/);
  assert.match(rejected({ retainSteps: -2 }), /invalid config/);
  assert.equal(parsed({ minRetainImages: 0 }).minRetainImages, 0, 'zero is legal');
});

test('bad values: quanta must be positive', () => {
  assert.match(rejected({ quanta: 0 }), /invalid config/);
});

test('bad values: non-boolean switches and unknown enum members are rejected', () => {
  assert.match(rejected({ enabled: 'yes' }), /invalid config/);
  assert.match(rejected({ mistralImageLimit: 1 }), /invalid config/);
  assert.match(rejected({ representation: 'magic' }), /invalid config/);
  assert.match(rejected({ logLevel: 'loud' }), /invalid config/);
});

test('bad values: an empty provider or model in perRoute is rejected', () => {
  assert.match(rejected({ perRoute: [{ provider: '', model: 'm' }] }), /invalid config/);
  assert.match(rejected({ perRoute: [{ provider: 'p', model: '' }] }), /invalid config/);
});

test('bad values: perRoute must be an array', () => {
  assert.match(rejected({ perRoute: { provider: 'p' } }), /invalid config/);
});

test('mistral switch: only a Mistral route is capped, and only when enabled', () => {
  assert.equal(MISTRAL_IMAGE_LIMIT, 20);
  const off = parsed({ maxRequestImages: 60 });
  const on = parsed({ maxRequestImages: 60, mistralImageLimit: true });

  assert.equal(resolveRouteBudget(off, 'mistral', 'm', 'inline-base64').maxImages, 60);
  assert.equal(resolveRouteBudget(on, 'mistral', 'm', 'inline-base64').maxImages, 20);
  assert.equal(
    resolveRouteBudget(on, 'commandcode', 'm', 'inline-base64').maxImages,
    60,
    'another provider keeps the global budget',
  );
  // A Files route on a Mistral-named provider still only pays references, but the
  // count cap is the provider's own limit and applies there too.
  assert.equal(resolveRouteBudget(on, 'mistral', 'm', 'files').maxImages, 20);
});

test('mistral switch: matches the route id, not a model name', () => {
  assert.equal(isMistralRoute('mistral'), true);
  assert.equal(isMistralRoute('Mistral'), true);
  assert.equal(isMistralRoute('mistral-cn'), true);
  assert.equal(isMistralRoute('mistral_eu'), true);
  assert.equal(isMistralRoute('mistralx'), false);
  assert.equal(isMistralRoute('commandcode'), false);
  assert.equal(isMistralRoute('my-mistral'), false);
});

test('mistral switch: it only lowers the cap, never raises it', () => {
  const config = parsed({ mistralImageLimit: true, maxRequestImages: 4 });
  assert.equal(
    resolveRouteBudget(config, 'mistral', 'm', 'inline-base64').maxImages,
    4,
    'a lower global budget still wins',
  );
  const overridden = parsed({
    mistralImageLimit: true,
    maxRequestImages: 60,
    perRoute: [{ provider: 'mistral', model: 'm', maxRequestImages: 5 }],
  });
  assert.equal(resolveRouteBudget(overridden, 'mistral', 'm', 'inline-base64').maxImages, 5);
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
  // An inline route enforces both bounds: a provider can cap the body size and
  // the image count independently (Mistral: 20 images). The byte bound decides
  // the wire cost, so it names the dimension, but the count bound still applies.
  assert.equal(policy.maxImages, 7, 'the count bound stays enforced on an inline route');
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

test('resolveRouteBudget: an inline route takes both overrides, a files route only the count', () => {
  const config = parsed({
    maxRequestImages: 10,
    perRoute: [{ provider: 'p', model: 'm', maxRequestImages: 3, maxRequestImageBytes: 5 }],
  });

  const inline = resolveRouteBudget(config, 'p', 'm', 'inline-base64');
  assert.equal(inline.maxBytes, 5, 'byte override applies on an inline route');
  assert.equal(inline.maxImages, 3, 'count override applies on an inline route too');

  const files = resolveRouteBudget(config, 'p', 'm', 'files');
  assert.equal(files.maxImages, 3, 'count override applies on a files route');
  assert.equal(files.maxBytes, Number.POSITIVE_INFINITY, 'a files route pays references, not bytes');
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
