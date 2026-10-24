#!/usr/bin/env node
/**
 * Acceptance check for the two deployment claims that unit tests cannot cover:
 *
 *   A. The shipped `cordis.patch.yml` row composes with the real `web` profile
 *      and `dsh --profile web --dump-config` prints it without new warnings.
 *   B. The built `dist/` mounts as a cordis plugin through the same lifecycle
 *      the loader uses (`ctx.plugin` + a validated `Config`), activates once its
 *      injected services exist, and its `agent/request` listener records the
 *      omission on a real `Session` so the derived request actually shrinks.
 *
 * Both steps are read-only with respect to the live profile: the patch is passed
 * as a `--patch` overlay, never written into the profile, and the zero-downtime
 * web server is never restarted.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { bundlePatchPaths, loadOverlayPatches, readProfileManifest } from '@deepseek-ai/dsh-app-boot';
import { Context } from '@deepseek-ai/cordis';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_BIN = join(
  process.env.DSH_PACKAGE_DIR ?? '/home/ksndjaks/.local/share/npm-global/lib/node_modules/@deepseek-ai/dsh',
  'lib',
  'bin.js',
);
const PROFILE = process.env.DSH_PROFILE ?? 'web';
const PACKAGE_NAME = '@ksndjaks/dsh-image-budget-guard';

/** Encode one deterministic PNG with the built-in zlib (no image library). */
async function png(width, height, seed) {
  const zlib = await import('node:zlib');
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = (seed + x) & 0xff;
      raw[at + 1] = (seed + y * 3) & 0xff;
      raw[at + 2] = (seed + x * y) & 0xff;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable;
function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

/** One fake image-capable route with a fixed request-version policy. */
class VerifyAdapter extends LlmAdapter {
  constructor(policy) {
    super();
    this.policy = policy;
  }
  providerInfo(provider) {
    return { id: provider, name: provider };
  }
  imageRequestTarget(_provider, _model, image) {
    const maxPixels = this.policy.maxPixels;
    const area = image.width * image.height;
    if (area <= maxPixels) return { width: image.width, height: image.height, maxBytes: this.policy.maxBytes };
    const scale = Math.sqrt(maxPixels / area);
    return {
      width: Math.max(1, Math.floor(image.width * scale)),
      height: Math.max(1, Math.floor(image.height * scale)),
      maxBytes: this.policy.maxBytes,
    };
  }
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000_000 },
      inputModalities: ['text', 'image'],
    };
  }
  async *stream() {
    // Never reached: this check only proves mounting and the durable decision.
    yield { type: 'finish', finish: { kind: 'completed' } };
  }
}

/**
 * Step A0: prove the install-time bundle registration contract.
 *
 * `dsh plugin --profile <p> add <package>` runs the plugin manager's
 * `reconcile()` after pnpm succeeds. For every newly installed dependency it
 * reads `package.json#dsh.bundle`, validates each declared patch file with
 * `loadOverlayPatches()`, and appends the package name to
 * `dsh.profile.bundles` (`@deepseek-ai/dsh-plugin-manager/lib/index.js:322-350`).
 * This step runs exactly those reads against this package, so a manifest or
 * patch regression fails here instead of during a user install.
 */
function checkBundleRegistration() {
  const manifest = readProfileManifest('dsh', PACKAGE_ROOT);
  const bundle = manifest.dsh?.bundle;
  if (bundle === undefined) {
    return { ok: false, detail: 'package.json declares no dsh.bundle; an install would be a plain dependency' };
  }
  let paths;
  try {
    paths = bundlePatchPaths(PACKAGE_ROOT, bundle);
  } catch (error) {
    return { ok: false, detail: `dsh.bundle.patch is invalid: ${String(error)}` };
  }
  const problems = [];
  const inserted = [];
  for (const file of paths) {
    try {
      const patches = loadOverlayPatches('dsh', file);
      for (const patch of patches) for (const entry of patch.insert ?? []) inserted.push(entry);
    } catch (error) {
      problems.push(`${file}: ${String(error)}`);
    }
  }
  const ours = inserted.filter((entry) => entry.id === 'image-budget-guard');
  if (ours.length !== 1) problems.push(`expected exactly one image-budget-guard row, found ${ours.length}`);
  if (ours[0]?.name !== manifest.name) problems.push(`row name ${ours[0]?.name} does not match ${manifest.name}`);
  return {
    ok: problems.length === 0,
    detail: problems.join('\n') || `manifest + ${paths.length} patch file(s) parse; row auto-registers on install`,
    files: paths.map((file) => file.replace(`${PACKAGE_ROOT}/`, '')),
  };
}

