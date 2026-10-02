// Scheduled one-time jobs: `run_at` (and `once` with a schedule, for old
// callers) makes one card with a start time; the dispatcher waits for it; a
// server start converts pending once schedules; the restart sweep of spent
// one-date schedules; archiving by hand (the owner's Archive, Billion's
// close_job on a To do card is in billion-board-tools.test.js).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions, CONFIG_PATH, CONFIG_DIR } from '../server/state.js';
import { loadConfig } from '../server/config.js';
import {
  addJob, fireSchedules, allJobs, boardSettings, postJobForAgent, editJobForAgent,
  archiveJob, retireSpentSchedules, convertOnceSchedules, updateJob, releaseJobHold,
} from '../server/jobs.js';
import { createJob, parseRunAt, isOneDateCron, spentOneDateSchedules, isJobDue, selectDispatchableJobs } from '../lib/jobs.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-once-'));
const noop = () => {};

beforeEach(() => {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
});

describe('parseRunAt', () => {
  const now = new Date(2026, 9, 1, 9, 0).getTime();   // 1 Oct 2026, 09:00 local

  it('turns a date-time into that minute as an instant, local time', () => {
    expect(parseRunAt('2026-10-24T10:30:45', now)).toEqual({ runAt: new Date(2026, 9, 24, 10, 30).toISOString() });
  });

  it('refuses a time gone by, more than a year out, or not a date', () => {
    expect(parseRunAt('2026-09-24T10:00', now).error).toMatch(/already gone by/);
    expect(parseRunAt('2027-12-01T10:00', now).error).toMatch(/more than a year/);
    expect(parseRunAt('next tuesday', now).error).toMatch(/not a date-time/);
    expect(parseRunAt(42, now).error).toMatch(/ISO date-time/);
  });
});

describe('isOneDateCron / spentOneDateSchedules', () => {
  it('knows the one-date shape: fixed minute, hour, day and month, any weekday', () => {
    expect(isOneDateCron('0 10 24 9 *')).toBe(true);
    expect(isOneDateCron('30 10 1 10 *')).toBe(true);
    expect(isOneDateCron('0 10 * 9 *')).toBe(false);
    expect(isOneDateCron('0 10 24 9 1')).toBe(false);
    expect(isOneDateCron('0 9 1,15 * *')).toBe(false);
    expect(isOneDateCron('@yearly')).toBe(false);
  });

  it('finds the ones in To do that have already run, and leaves the rest', () => {
    const job = (over) => ({ ...createJob({ title: 't', repoPath: REPO, schedule: '0 10 24 9 *' }).job, ...over });
    const spent = job({ runCount: 1, lastRunAt: '2026-09-24T10:00:00Z' });
    const notYet = job({});
    const weekly = { ...createJob({ title: 't', repoPath: REPO, schedule: '0 9 * * 1' }).job, runCount: 3 };
    const archived = job({ runCount: 1, state: 'done' });
    expect(spentOneDateSchedules([spent, notYet, weekly, archived])).toEqual([spent]);
  });
});

describe('a scheduled job', () => {
  const inDays = d => new Date(Date.now() + d * 86_400_000);

  it('is posted with run_at as one one-time card with a start time: no schedule, no run card', () => {
    const at = inDays(3);
    const r = postJobForAgent({ title: 'Follow up with Edward', repo: REPO, runAt: at.toISOString() }, noop);
    expect(r.error).toBeUndefined();
    expect(r.job).toMatchObject({ type: 'one-time', schedule: null, nextRunAt: null, requiresPr: true });
    expect(Math.abs(Date.parse(r.job.runAt) - at.getTime())).toBeLessThan(60_000);
    expect(fireSchedules(noop, { now: at.getTime() + 60_000 })).toEqual([]);
    expect(allJobs()).toHaveLength(1);
  });

  it('is what an old caller\'s once: true with a one-date schedule makes too', () => {
    const r = postJobForAgent({ title: 'old caller', repo: REPO, schedule: '0 10 24 9 *', once: true }, noop);
    expect(r.job).toMatchObject({ type: 'one-time', schedule: null });
    expect(new Date(r.job.runAt).getDate()).toBe(24);
    expect(new Date(r.job.runAt).getHours()).toBe(10);
  });

  it('waits in To do until its start time, then the dispatcher takes the same card', () => {
    const { job } = addJob({ title: 'later', repoPath: REPO, runAt: inDays(1).toISOString() }, noop);
    expect(isJobDue(job)).toBe(false);
    expect(selectDispatchableJobs(allJobs())).toEqual([]);
    const due = Date.parse(job.runAt);
    expect(selectDispatchableJobs(allJobs(), { now: due })).toEqual([job]);
  });

  it('Run now lets it go at once', () => {
    const { job } = addJob({ title: 'later', repoPath: REPO, runAt: inDays(1).toISOString() }, noop);
    releaseJobHold(job.id, noop);
    expect(job.runAt).toBeNull();
    expect(selectDispatchableJobs(allJobs())).toEqual([job]);
  });

  it('is edited by moving its time, cleared by Now, and made a schedule by Recurring', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO, runAt: inDays(1).toISOString() }, noop);
    const later = inDays(5);
    const r = editJobForAgent({ id: job.id, runAt: later.toISOString() }, noop);
    expect(r.changed).toContain('run_at');
    expect(Math.abs(Date.parse(job.runAt) - later.getTime())).toBeLessThan(60_000);
    // the form: Scheduled with the time left alone sends no runAt
    expect(updateJob(job.id, { type: 'one-time', title: 'y' }, noop).job.runAt).toBe(job.runAt);
    expect(updateJob(job.id, { type: 'one-time', runAt: null }, noop).job.runAt).toBeNull();
    updateJob(job.id, { runAt: inDays(2).toISOString() }, noop);
    updateJob(job.id, { type: 'scheduled', schedule: '0 9 * * 1' }, noop);
    expect(job).toMatchObject({ type: 'scheduled', runAt: null });
  });

  it('refuses run_at with a schedule, once on a card with no schedule, a non-boolean once, and a bad time', () => {
    const later = inDays(1).toISOString();
    expect(postJobForAgent({ title: 'x', repo: REPO, runAt: later, schedule: '0 9 * * *' }, noop).error).toMatch(/not both/);
    expect(postJobForAgent({ title: 'x', repo: REPO, once: true }, noop).error).toMatch(/once needs a schedule/);
    expect(postJobForAgent({ title: 'x', repo: REPO, schedule: '0 9 * * *', once: 'yes' }, noop).error).toMatch(/true or false/);
    expect(postJobForAgent({ title: 'x', repo: REPO, runAt: '2020-01-01T09:00' }, noop).error).toMatch(/gone by/);
    expect(allJobs()).toHaveLength(0);
  });

  it('a recurring schedule is untouched: it posts a run, re-arms and stays in To do', () => {
    const { job } = addJob({ title: 'weekly', repoPath: REPO, schedule: '0 9 * * 1' }, noop);
    const due = Date.parse(job.nextRunAt);
    expect(fireSchedules(noop, { now: due })).toHaveLength(1);
    expect(job.state).toBe('todo');
    expect(Date.parse(job.nextRunAt)).toBeGreaterThan(due);
  });
});

