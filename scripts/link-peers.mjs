#!/usr/bin/env node
/**
 * Link this package's peer dependencies to the exact copies the installed
 * DeepSeek Harness already loaded.
 *
 * Why this exists: a plugin installed into a profile with `link:` is resolved
 * through a symlink, so Node resolves its own imports from this workspace
 * directory, not from the profile. The harness packages are peers (one mounted
 * `llm`/`sessions` service graph must see one module instance per package), so
 * they are symlinked rather than copied or re-installed from the registry.
 *
 * Resolution order for the harness installation root:
 *   1. $DSH_PACKAGE_DIR        (explicit path to the `@deepseek-ai/dsh` directory)
 *   2. $DSH_NODE_MODULES       (a node_modules directory containing @deepseek-ai/dsh)
 *   3. `npm root -g`
 *   4. Platform-default global prefixes
 *
 * The script is idempotent and only ever writes inside this package's own
 * node_modules directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(PACKAGE_ROOT, 'node_modules');

/**
 * Dev-only packages used by the integration and replay harnesses. They are not
 * peers of the plugin itself; linking keeps them at the same module identity as
 * the harness so a test can mount the real adapter/store pair.
 */
const DEV_PEERS = [
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-llm-pi-ai',
];

/** Peer packages whose copies must stay identical to the mounted harness. */
const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-compaction-image-offload',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
];

/** Candidate node_modules roots that may hold the harness installation. */
function candidateRoots() {
  const roots = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) roots.push(value);
  };
  push(process.env.DSH_PACKAGE_DIR && dirname(dirname(resolve(process.env.DSH_PACKAGE_DIR))));
  push(process.env.DSH_NODE_MODULES && resolve(process.env.DSH_NODE_MODULES));
  try {
    push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm may be unavailable in a stripped runtime; fall through to fixed roots. */
  }
  push(join(dirname(dirname(process.execPath)), 'lib', 'node_modules'));
  push(join(homedir(), '.local', 'share', 'npm-global', 'lib', 'node_modules'));
  push('/usr/local/lib/node_modules');
  push('/usr/lib/node_modules');
  return [...new Set(roots)];
}

/** Locate the installed harness package directory. */
function findHarnessRoot() {
  if (process.env.DSH_PACKAGE_DIR) {
    const explicit = resolve(process.env.DSH_PACKAGE_DIR);
    if (existsSync(join(explicit, 'package.json'))) return explicit;
  }
  for (const root of candidateRoots()) {
    const candidate = join(root, '@deepseek-ai', 'dsh');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/** Current symlink target of `path`, or undefined when absent or not a symlink. */
function linkTarget(path) {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return undefined;
  }
}

const harness = findHarnessRoot();
if (harness === undefined) {
  console.error(
    '[link-peers] cannot locate the installed DeepSeek Harness (@deepseek-ai/dsh);\n' +
      '            set DSH_PACKAGE_DIR to its package directory and re-run.',
  );
  process.exit(1);
}

const harnessModules = join(harness, 'node_modules');
mkdirSync(join(NM, '@deepseek-ai'), { recursive: true });

let linked = 0;
let reused = 0;
for (const [index, peer] of [...PEERS, ...DEV_PEERS].entries()) {
  const optional = index >= PEERS.length;
  const source = join(harnessModules, peer);
  const target = join(NM, peer);
  if (!existsSync(join(source, 'package.json'))) {
    if (optional) {
      console.warn(`[link-peers] dev-only package not installed in this harness: ${peer}`);
      continue;
    }
    console.error(`[link-peers] missing peer in the harness installation: ${peer}`);
    process.exit(1);
  }
  const existing = linkTarget(target);
  if (existing === source) {
    reused += 1;
    continue;
  }
  // Only ever remove an entry this script owns: a symlink inside our node_modules.
  if (existing === null) {
    console.error(`[link-peers] refusing to replace a real directory: ${target}`);
    process.exit(1);
  }
  if (existing !== undefined) rmSync(target, { force: true });
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, 'dir');
  linked += 1;
}

console.log(`[link-peers] harness: ${harness}`);
console.log(`[link-peers] ${linked} linked, ${reused} already current`);
