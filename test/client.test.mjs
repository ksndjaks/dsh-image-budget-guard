/**
 * Client half tests (`client.js`).
 *
 * The browser loads this file through `window.__ModuleLoader__`, so the test
 * stubs that loader, a minimal React, and the cordis services the module
 * injects. What matters here is the contract the Plugins page depends on:
 *
 *  - the module id equals the package name;
 *  - `apply` registers `plugins.row.config` under `<package>#<row id>`, which is
 *    the key `configLedgerSource()` collects and the row page dispatches;
 *  - the card renders the Mistral switch and writes through `form.mutate`.
 *
 * Run: `node --test test/client.test.mjs` (from the package root).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bundlePatchPaths, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** Minimal React stand-in: elements are plain objects, hooks are inert. */
function createReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };
}

/** Load the module the way the browser does and return its factory result. */
function loadModule() {
  let registration;
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        registration = entry;
      },
    },
  };
  const react = createReact();
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window);
  assert.ok(registration !== undefined, 'the module registers itself');
  const exported = registration.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require(${name})`);
  });
  return { registration, exported, react };
}

/** Expand function components the way React would, then collect every host element. */
function render(node) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) return node.flatMap((child) => render(child) ?? []);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    return render(node.type({ ...node.props, children: node.children }));
  }
  return { ...node, children: (node.children ?? []).flatMap((child) => render(child) ?? []) };
}

/** Collect every host element of a rendered tree. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

test('client: the module id is the package name', () => {
  const { registration } = loadModule();
  assert.equal(registration.id, manifest.name);
});

test('client: the manifest declares the client half', () => {
  assert.equal(manifest.exports['./client'].default, './client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
  assert.ok(manifest.files.includes('client.js'), 'the file ships');
});

test('client: apply registers plugins.row.config under <package>#<row id>', () => {
  const { exported } = loadModule();
  assert.deepEqual(exported.inject, ['slots', 'locale']);

  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: {
      inject: (name, fn) => {
        assert.equal(name, 'plugins.row.config');
        fn();
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  exported.apply(ctx);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, 'plugins.row.config');
  assert.equal(registrations[0].options.key, `${manifest.name}#image-budget-guard`);
  assert.equal(typeof registrations[0].component, 'function');
});

test('client: the row key matches the row id the patch declares', () => {
  // A mismatch is silent: the card registers, nothing dispatches it, and the row
  // stays unconfigurable. Keep the two literals tied to one source.
  const [patchPath] = bundlePatchPaths(PACKAGE_ROOT, manifest.dsh.bundle);
  const rows = loadOverlayPatches('dsh', patchPath).flatMap((patch) => patch.insert ?? []);
  const ours = rows.filter((row) => row.name === manifest.name);
  assert.equal(ours.length, 1, 'the patch inserts exactly one row for this package');

  const { exported } = loadModule();
  let key;
  exported.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: {
      inject: (_n, fn) => fn(),
      register: (options) => {
        key = options.key;
        return () => {};
      },
    },
  });
  assert.equal(key, `${manifest.name}#${ours[0].id}`);
});

test('client: the card renders the Mistral switch from the live form', () => {
  const { exported } = loadModule();
  let component;
  exported.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, card) => {
        component = card;
        return () => {};
      },
    },
  });

  const value = {
    enabled: true,
    dryRun: false,
    representation: 'auto',
    maxRequestImageBytes: 6 * 1024 * 1024,
    maxRequestImages: 60,
    mistralImageLimit: true,
    minRetainImages: 4,
    retainSteps: 0,
    quanta: 4,
    logLevel: 'info',
  };
  const mutations = [];
  const tree = component({
    view: 'page',
    form: {
      state: { status: 'ready', value, revision: 7, writable: true },
      mutate: (ops, revision) => {
        mutations.push({ ops, revision });
      },
    },
  });

  const elements = walk(render(tree));
  const inputs = elements.filter((node) => node.type === 'input');
  const checkboxes = inputs.filter((node) => node.props.type === 'checkbox');
  assert.equal(checkboxes.length, 3, 'enabled, Mistral cap, and dry run are switches');
  assert.ok(
    checkboxes.some((node) => node.props.checked === true),
    'the Mistral switch reflects the stored value',
  );

  // The switches render in order: enabled, Mistral cap, dry run. The Mistral one
  // writes the field the server reads.
  const mistral = checkboxes[1];
  assert.equal(mistral.props.checked, true, 'the stored Mistral value is reflected');
  mistral.props.onChange({ target: { checked: false } });
  assert.deepEqual(mutations[0], { ops: [{ op: 'set', path: ['mistralImageLimit'], value: false }], revision: 7 });

  // Numbers are shown in MiB and written back as bytes.
  const byteField = inputs.find((node) => node.props.type === 'number' && node.props.step === 0.5);
  assert.equal(byteField.props.value, '6', '6 MiB is displayed as 6');
});

test('client: the summary view is a single line of text', () => {
  const { exported } = loadModule();
  let component;
  exported.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_n, fn) => fn(), register: (_o, card) => { component = card; return () => {}; } },
  });
  const summary = component({ view: 'summary' });
  assert.equal(typeof summary, 'string');
  assert.ok(summary.length > 0 && summary.length < 120);
});

test('client: a read-only profile disables every control', () => {
  const { exported } = loadModule();
  let component;
  exported.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_n, fn) => fn(), register: (_o, card) => { component = card; return () => {}; } },
  });
  const tree = component({
    view: 'page',
    form: {
      state: {
        status: 'ready',
        revision: 1,
        writable: false,
        value: { enabled: true, mistralImageLimit: true, maxRequestImageBytes: 1024, maxRequestImages: 1, minRetainImages: 0, retainSteps: 0, quanta: 1, representation: 'auto', logLevel: 'info' },
      },
      mutate: () => {},
    },
  });
  const controls = walk(render(tree)).filter((node) => node.type === 'input' || node.type === 'select');
  assert.ok(controls.length > 0);
  assert.ok(controls.every((node) => node.props.disabled === true), 'every control is disabled');
});
