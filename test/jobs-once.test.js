// One-time schedules: `once` / `run_at`, archiving after the single run, the
// restart sweep of spent one-date schedules, and archiving by hand (the
// owner's Archive, Billion's retire_job is in billion-board-tools.test.js).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions, CONFIG_PATH, CONFIG_DIR } from '../server/state.js';
import { loadConfig } from '../server/config.js';
import {
  addJob, fireSchedules, allJobs, boardSettings, postJobForAgent, editJobForAgent,
  archiveJob, retireSpentSchedules, updateJob,
} from '../server/jobs.js';
import { createJob, runAtToSchedule, isOneDateCron, spentOneDateSchedules, isJobDue } from '../lib/jobs.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-once-'));
const noop = () => {};

beforeEach(() => {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
});

describe('runAtToSchedule', () => {
  const now = new Date(2026, 9, 1, 9, 0).getTime();   // 1 Oct 2026, 09:00 local

  it('turns a date-time into the one-date cron for that minute, local time', () => {
    expect(runAtToSchedule('2026-10-24T10:30', now)).toEqual({ schedule: '30 10 24 10 *' });
  });

  it('refuses a time gone by, more than a year out, or not a date', () => {
    expect(runAtToSchedule('2026-09-24T10:00', now).error).toMatch(/already gone by/);
    expect(runAtToSchedule('2027-12-01T10:00', now).error).toMatch(/more than a year/);
    expect(runAtToSchedule('next tuesday', now).error).toMatch(/not a date-time/);
    expect(runAtToSchedule(42, now).error).toMatch(/ISO date-time/);
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

describe('a once schedule', () => {
  it('is posted with run_at as a one-date schedule with once set', () => {
    const at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const r = postJobForAgent({ title: 'Follow up with Edward', repo: REPO, runAt: at.toISOString() }, noop);
    expect(r.error).toBeUndefined();
    expect(r.job.type).toBe('scheduled');
    expect(r.job.once).toBe(true);
    expect(isOneDateCron(r.job.schedule)).toBe(true);
    expect(Math.abs(Date.parse(r.job.nextRunAt) - at.getTime())).toBeLessThan(60_000);
  });

  it('refuses run_at with a schedule, once on a card with no schedule, and a non-boolean once', () => {
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect(postJobForAgent({ title: 'x', repo: REPO, runAt: later, schedule: '0 9 * * *' }, noop).error).toMatch(/not both/);
    expect(postJobForAgent({ title: 'x', repo: REPO, once: true }, noop).error).toMatch(/once needs a schedule/);
    expect(postJobForAgent({ title: 'x', repo: REPO, schedule: '0 9 * * *', once: 'yes' }, noop).error).toMatch(/true or false/);
  });

  it('posts its single run, then is archived; its run card lives on', () => {
    const { job } = addJob({ title: 'Oct 1 check-in', repoPath: REPO, schedule: '30 10 1 10 *', once: true }, noop);
    const due = Date.parse(job.nextRunAt);
    const fired = fireSchedules(noop, { now: due });
    expect(fired).toHaveLength(1);
    expect(fired[0].scheduleId).toBe(job.id);
    expect(fired[0].state).toBe('todo');
    expect(job.state).toBe('done');
    expect(job.archivedReason).toMatch(/One-time schedule/);
    expect(job.nextRunAt).toBeNull();
    expect(job.runCount).toBe(1);
    // And it never fires again.
    expect(fireSchedules(noop, { now: due + 365 * 86_400_000 })).toEqual([]);
    expect(allJobs()).toHaveLength(2);
  });

  it('stays due through a hold instead of moving to next year', () => {
    const { job } = addJob({ title: 'once', repoPath: REPO, schedule: '0 10 24 9 *', once: true }, noop);
    const due = Date.parse(job.nextRunAt);
    // An unfinished run of the same schedule holds it off.
    allJobs().push({ ...createJob({ title: 'run', repoPath: REPO }).job, scheduleId: job.id, state: 'in-progress' });
    expect(fireSchedules(noop, { now: due })).toEqual([]);
    expect(job.state).toBe('todo');
    expect(Date.parse(job.nextRunAt)).toBe(due);
    expect(isJobDue(job, due + 60_000)).toBe(true);
  });

  it('a recurring schedule is untouched: it re-arms and stays in To do', () => {
    const { job } = addJob({ title: 'weekly', repoPath: REPO, schedule: '0 9 * * 1' }, noop);
    fireSchedules(noop, { now: Date.parse(job.nextRunAt) });
    expect(job.state).toBe('todo');
    expect(job.once).toBe(false);
  });

  it('can be set or cleared with edit_job, and is cleared when the schedule goes', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO, schedule: '0 10 24 9 *' }, noop);
    const r = editJobForAgent({ id: job.id, once: true }, noop);
    expect(r.changed).toEqual(['once']);
    expect(job.once).toBe(true);
    updateJob(job.id, { type: 'one-time', schedule: '' }, noop);
    expect(job.once).toBe(false);
    expect(updateJob(job.id, { once: true }, noop).error).toMatch(/once needs a schedule/);
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