/** Run `--dump-config` for the real profile, optionally with one patch overlay. */
async function dumpConfig(extraArgs) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [DSH_BIN, '--profile', PROFILE, ...extraArgs, '--dump-config'],
    { cwd: PACKAGE_ROOT, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } },
  );
  return { stdout, stderr };
}

/** Warning lines that belong to this package rather than to pre-existing profile layers. */
function guardWarnings(stderr) {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /image-budget-guard/i.test(line));
}

/**
 * Step A: compose the shipped patch over the real profile and inspect it.
 *
 * The user profile already emits unrelated patch warnings, so "no new warnings"
 * is proved by diffing the warning set against a baseline dump taken without
 * this overlay instead of assuming an empty stderr.
 */
async function checkPatchComposition() {
  const patchPath = process.env.GUARD_PATCH ?? join(PACKAGE_ROOT, 'cordis.patch.yml');
  try {
    await readFile(patchPath, 'utf8');
  } catch (error) {
    return { ok: false, detail: `cannot read ${patchPath}: ${String(error)}` };
  }
  const baseline = await dumpConfig([]);
  const patched = await dumpConfig(['--patch', patchPath]);
  const problems = [];
  if (!/id:\s*image-budget-guard\b/.test(patched.stdout)) {
    problems.push('row "image-budget-guard" missing from --dump-config output');
  }
  if (!/maxRequestImageBytes/.test(patched.stdout)) problems.push('image budget config missing from --dump-config output');
  if (/unknown key|invalid config|failed to load|ValidationError/i.test(patched.stderr)) {
    problems.push(`stderr contains a load problem:\n${patched.stderr.trim()}`);
  }
  const before = new Set(baseline.stderr.split('\n').map((line) => line.trim()));
  const introduced = patched.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !before.has(line));
  if (introduced.length > 0) problems.push(`new stderr lines:\n${introduced.join('\n')}`);
  // A profile that already installed an older copy of this package keeps that
  // copy's manifest on the bundle list. When its declared range no longer
  // matches the running dsh, the launcher skips the whole layer, so the row
  // silently disappears. Name the cause and the exact repair instead of only
  // reporting the skip line.
  const skipped = patched.stderr
    .split('\n')
    .find((line) => /skipping profile bundle/.test(line) && line.includes(PACKAGE_NAME));

  const mine = guardWarnings(patched.stderr).filter((line) => line !== skipped);
  if (mine.length > 0) problems.push(`warnings naming this plugin:\n${mine.join('\n')}`);

  if (skipped !== undefined) {
    const installedDir = join(
      process.env.DSH_HOME ?? join(homedir(), '.dsh'),
      'profiles',
      PROFILE,
      'node_modules',
      PACKAGE_NAME,
    );
    let installedVersion = 'unknown';
    try {
      installedVersion = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf8')).version;
    } catch {
      /* the bundle was resolved from somewhere else; the repair is the same */
    }
    problems.push(
      `profile ${PROFILE} has an installed copy ${PACKAGE_NAME}@${installedVersion} that the running dsh skips as incompatible.\n` +
        `  Repair after publishing this version:\n` +
        `    dsh plugin --profile ${PROFILE} remove ${PACKAGE_NAME}\n` +
        `    dsh plugin --profile ${PROFILE} add ${process.env.GUARD_INSTALL_SPEC ?? `<published spec>`}`,
    );
  }
  return {
    ok: problems.length === 0,
    detail: problems.join('\n') || `profile ${PROFILE}: row present, no new warnings or stderr lines`,
    patchPath,
    excerpt: patched.stdout
      .split('\n')
      .filter((line) => /image-budget-guard|maxRequestImageBytes|maxRequestImages|perRoute|minRetainImages/.test(line))
      .slice(0, 12),
  };
}

/**
 * Step A2: prove the `link:` shape resolves exactly as a profile entry would.
 *
 * A profile install materializes the package under `<profile>/node_modules`. This
 * mirrors that layout in a temp directory (symlink, not copy), then imports the
 * bare specifier from a module living in that directory — the same resolution
 * Node performs for the loader's entry import.
 */
