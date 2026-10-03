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

export const updateLogPath = (env = process.env) => join(configDir(env), 'logs', 'update.log');

let cached = null; // { at, latest }
let run = null; // { pid, done, code } for the update this server started

export function resetSelfUpdate() { cached = null; run = null; }

// The registry's latest, asked at most every 10 minutes.
async function latest({ fetchLatest = npmLatest, now = Date.now() } = {}) {
  if (!cached || now - cached.at > LATEST_MS) cached = { at: now, latest: await fetchLatest() };
  return cached.latest;
}

const tail = (file, n = 8) => {
  try { return readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; }
};

export async function updateInfo({ kind = installKind(), version = VERSION, fetchLatest, env = process.env, workers = 0 } = {}) {
  const info = { version, kind };
  if (run && !run.done) {
    // restart() logs "N workers are mid-run" while it waits for them (service.js waitForIdle).
    info.updating = /mid-run/.test(tail(updateLogPath(env), 2)) && workers ? { waiting: workers } : {};
  } else if (run?.done) {
    info.finished = { code: run.code, log: tail(updateLogPath(env)) };
  }
  if (kind === 'npx') return info;
  const npm = await latest({ fetchLatest });
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
