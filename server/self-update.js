// Settings' version line and Update button (GET/POST /api/update).
//
// Update runs `agent007 update` itself, the same command a terminal would,
// as a detached child: it restarts this server, so it cannot run inside it.
// Its output goes to <config dir>/logs/update.log, which the page reads back
// when the update fails while this server is still up to say so.

import { spawn as nodeSpawn } from 'child_process';
import { mkdirSync, openSync, closeSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { configDir } from './settings.js';
import { installKind } from './service.js';
import { npmLatest, toNpm, fromNpm, versionAtLeast } from './doctor.js';
import { VERSION } from './control.js';

const BIN = fileURLToPath(new URL('../bin/agent-007.js', import.meta.url));
const LATEST_MS = 10 * 60_000;
const FRESH_MS = 10_000;

export const updateLogPath = (env = process.env) => join(configDir(env), 'logs', 'update.log');

let cached = null; // { at, latest }
let freshAt = 0; // when a fresh=1 last asked the registry
let run = null; // { pid, done, code } for the update this server started

export function resetSelfUpdate() { cached = null; freshAt = 0; run = null; notesCache = null; }

// The registry's latest, asked at most every 10 minutes.
// fresh skips the cache, but not more than every 10 s; a failed ask (null) keeps what was cached.
async function latest({ fetchLatest = npmLatest, now = Date.now(), fresh = false } = {}) {
  if (fresh && now - freshAt >= FRESH_MS) {
    freshAt = now;
    const npm = await fetchLatest();
    if (npm) cached = { at: now, latest: npm };
    else return { failed: true, latest: cached?.latest ?? null };
  }
  if (!cached || now - cached.at > LATEST_MS) cached = { at: now, latest: await fetchLatest() };
  return { latest: cached.latest };
}

const tail = (file, n = 8) => {
  try { return readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; }
};

export async function updateInfo({ kind = installKind(), version = VERSION, fetchLatest, env = process.env, workers = 0, fresh = false } = {}) {
  const info = { version, kind };
  if (run && !run.done) {
    // restart() logs "N workers are mid-run" while it waits for them (service.js waitForIdle).
    info.updating = /mid-run/.test(tail(updateLogPath(env), 2)) && workers ? { waiting: workers } : {};
  } else if (run?.done) {
    info.finished = { code: run.code, log: tail(updateLogPath(env)) };
  }
  if (kind === 'npx') return info;
  const { latest: npm, failed } = await latest({ fetchLatest, fresh });
  if (failed) info.checkFailed = true;
  if (npm && !versionAtLeast(toNpm(version), npm)) info.latest = fromNpm(npm);
  return info;
}

// { ok } once the child is started, or { error }. One at a time.
export function startUpdate({ kind = installKind(), spawn = nodeSpawn, env = process.env, execPath = process.execPath, bin = BIN } = {}) {
  if (kind === 'npx') return { error: 'npx runs the latest version each time it starts, so there is nothing to update.' };
  if (run && !run.done) return { error: 'An update is already running.' };
  const file = updateLogPath(env);
  mkdirSync(join(file, '..'), { recursive: true });
  const fd = openSync(file, 'w');
  let child;
  try {
    // ponytail: under systemd the restart stops the unit's cgroup, this child with it,
    // after the update is in; only update.log's last "Restarted:" line is lost.
    child = spawn(execPath, [bin, 'update'], { detached: true, stdio: ['ignore', fd, fd], env });
  } finally { closeSync(fd); }
  const mine = { pid: child.pid, done: false, code: null };
  run = mine;
  child.on('error', () => { mine.done = true; mine.code = -1; });
  child.on('exit', (code) => { mine.done = true; mine.code = code ?? -1; });
  child.unref();
  return { ok: true };
}

// "What's new": the CHANGELOG sections after the running version, up to the latest,
// from GitHub at the latest's release tag. The npm package leaves CHANGELOG.md out,
// and a checkout's own copy is the running version's, so neither has the new notes.
export const CHANGELOG_URL = 'https://github.com/bill10/agent-007/blob/main/CHANGELOG.md';
const rawChangelog = (v) => `https://raw.githubusercontent.com/bill10/agent-007/v${v}/CHANGELOG.md`;
let notesCache = null; // { latest, text: Promise }; a release's CHANGELOG never changes, and windows opened together share one fetch

async function fetchChangelog(v) {
  try {
    const res = await fetch(rawChangelog(v), { signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

// The `## [x.y.z.w]` sections newer than version and no newer than latest, newest first.
export function changelogBetween(text, version, latest) {
  return text.split(/^(?=## \[)/m).filter((s) => {
    const v = s.match(/^## \[([\d.]+)\]/)?.[1];
    return v && !versionAtLeast(version, v) && versionAtLeast(latest, v);
  }).join('').trim();
}

export async function updateNotes({ kind = installKind(), version = VERSION, fetchLatest, fetchText = fetchChangelog } = {}) {
  if (kind === 'npx') return { version, notes: '' };
  const { latest: npm } = await latest({ fetchLatest });
  const newest = npm && fromNpm(npm);
  if (!newest || versionAtLeast(version, newest)) return { version, notes: '' };
  if (notesCache?.latest !== newest) notesCache = { latest: newest, text: fetchText(newest) };
  const mine = notesCache;
  const text = await mine.text;
  if (!text) {
    if (notesCache === mine) notesCache = null; // a failure is asked again next time
    return { version, latest: newest, error: 'Could not load the release notes from GitHub.', url: CHANGELOG_URL };
  }
  return { version, latest: newest, notes: changelogBetween(text, version, newest) };
}