describe('converting once schedules on a server start', () => {
  it('turns a pending once schedule into the same card with runAt, and leaves the rest alone', () => {
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const pending = {
      ...createJob({ title: 'Oct 2 check-in', detail: 'd', repoPath: REPO, schedule: '0 10 2 10 *', agent: 'codex', postedByBillion: true, postedByName: 'Bill' }).job,
      once: true, nextRunAt: due, attachments: [{ name: 'a.txt', path: '/x/a.txt' }], permissionMode: 'plan',
    };
    const archived = { ...createJob({ title: 'fired', repoPath: REPO, schedule: '0 10 24 9 *' }).job, once: true, state: 'done', runCount: 1 };
    const run = { ...createJob({ title: 'its run', repoPath: REPO }).job, scheduleId: archived.id };
    const weekly = createJob({ title: 'weekly', repoPath: REPO, schedule: '0 9 * * 1' }).job;
    config.jobs.push(pending, archived, run, weekly);
    const before = { ...pending };
    const lines = [];
    expect(convertOnceSchedules(noop, { log: l => lines.push(l) })).toEqual([pending]);
    expect(pending).toMatchObject({
      id: before.id, title: before.title, detail: 'd', repoPath: REPO, agent: 'codex', model: null,
      requiresPr: false, attachments: before.attachments, permissionMode: 'plan', postedByBillion: true, postedByName: 'Bill',
      type: 'one-time', schedule: null, nextRunAt: null, runAt: due, state: 'todo',
    });
    expect(pending).not.toHaveProperty('once');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Oct 2 check-in/);
    expect(archived).toMatchObject({ state: 'done', type: 'scheduled', once: true });
    expect(run.scheduleId).toBe(archived.id);
    expect(weekly).toMatchObject({ type: 'scheduled', schedule: '0 9 * * 1' });
  });
});

describe('archiving', () => {
  it('files a To do card to Finished with a note, keeping it', () => {
    const { job } = addJob({ title: 'not needed', repoPath: REPO, schedule: '0 9 * * 1' }, noop);
    const r = archiveJob(job.id, { reason: 'Archived from the Jobs tab', by: 'Bill' }, noop);
    expect(r.error).toBeUndefined();
    expect(job.state).toBe('done');
    expect(job.archivedBy).toBe('Bill');
    expect(job.archivedReason).toBe('Archived from the Jobs tab');
    expect(job.nextRunAt).toBeNull();
    expect(allJobs()).toContain(job);
    expect(fireSchedules(noop, { now: Date.now() + 30 * 86_400_000 })).toEqual([]);
  });

  it('refuses a card that has left To do', () => {
    const { job } = addJob({ title: 'running', repoPath: REPO }, noop);
    job.state = 'in-progress';
    expect(archiveJob(job.id, {}, noop).error).toMatch(/only a To do card/);
  });

  it('archives spent one-date schedules on a server start, logging each', () => {
    const { job: spent } = addJob({ title: 'Edward Jordan: one conditional follow-up September 24', repoPath: REPO, schedule: '0 10 24 9 *' }, noop);
    Object.assign(spent, { runCount: 1, lastRunAt: '2026-09-24T10:00:00Z' });
    const { job: waiting } = addJob({ title: 'not yet', repoPath: REPO, schedule: '0 10 24 12 *' }, noop);
    const lines = [];
    retireSpentSchedules(noop, { log: line => lines.push(line) });
    expect(spent.state).toBe('done');
    expect(spent.archivedReason).toMatch(/already run/);
    expect(waiting.state).toBe('todo');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Edward Jordan/);
  });
});

describe('an archived schedule across a restart', () => {
  afterEach(() => { try { rmSync(CONFIG_PATH); } catch {} });

  it('stays archived, rather than going back to To do', () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({
      version: 1, repos: [], orphans: [], activeSessions: [],
      jobs: [{ id: 's1', title: 'once', type: 'scheduled', schedule: '0 10 24 9 *', once: true, repoPath: '/r', state: 'done', archivedAt: '2026-09-24T10:00:00Z' }],
    }));
    loadConfig();
    expect(config.jobs[0].state).toBe('done');
  });
});
