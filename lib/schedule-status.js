// Passive evidence only. Nothing here grants dispatch/recovery authority.
import { deriveJobStatus, DISPATCH_INTERVAL_MS, isScheduled, jobRequiresPr, scheduleHold } from './jobs.js';
import { nextCronTime } from './cron.js';

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => time(value) === null ? null : new Date(time(value)).toISOString();

export function scheduleStatus(schedule, jobs, sessions, { now = Date.now(), intervalMs = DISPATCH_INTERVAL_MS, running = true } = {}) {
  if (!isScheduled(schedule)) return null;
  const graceMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DISPATCH_INTERVAL_MS;
  // A malformed foreign link must not expose another owner's/repo's worker.
  const runs = jobs.filter(j => j.scheduleId === schedule.id && j.repoPath === schedule.repoPath && j.postedBy === schedule.postedBy);
  const observed = schedule.lastScheduleObservation?.cron === schedule.schedule ? schedule.lastScheduleObservation : null;
  const dueAt = iso(schedule.nextRunAt);
  const latest = runs.find(j => j.id === schedule.lastRunJobId);
  const open = runs.filter(j => j.state !== 'done');
  const blocker = open.find(j => j.state === 'in-progress') || open.find(j => j.state === 'todo')
    || open.find(j => j.state === 'review' && jobRequiresPr(j));
  const workerStatus = blocker ? deriveJobStatus(blocker, sessions.get(blocker.agentSessionId), { now }) : null;
  const result = {
    code: 'scheduled', label: 'Scheduled', attention: false,
    checkedAt: new Date(now).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    graceMs, nextDueAt: dueAt,
    // This is the due cursor actually examined, not a reconstructed firing.
    lastExpectedAt: iso(observed?.expectedAt), observedAt: iso(observed?.observedAt), outcome: observed?.outcome || null,
    lastRunAt: iso(schedule.lastRunAt),
    lastRun: latest ? { id: latest.id, state: latest.state, status: deriveJobStatus(latest, sessions.get(latest.agentSessionId), { now }), startedAt: iso(latest.startedAt), doneAt: iso(latest.doneAt) } : null,
    blocker: null, reason: '', action: '',
    delayedByMs: observed && time(observed.expectedAt) !== null && time(observed.observedAt) !== null
      ? Math.max(0, time(observed.observedAt) - time(observed.expectedAt)) : 0,
  };
  const set = (code, label, reason, action = '', attention = false) => Object.assign(result, { code, label, reason, action, attention });
  if (schedule.state === 'done') return set('archived', 'Archived', 'No further runs are expected.');
  if (schedule.paused) return set('paused', 'Paused', 'No runs are expected while paused.');
  if (!running) return set('stopped', 'Dispatcher stopped', 'Automatic scans are stopped.', 'Inspect the board dispatcher setting.');
  if (time(schedule.holdUntil) > now) return set('held', 'Schedule held', `Held until ${iso(schedule.holdUntil)}.`);
  // Clock rollback must not turn a future observation into evidence of a miss.
  if (time(observed?.observedAt) > now || time(schedule.lastRunAt) > now) {
    return set('clock', 'Clock evidence is ahead', 'A recorded observation is later than the server clock.', 'Inspect the server clock before interpreting lateness.', true);
  }
  if (blocker) {
    result.blocker = { id: blocker.id, state: blocker.state, status: workerStatus, agentName: blocker.agentName || null };
    const reason = scheduleHold(schedule, runs);
    if (workerStatus === 'gone' || workerStatus === 'stalled' || workerStatus === 'needs-input') {
      return set(`held-${workerStatus}`, `Held: prior worker ${workerStatus}`, `An In progress run still blocks this schedule; its worker is ${workerStatus}.`,
        'Inspect the blocking run. Recovery requires a separate decision; no replay is performed.', true);
    }
    return set('held', blocker.state === 'todo' ? 'Held: prior run queued' : blocker.state === 'review' ? 'Held: prior PR review' : 'Held: prior run active',
      reason, 'Inspect the blocking run; a posted run is not a missed firing.');
  }
  if (!dueAt) {
    return nextCronTime(schedule.schedule, now) === null
      ? set('unschedulable', 'No next firing', 'The cron has no matching future date (or is invalid).', 'Inspect the cron expression.')
      : set('unknown', 'Due time unavailable', 'There is no valid saved due timestamp.', 'Inspect the schedule; missed firings cannot be inferred.', true);
  }
  if (time(dueAt) <= now) {
    const overdue = now - time(dueAt) > graceMs;
    return set(overdue ? 'overdue' : 'due', overdue ? 'Run posting overdue' : 'Due: awaiting scan',
      `No run posting observed for the saved due time. Scan interval: ${graceMs / 1000}s; slow scans can take longer.`,
      overdue ? 'Inspect the dispatcher and last error. This is lateness evidence, not proof of worker failure.' : '', overdue);
  }
  if (observed?.outcome === 'error') return set('post-error', 'Last run was not posted', 'The last observed posting attempt failed.', 'Inspect the schedule’s last error.', true);
  if (observed?.outcome === 'held') return set('held-previously', 'Last firing held; blocker cleared', 'The next saved firing is in the future. Held recurring firings are not replayed.');
  if (result.delayedByMs > graceMs) return set('posted-late', 'Last run posted late', 'A delayed scan posted one run. Intermediate ticks were not replayed.');
  return result;
}