async function checkLinkResolution() {
  const root = await mkdtemp(join(tmpdir(), 'guard-link-'));
  const scope = join(root, 'node_modules', '@ksndjaks');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(scope, { recursive: true });
  await symlink(PACKAGE_ROOT, join(scope, 'dsh-image-budget-guard'), 'dir');
  const probe = join(root, 'probe.mjs');
  await writeFile(
    probe,
    "import * as pkg from '@ksndjaks/dsh-image-budget-guard';\n" +
      "console.log(JSON.stringify({ name: pkg.name, inject: pkg.inject, hasConfig: typeof pkg.Config?.['~standard']?.validate, hasApply: typeof pkg.apply }));\n",
  );
  try {
    const { stdout } = await execFileAsync(process.execPath, [probe], { cwd: root });
    const facts = JSON.parse(stdout.trim());
    const problems = [];
    if (facts.name !== 'image-budget-guard') problems.push(`unexpected name ${facts.name}`);
    if (facts.hasConfig !== 'function' || facts.hasApply !== 'function') problems.push('missing Config/apply exports');
    return { ok: problems.length === 0, detail: problems.join('\n') || `link: resolution ok (${stdout.trim()})` };
  } catch (error) {
    return { ok: false, detail: `link: probe failed: ${String(error)}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Step B: mount the built package through cordis and drive one real decision. */
async function checkRuntimeMount() {
  const home = await mkdtemp(join(tmpdir(), 'guard-verify-'));
  const realAttachments = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'), 'attachments', 'v1');
  const tmpAttachments = join(home, 'attachments');
  await symlink(realAttachments, join(tmpAttachments, 'v1'), 'dir').catch(async () => {
    // No real store to borrow: create an empty one so the check stays hermetic.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmpAttachments, 'v1'), { recursive: true });
  });

  const ctx = new Context();
  new SessionStore(ctx);
  const llm = new LlmRuntime(ctx);
  const store = new LocalAttachmentStore(ctx, { dshHome: home });
  const policy = { maxPixels: 1_048_576, maxBytes: 262_144 };
  llm.registerAdapter(['verifyroute'], new VerifyAdapter(policy));

  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href);
  const config = plugin.ConfigSchema.parse({
    // Eight ~226 KiB request versions: the newest two are protected by
    // minRetainImages, so the budget must sit above their combined size for the
    // decision to be satisfiable (this also exercises the retention floor).
    maxRequestImageBytes: 600_000,
    maxRequestImages: 4,
    minRetainImages: 2,
    retainSteps: 0,
    quanta: 2,
    logLevel: 'silent',
  });
  // The loader validates through the same Standard Schema interface this uses.
  const standard = plugin.Config['~standard'].validate(config);
  if (standard.issues !== undefined) throw new Error(`Config rejected: ${JSON.stringify(standard.issues)}`);

  ctx.plugin(plugin, config);
  await new Promise((done) => setImmediate(done));
  if (ctx.get('llm') === undefined || ctx.get('sessions') === undefined) throw new Error('services missing before mount');

  const session = ctx.sessions.create('verify-session');
  const images = [];
  for (let index = 0; index < 8; index += 1) {
    const data = await png(320, 240, index * 17);
    images.push(await store.saveImage({ data, mediaType: 'image/png', name: `verify-${index}.png` }));
  }
  session.append('step/start', { turn: 1, step: 1 });
  session.append(
    'user/message',
    {
      id: 'verify-user-1',
      role: 'user',
      content: [
        { type: 'text', text: 'verify' },
        ...images.slice(0, 4).map((attachment) => ({ type: 'image', attachment })),
      ],
      source: { kind: 'user' },
    },
    { surfaceOp: 'append' },
  );
  session.append('step/end', { turn: 1, step: 1 });
  session.append('step/start', { turn: 1, step: 2 });
  session.append(
    'tool/result',
    {
      turn: 1,
      step: 2,
      message: {
        id: 'verify-tool-1',
        role: 'tool',
        content: images.slice(4).map((attachment) => ({ type: 'image', attachment })),
        source: { kind: 'tool', callId: 'verify-call-1' },
      },
    },
    { surfaceOp: 'append', sourceEventSeqs: [3] },
  );
  session.append('step/end', { turn: 1, step: 2 });

  const before = await payloadBytes(ctx, session, 'verifyroute', 'verify-model');
  const agent = { session, options: { provider: 'verifyroute', model: 'verify-model' } };
  const result = await ctx.waterfall(
    {},
    'agent/request',
    { agent, turn: 1, step: 3, signal: new AbortController().signal },
    () => Promise.resolve({ provider: 'verifyroute', model: 'verify-model' }),
  );
  await new Promise((done) => setImmediate(done));
  const after = await payloadBytes(ctx, session, 'verifyroute', 'verify-model');
  const offloadEvents = session
    .snapshotEvents(0, session.seq)
    .filter((event) => event.type === 'image/offload').length;

  const problems = [];
  if (result.provider !== 'verifyroute') problems.push('listener altered the resolved config');
  if (offloadEvents === 0) problems.push('no image/offload event was appended');
  if (!(after < before)) problems.push(`payload did not shrink (${before} -> ${after})`);
  if (after > config.maxRequestImageBytes) problems.push(`payload ${after} exceeds budget ${config.maxRequestImageBytes}`);

  // Route-selection ordering: `dsh-agent` rewrites provider/model inside a
  // later `agent/request` listener. A guard registered earlier must observe that
  // rewrite (outermost listener awaiting `next()`), so dispatch a seed naming an
  // unmounted route and let the rewriter supply the real one. If this plugin
  // ever moved to `agent/pre-step`, no offload would happen here.
  session.append('step/start', { turn: 1, step: 3 });
  const late = [];
  for (let index = 0; index < 4; index += 1) {
    const data = await png(320, 240, 200 + index * 17);
    late.push(await store.saveImage({ data, mediaType: 'image/png', name: `verify-late-${index}.png` }));
  }
  session.append(
    'tool/result',
    {
      turn: 1,
      step: 3,
      message: {
        id: 'verify-tool-3',
        role: 'tool',
        content: late.map((attachment) => ({ type: 'image', attachment })),
        source: { kind: 'tool', callId: 'verify-call-3' },
      },
    },
    { surfaceOp: 'append', sourceEventSeqs: [4] },
  );
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    return { ...resolved, provider: 'verifyroute', model: 'verify-model' };
  });
  const dispatched = await ctx.waterfall(
    {},
    'agent/request',
    { agent, turn: 1, step: 4, signal: new AbortController().signal },
    () => Promise.resolve({ provider: 'not-mounted', model: 'nope' }),
  );
  await new Promise((done) => setImmediate(done));
  const offloadEventsAfterRewrite = session
    .snapshotEvents(0, session.seq)
    .filter((event) => event.type === 'image/offload').length;
  if (dispatched.provider !== 'verifyroute') problems.push('route rewriter did not run last');
  if (offloadEventsAfterRewrite <= offloadEvents) {
    problems.push('guard did not observe the route rewritten by a later agent/request listener');
  }
  const derived = session.deriveMessages();
  const offloaded = derived.reduce(
    (sum, message) => sum + message.content.filter((block) => block.type === 'image' && block.offloaded === true).length,
    0,
  );
  if (offloaded === 0) problems.push('derived messages carry no offloaded image');

  await rm(home, { recursive: true, force: true });
  return {
    ok: problems.length === 0,
    detail: problems.join('\n') || 'plugin mounted, decision appended, payload shrank',
    before,
    after,
    offloadEvents: offloadEventsAfterRewrite,
    offloadedOccurrences: offloaded,
  };
}

/** Sum the exact base64 request payload the route would send for a session. */
async function payloadBytes(ctx, session, provider, model) {
  const attachments = ctx.get('attachments');
  const seen = new Map();
  let total = 0;
  for (const message of session.deriveMessages()) {
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue;
      const target = ctx.llm.imageRequestTarget(provider, model, block.attachment);
      const key = `${block.attachment.attachmentId}:${target.width}x${target.height}:${target.maxBytes}`;
      let bytes = seen.get(key);
      if (bytes === undefined) {
        bytes = (await attachments.readImageRequest(block.attachment, target)).bytes;
        seen.set(key, bytes);
      }
      total += Math.ceil(bytes / 3) * 4;
    }
  }
  return total;
}

const link = await checkLinkResolution();
console.log(`${link.ok ? 'PASS' : 'FAIL'} link: resolution — ${link.detail}`);

const registration = checkBundleRegistration();
console.log(`${registration.ok ? 'PASS' : 'FAIL'} bundle auto-registration — ${registration.detail}`);
if (registration.files !== undefined) for (const file of registration.files) console.log(`      layer: ${file}`);

const composition = await checkPatchComposition();
console.log(`${composition.ok ? 'PASS' : 'FAIL'} patch/composition — ${composition.detail}`);
if (composition.excerpt !== undefined) for (const line of composition.excerpt) console.log(`      ${line}`);

const mount = await checkRuntimeMount();
console.log(`${mount.ok ? 'PASS' : 'FAIL'} runtime mount — ${mount.detail}`);
if (mount.before !== undefined) {
  console.log(
    `      payload before=${mount.before}B after=${mount.after}B events=${mount.offloadEvents} offloadedOccurrences=${mount.offloadedOccurrences}`,
  );
}

if (!link.ok || !registration.ok || !composition.ok || !mount.ok) process.exitCode = 1;
