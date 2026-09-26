// Which models a card may name, per CLI, discovered on this machine so nobody
// keeps a list. Claude Code's aliases are fixed words its --model resolves to
// the newest model itself; Codex is asked for its catalog.
//
// A CLI that is not on the PATH the board spawns with offers nothing — a card
// could not run there anyway — and so does anything that fails to read. An
// empty list leaves only the CLI's own default on offer.

import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { commandExists, resolveExecutable } from './command-path.js';
import { isSafeModelName } from '../lib/jobs.js';

// `claude --model` takes these as "the latest model of that family"
// (claude --help names fable, opus and sonnet; haiku is in the same alias
// table in the 2.1.283 binary). Aliases rather than full names so a new
// release needs no change here.
export const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

const codexHome = (env) => env.CODEX_HOME || join(homedir(), '.codex');

// Codex's catalog, from `codex debug models` (0.157: "Render the raw model
// catalog as JSON") or, failing that, the cache its picker is built from,
// $CODEX_HOME/models_cache.json. Both are { models: [{ slug, visibility,
// priority, ... }] }. Only `visibility: "list"` entries are kept: that is
// Codex's own filter for its /model picker, and it is what hides the internal
// ones (codex-auto-review, the reviewer's model; gpt-reserve) that are not for
// a coding session. Picker order is `priority`, lowest first. A slug must also
// pass isSafeModelName, since it ends up on a command line. Null when the text
// is not a catalog. Read-only; nothing here ever writes under CODEX_HOME.
function listedCodexModels(text) {
  let models;
  try { models = JSON.parse(text)?.models; } catch { return null; }
  if (!Array.isArray(models)) return null;
  return models
    .filter(m => m && m.visibility === 'list' && isSafeModelName(m.slug))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map(m => m.slug);
}

export const parseCodexModels = (text) => listedCodexModels(text) ?? [];

// The same codex, found the same way, the board launches workers with. No
// shell. On Windows the npm install is codex.cmd, which execFile will not run
// without one, so there this fails and the cache is read instead.
export function runCodexModels(env) {
  return new Promise((resolve, reject) => {
    execFile(resolveExecutable('codex', env) ?? 'codex', ['debug', 'models'],
      { env, timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export async function discoverModels({
  env = process.env, exists = (f) => commandExists(f, env), read = (p) => readFileSync(p, 'utf8'),
  run = runCodexModels, log = console.log,
} = {}) {
  let codex = [];
  if (exists('codex')) {
    let source = '`codex debug models`';
    codex = await run(env).then(listedCodexModels, () => null);
    if (!codex) {
      source = 'models_cache.json';
      try { codex = parseCodexModels(read(join(codexHome(env), 'models_cache.json'))); } catch { codex = []; source = 'nowhere (no models_cache.json either)'; }
    }
    log(`  Models: Codex's from ${source}`);
  }
  return { claude: exists('claude') ? [...CLAUDE_ALIASES] : [], codex };
}

// The current answer, refreshed at most every 10 minutes when asked and hourly
// regardless (see startModelRefresh).
const STALE_MS = 10 * 60 * 1000;
let cached = { claude: [], codex: [] };
let cachedAt = 0;

// cachedAt is stamped before the await so a second ask while Codex is still
// answering does not start another run. It never rejects: callers fire and
// forget, and a failed look keeps the last answer.
export async function refreshModels(opts) {
  cachedAt = Date.now();
  try { cached = await discoverModels(opts); } catch (err) { console.error('  Models: discovery failed:', err); }
  return cached;
}

export function availableModels() { return cached; }

// Whether a refresh changed anything, so the caller only repaints boards when it did.
export async function refreshIfStale(now = Date.now()) {
  if (now - cachedAt < STALE_MS) return false;
  const before = JSON.stringify(cached);
  return JSON.stringify(await refreshModels()) !== before;
}

export function startModelRefresh() {
  refreshModels();
  setInterval(refreshModels, 60 * 60 * 1000).unref();
}
