// Reads how full the machine is, for the board's memory back-pressure
// (lib/memory.js decides what the readings mean).
//
// Three sources, each optional:
//  - swap and the kernel's pressure level: one `sysctl` on macOS, /proc/meminfo
//    on Linux;
//  - free disk where the home folder lives, which is where macOS grows swap;
//  - the mac-mini-guard watchdog's current.json, when it is installed and
//    recent. Its disk figure wins over ours: it counts the space APFS can
//    purge on demand, which statfs leaves out, and it is the number the owner
//    reads.
// A source that fails gives null, and a null reading counts as fine.
//
// MEMORY_BACK_PRESSURE=0 turns the readings off (the gate then sees "ok").

import { execFile } from 'child_process';
import { readFileSync, statfsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { classifyMemory, freshGuard } from '../lib/memory.js';

export const GUARD_FILE = join(homedir(), '.local', 'share', 'mac-mini-guard', 'current.json');
// Dispatch reads at most this often; a pass with several candidates reads once.
export const MEMORY_CACHE_MS = 15_000;
const SYSCTL_MS = 3000;
const GB = 1e9;

export function backPressureOn(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.MEMORY_BACK_PRESSURE ?? '').trim());
}

// "total = 6144.00M  used = 4477.81M  free = 1666.19M  (encrypted)"
export function parseSwapUsage(text) {
  const size = (key) => {
    const m = new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT]?)`).exec(String(text));
    if (!m) return null;
    return Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[m[2]] ?? 1 / (1024 * 1024));
  };
  const total = size('total');
  const used = size('used');
  if (total == null || used == null) return null;
  return { swapTotalMb: Math.round(total), swapUsedMb: Math.round(used), swapPct: total > 0 ? (used / total) * 100 : 0 };
}

// SwapTotal / SwapFree from /proc/meminfo, in kB.
export function parseMeminfo(text) {
  const kb = (key) => { const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(String(text)); return m ? Number(m[1]) : null; };
  const total = kb('SwapTotal');
  const free = kb('SwapFree');
  if (total == null || free == null) return null;
  const used = total - free;
  return { swapTotalMb: Math.round(total / 1024), swapUsedMb: Math.round(used / 1024), swapPct: total > 0 ? (used / total) * 100 : 0 };
}

const run = (cmd, args) => new Promise((done) => {
  execFile(cmd, args, { timeout: SYSCTL_MS, encoding: 'utf8' }, (err, out) => done(err ? null : out));
});

// The real machine. Each probe resolves to its part of the readings, or null.
export const defaultMemoryProbes = {
  platform: process.platform,
  sysctl: () => run('sysctl', ['-n', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
  meminfo: () => { try { return readFileSync('/proc/meminfo', 'utf8'); } catch { return null; } },
  diskFreeGb: () => { try { const s = statfsSync(homedir()); return (s.bavail * s.bsize) / GB; } catch { return null; } },
  guard: () => { try { return JSON.parse(readFileSync(process.env.MAC_MINI_GUARD_FILE || GUARD_FILE, 'utf8')); } catch { return null; } },
};

// { swapPct, swapUsedMb, swapTotalMb, kernelLevel, diskFreeGb, guard, level, reasons, at }
export async function readMemory(probes = defaultMemoryProbes, now = Date.now()) {
  const readings = { swapPct: null, swapUsedMb: null, swapTotalMb: null, kernelLevel: null, diskFreeGb: null, guard: null };
  if (probes.platform === 'darwin') {
    const out = await Promise.resolve().then(() => probes.sysctl()).catch(() => null);
    if (out) {
      const [swapLine = '', levelLine = ''] = String(out).trim().split('\n');
      Object.assign(readings, parseSwapUsage(swapLine) || {});
      const level = Number.parseInt(levelLine, 10);
      readings.kernelLevel = Number.isFinite(level) ? level : null;
    }
  } else if (probes.platform === 'linux') {
    const text = await Promise.resolve().then(() => probes.meminfo()).catch(() => null);
    if (text) Object.assign(readings, parseMeminfo(text) || {});
  }
  const disk = await Promise.resolve().then(() => probes.diskFreeGb()).catch(() => null);
  readings.diskFreeGb = Number.isFinite(disk) ? disk : null;
  const guard = freshGuard(await Promise.resolve().then(() => probes.guard()).catch(() => null), now);
  if (guard) {
    readings.guard = { ts: guard.ts, level: guard.level, reasons: Array.isArray(guard.reasons) ? guard.reasons : [] };
    const guardDisk = Number(guard.after?.disk_free_gb ?? guard.before?.disk_free_gb);
    if (Number.isFinite(guardDisk)) readings.diskFreeGb = guardDisk;
  }
  return { ...readings, ...classifyMemory(readings, now), at: new Date(now).toISOString() };
}

const OFF = Object.freeze({ level: 'ok', reasons: [], off: true });
let cached = null;
let cachedAt = 0;
let inFlight = null;

// The board's reading: cached for MEMORY_CACHE_MS, one read at a time.
export async function memoryStatus({ env = process.env, probes = defaultMemoryProbes, now = Date.now(), maxAgeMs = MEMORY_CACHE_MS } = {}) {
  if (!backPressureOn(env)) return OFF;
  if (cached && now - cachedAt < maxAgeMs) return cached;
  if (!inFlight) {
    inFlight = readMemory(probes, now)
      .then((r) => { cached = r; cachedAt = now; return r; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

// The last reading, without reading again (null before the first).
export function lastMemoryStatus(env = process.env) {
  return backPressureOn(env) ? cached : OFF;
}

export function resetMemoryCache() {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}
