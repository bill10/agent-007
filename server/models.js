// Which models a card may name, per CLI, discovered on this machine so nobody
// keeps a list. Nothing here goes to the network: Claude Code's aliases are
// fixed words its --model resolves to the newest model itself, and Codex
// already caches the account's model list on disk.
//
// A CLI that is not on the PATH the board spawns with offers nothing — a card
// could not run there anyway — and so does anything that fails to read. An
// empty list leaves only the CLI's own default on offer.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { commandExists } from './command-path.js';
import { isSafeModelName } from '../lib/jobs.js';

// `claude --model` takes these as "the latest model of that family"
// (claude --help names fable, opus and sonnet; haiku is in the same alias
// table in the 2.1.283 binary). Aliases rather than full names so a new
// release needs no change here.
export const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

const codexHome = (env) => env.CODEX_HOME || join(homedir(), '.codex');

// Codex (0.156) keeps the models its account can use in
// $CODEX_HOME/models_cache.json: { fetched_at, client_version, models: [{ slug,
// visibility, priority, ... }] }. Only `visibility: "list"` entries are kept:
// that is Codex's own filter for its /model picker, and it is what hides the
// internal ones (codex-auto-review, the reviewer's model; gpt-reserve) that
// are not for a coding session. Picker order is `priority`, lowest first. A
// slug must also pass isSafeModelName, since it ends up on a command line.
// The CLI has no plain list-models subcommand (its app-server's model/list is
// a JSON-RPC session, not a one-shot), so this reads the cache its picker is
// built from — read-only; nothing here ever writes under CODEX_HOME.
export function parseCodexModels(text) {
  let models;
  try { models = JSON.parse(text)?.models; } catch { return []; }
  if (!Array.isArray(models)) return [];
  return models
    .filter(m => m && m.visibility === 'list' && isSafeModelName(m.slug))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map(m => m.slug);
}

export function discoverModels({ env = process.env, exists = (f) => commandExists(f, env), read = (p) => readFileSync(p, 'utf8') } = {}) {
  let codex = [];
  if (exists('codex')) {
    try { codex = parseCodexModels(read(join(codexHome(env), 'models_cache.json'))); } catch { /* no cache yet */ }
  }
  return { claude: exists('claude') ? [...CLAUDE_ALIASES] : [], codex };
}

// The current answer, refreshed at most every 10 minutes when asked and hourly
// regardless (see startModelRefresh).
const STALE_MS = 10 * 60 * 1000;
let cached = { claude: [], codex: [] };
let cachedAt = 0;

export function refreshModels(opts) {
  cached = discoverModels(opts);
  cachedAt = Date.now();
  return cached;
}

export function availableModels() { return cached; }

// Whether a refresh changed anything, so the caller only repaints boards when it did.
export function refreshIfStale(now = Date.now()) {
  if (now - cachedAt < STALE_MS) return false;
  const before = JSON.stringify(cached);
  return JSON.stringify(refreshModels()) !== before;
}

export function startModelRefresh() {
  refreshModels();
  setInterval(refreshModels, 60 * 60 * 1000).unref();
}
