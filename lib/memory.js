// Memory back-pressure for the job board: how full the machine is, and how many
// board workers it may run because of it. Pure; server/memory.js does the
// reading.
//
// Why it exists: a Mac mini with 16 GB that runs seven or eight workers next to
// a few Chromes fills its swap, and when the disk is too full for swap to grow
// macOS says it is "out of application memory" and stalls apps, the browser
// tab with the owner's chat included. Workers are the one load the board
// controls, so it stops adding them before that point. Running workers are
// never stopped: cutting one off mid-change costs more than waiting.

// The board's limit on workers at once, across every repo, when config.json
// names none. On top of the per-repo limit, never instead of it.
export const DEFAULT_MAX_WORKERS = 5;
export const MAX_WORKERS_LIMIT = 20;

// The thresholds, the same ones the mac-mini-guard watchdog uses for its own
// "pressure" level, plus the "critical" line where swap can no longer grow.
export const SWAP_PRESSURE_PCT = 75;
export const SWAP_CRITICAL_PCT = 90;
export const DISK_PRESSURE_GB = 15;
export const DISK_CRITICAL_GB = 8;
// Under pressure the limit drops by this many (never below one).
export const PRESSURE_SLACK = 2;
// A guard reading older than this is ignored: the watchdog writes every 5
// minutes, so three missed writes mean it has stopped.
export const GUARD_STALE_MS = 15 * 60_000;
// macOS's kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical.
const KERNEL_WARN = 2;
const KERNEL_CRITICAL = 4;

const LEVELS = ['ok', 'pressure', 'critical'];
const worse = (a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a);
const round1 = (n) => Math.round(n * 10) / 10;

// The limit config.json asks for, or the default. Hand-edited values are
// clamped rather than trusted.
export function maxWorkersSetting(settings) {
  const n = Number(settings?.maxWorkers);
  if (settings?.maxWorkers == null || !Number.isFinite(n)) return DEFAULT_MAX_WORKERS;
  return Math.max(1, Math.min(MAX_WORKERS_LIMIT, Math.floor(n)));
}

// The guard's current.json, if it is recent and says something we understand.
export function freshGuard(guard, now = Date.now()) {
  if (!guard || !LEVELS.includes(guard.level)) return null;
  const at = Date.parse(guard.ts);
  if (!Number.isFinite(at) || now - at > GUARD_STALE_MS) return null;
  return guard;
}

// { level: 'ok' | 'pressure' | 'critical', reasons: [...] } from one set of
// readings: { swapPct, diskFreeGb, kernelLevel, guard }. A reading that is
// missing (null) counts as fine: a probe that cannot run must never stop the
// board for good.
export function classifyMemory(readings = {}, now = Date.now()) {
  const { swapPct, diskFreeGb, kernelLevel } = readings;
  let level = 'ok';
  const reasons = [];
  const note = (l, why) => { level = worse(level, l); reasons.push(why); };
  if (Number.isFinite(swapPct)) {
    if (swapPct > SWAP_CRITICAL_PCT) note('critical', `swap ${Math.round(swapPct)}% full`);
    else if (swapPct > SWAP_PRESSURE_PCT) note('pressure', `swap ${Math.round(swapPct)}% full`);
  }
  if (Number.isFinite(diskFreeGb)) {
    if (diskFreeGb < DISK_CRITICAL_GB) note('critical', `${round1(diskFreeGb)} GB disk free`);
    else if (diskFreeGb < DISK_PRESSURE_GB) note('pressure', `${round1(diskFreeGb)} GB disk free`);
  }
  if (kernelLevel >= KERNEL_CRITICAL) note('critical', 'macOS reports critical memory pressure');
  else if (kernelLevel >= KERNEL_WARN) note('pressure', 'macOS reports memory pressure');
  const guard = freshGuard(readings.guard, now);
  if (guard && guard.level !== 'ok') {
    // Only what our own readings did not already say.
    const theirs = Array.isArray(guard.reasons) && guard.reasons.length ? guard.reasons.join(', ') : guard.level;
    if (LEVELS.indexOf(guard.level) > LEVELS.indexOf(level) || !reasons.length) note(guard.level, `mac-mini-guard: ${theirs}`);
  }
  return { level, reasons };
}

// How many board workers may run at once at this level.
export function workerCap(maxWorkers, level) {
  if (level === 'critical') return 0;
  if (level === 'pressure') return Math.max(1, maxWorkers - PRESSURE_SLACK);
  return maxWorkers;
}

// The board's dispatch gate: the limit now, how many run, room for more, and,
// when there is no room, the reason a queued card shows.
export function dispatchGate({ maxWorkers = DEFAULT_MAX_WORKERS, running = 0, memory = { level: 'ok', reasons: [] } } = {}) {
  const level = memory?.level || 'ok';
  const reasons = memory?.reasons || [];
  const cap = workerCap(maxWorkers, level);
  const room = Math.max(0, cap - running);
  const why = reasons.length ? ` (${reasons.join(', ')})` : '';
  // Held by memory: the limit is lower than the board's own because of it.
  const memoryHeld = !room && cap < maxWorkers && running < maxWorkers;
  let reason = null;
  if (level === 'critical') {
    reason = `Waiting: Mac memory is low${why}. No new workers start until it recovers; running ones continue.`;
  } else if (memoryHeld) {
    reason = `Waiting: Mac memory is under pressure${why}, so the board runs at most ${cap} of its ${maxWorkers} workers.`;
  } else if (!room) {
    reason = `Waiting: ${running} of ${cap} workers running, the board's limit across all repos.`;
  }
  return { maxWorkers, cap, running, room, level, reasons, reason, memoryHeld };
}
