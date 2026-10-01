import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { scheduleStatus } from '../lib/schedule-status.js';
import { nextCronIso } from '../lib/cron.js';

const now = Date.parse('2026-10-01T12:10:00Z');
const at = offset => new Date(now + offset).toISOString();
const schedule = (over = {}) => ({ id: 'schedule', type: 'scheduled', state: 'todo', schedule: '@hourly', postedBy: 'owner', repoPath: '/repo', nextRunAt: at(50 * 60000), ...over });
const run = (over = {}) => ({ id: 'original', scheduleId: 'schedule', postedBy: 'owner', repoPath: '/repo', state: 'in-progress', agentSessionId: 'shadow', ...over });
const status = (s = schedule(), jobs = [], sessions = new Map(), opts = {}) => scheduleStatus(s, jobs, sessions, { now, ...opts });

describe('passive schedule status', () => {
  it('separates future, due within configured interval and overdue posting', () => {
    expect(status().code).toBe('scheduled');
    const s = schedule({ nextRunAt: at(-60000) });
    expect(status(s, [], new Map(), { intervalMs: 120000 }).code).toBe('due');
    expect(status(s, [], new Map(), { intervalMs: 30000 })).toMatchObject({ code: 'overdue', graceMs: 30000 });
    expect(status(schedule({ nextRunAt: at(-120000) }), [], new Map(), { intervalMs: 120000 }).code).toBe('due');
  });
  it('uses existing active, waiting, input and gone semantics without declaring a missed firing', () => {
    const s = schedule({ nextRunAt: at(-3600000) });
    const r = run();
    for (const [session, code] of [
      [{ state: 'WORKING', lastOutputAt: now - 999999 }, 'held'],
      [{ state: 'WAITING', lastOutputAt: now }, 'held'],
      [{ state: 'WAITING', lastOutputAt: now - 180001 }, 'held-stalled'],
      [{ state: 'MESSAGE' }, 'held-needs-input'],
      [{ exited: true }, 'held-gone'],
    ]) expect(status(s, [r], new Map([['shadow', session]])).code).toBe(code);
    expect(status(s, [r])).toMatchObject({ code: 'held-gone', blocker: { id: 'original', status: 'gone' } });
  });
  it('standalone recovery and a newer completed run cannot erase the original blocker', () => {
    const jobs = [run(), run({ id: 'recovery', scheduleId: null, state: 'done' }), run({ id: 'newer', state: 'done' })];
    expect(status(schedule({ lastRunJobId: 'newer' }), jobs)).toMatchObject({ code: 'held-gone', blocker: { id: 'original' }, lastRun: { id: 'newer', state: 'done' } });
  });
  it('a queued/cap-held run has already fired; PR review holds, summary review does not', () => {
    const s = schedule({ lastRunAt: at(-3600000), lastRunJobId: 'original' });
    expect(status(s, [run({ state: 'todo', lastError: 'capacity' })])).toMatchObject({ code: 'held', lastRun: { state: 'todo', startedAt: null } });
    expect(status(s, [run({ state: 'review', requiresPr: true })]).label).toBe('Held: prior PR review');
    expect(status(s, [run({ state: 'review', requiresPr: false })]).code).toBe('scheduled');
  });
  it('keeps paused, dispatcher stopped, held, spent once and archived schedules quiet', () => {
    const s = schedule({ nextRunAt: at(-3600000) });
    expect(status({ ...s, paused: true }, [run()]).code).toBe('paused');
    expect(status(s, [run()], new Map(), { running: false }).code).toBe('stopped');
    expect(status({ ...s, holdUntil: at(60000) }).code).toBe('held');
    expect(status({ ...s, once: true, runCount: 1 }, [run()]).code).toBe('held-gone');
    expect(status({ ...s, state: 'done' }, [run()])).toMatchObject({ code: 'archived', attention: false, blocker: null });
    expect(status({ ...s, once: true }).code).toBe('overdue');
    expect(status(schedule({ once: true })).code).toBe('scheduled');
  });
  it('does not invent historical firings from legacy skips or an unavailable due cursor', () => {
    expect(status(schedule({ lastSkipAt: at(-60000), lastSkipReason: 'busy' }))).toMatchObject({ lastExpectedAt: null, observedAt: null });
    for (const nextRunAt of [null, 'bad date']) expect(status(schedule({ nextRunAt })).code).toBe('unknown');
    expect(status(schedule({ schedule: '0 0 30 2 *', nextRunAt: null })).code).toBe('unschedulable');
    expect(status(schedule({ schedule: 'invalid', nextRunAt: null })).code).toBe('unschedulable');
  });
  it('keeps delayed-loop evidence factual and marks failed posting separately', () => {
    const lastScheduleObservation = { cron: '@hourly', expectedAt: at(-3600000), observedAt: at(-60000), outcome: 'posted' };
    expect(status(schedule({ lastScheduleObservation }))).toMatchObject({ code: 'posted-late', lastExpectedAt: at(-3600000), observedAt: at(-60000), delayedByMs: 3540000 });
    expect(status(schedule({ lastScheduleObservation: { ...lastScheduleObservation, outcome: 'error' } })).code).toBe('post-error');
    expect(status(schedule({ lastScheduleObservation: { ...lastScheduleObservation, outcome: 'held' } })).code).toBe('held-previously');
    expect(status(schedule({ lastScheduleObservation: { ...lastScheduleObservation, cron: '@daily' } }))).toMatchObject({ code: 'scheduled', lastExpectedAt: null });
    expect(status(schedule({ lastScheduleObservation: { ...lastScheduleObservation, observedAt: at(60000) } })).code).toBe('clock');
    expect(status(schedule({ lastRunAt: at(60000) })).code).toBe('clock');
  });
  it('never exposes a foreign owner or repo link and never mutates cards', () => {
    const s = schedule({ lastRunJobId: 'original' });
    const jobs = [run({ postedBy: 'other' }), run({ id: 'foreign', repoPath: '/other' })];
    const before = JSON.stringify([s, jobs]);
    expect(status(s, jobs)).toMatchObject({ blocker: null, lastRun: null });
    expect(JSON.stringify([s, jobs])).toBe(before);
    expect(status({ type: 'one-time' })).toBeNull();
  });
  it('uses the scheduler timezone and existing cron DST behavior, not the browser timezone', () => {
    const script = `import { nextCronIso } from './lib/cron.js';
      import { scheduleStatus } from './lib/schedule-status.js';
      const now = Date.parse('2026-03-08T09:59:00Z');
      const due = nextCronIso('30 2 * * *', now);
      const s = {type:'scheduled',state:'todo',schedule:'30 2 * * *',nextRunAt:due};
      console.log(JSON.stringify({due,status:scheduleStatus(s,[],new Map(),{now})}));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' }));
    expect(result.due).toBe('2026-03-09T09:30:00.000Z');
    expect(result.status).toMatchObject({ code: 'scheduled', timeZone: 'America/Los_Angeles' });
    const fall = script.replaceAll('2026-03-08T09:59:00Z', '2026-11-01T07:59:00Z').replaceAll('30 2 * * *', '30 1 * * *');
    const fallResult = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', fall], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' }));
    expect(fallResult.due).toBe('2026-11-01T08:30:00.000Z');
    expect(fallResult.status.code).toBe('scheduled');
    const leap = nextCronIso('0 0 29 2 *', Date.parse('2025-03-01T00:00:00Z'));
    expect(status(schedule({ nextRunAt: leap })).code).toBe('scheduled');
  });
});
