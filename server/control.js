// How `agent007 status` and `agent007 restart` reach a running server.
//
// The server writes <config dir>/server.json (0600) once it listens: pid,
// port, host, version, how it runs (launchd, systemd or a terminal), a
// random token, and the folder it runs in and the .env files it loaded. The
// CLI reads that file and calls /control/status and /control/restart with the
// token in a header, so only someone who can read the owner's config dir can
// restart it. Origin-checked as well.
//
// Imports nothing from state.js, so the CLI can load it without the server.

import { timingSafeEqual } from 'crypto';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { configDir, settingsFiles } from './settings.js';

export const RESTART_EXIT = 75;
export const CONTROL_HEADER = 'x-agent007-control';
export const VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();

export const serverFile = (env = process.env) => join(configDir(env), 'server.json');
// Where the last server ran and the .env files it loaded. Kept after it stops,
// so `agent007 install` can carry those settings over to the service.
export const lastServerFile = (env = process.env) => join(configDir(env), 'last-server.json');

export function writeServerFile({ port, host, token, service = process.env.AGENT007_SERVICE || null, file = serverFile() }) {
  mkdirSync(join(file, '..'), { recursive: true });
  // Removed first: mode applies only to a new file, and one left by a crash
  // (or made by hand) may be readable by others.
  rmSync(file, { force: true });
  const where = { cwd: process.cwd(), settings: settingsFiles };
  writeFileSync(file, JSON.stringify({ pid: process.pid, port: Number(port), host, version: VERSION, startedAt: Date.now(), service, token, ...where }, null, 2), { mode: 0o600 });
  writeFileSync(join(file, '..', 'last-server.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), service, ...where }, null, 2));
  // Only ours: a second server on another port may have written it since.
  process.on('exit', () => { if (readServerFile(file)?.pid === process.pid) rmSync(file, { force: true }); });
}

export function readServerFile(file = serverFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Board workers in the middle of a step: the ones a restart would cut off.
export const busyWorkers = (sessions) => [...sessions.values()].filter(s => s.spawnedBy === 'board' && !s.exited && s.state === 'WORKING').length;

// Registered before the /api routes; `status()` and `restart()` come from server.js.
export function controlRoutes(app, { token, checkOrigin, status, restart }) {
  const want = Buffer.from(token);
  const allowed = (req, res, next) => {
    const got = Buffer.from(String(req.headers[CONTROL_HEADER] || ''));
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  };
  app.get('/control/status', checkOrigin, allowed, (req, res) => res.json(status()));
  app.post('/control/restart', checkOrigin, allowed, (req, res) => {
    res.json({ ok: true });
    // After the reply is out.
    res.on('finish', () => setImmediate(restart));
  });
}

// The CLI side. null when nothing answers.
export async function callServer(path, { method = 'GET', info = readServerFile(), timeout = 3000 } = {}) {
  if (!info?.token || !pidAlive(info.pid)) return null;
  const host = ['0.0.0.0', '::', 'localhost'].includes(info.host) || !info.host ? '127.0.0.1' : info.host.includes(':') ? `[${info.host}]` : info.host;
  try {
    const res = await fetch(`http://${host}:${info.port}${path}`, { method, headers: { [CONTROL_HEADER]: info.token }, signal: AbortSignal.timeout(timeout) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
