import { describe, it, expect } from 'vitest';
import {
  createJob, resolveJobType, jobType, isScheduled, isJobDue, selectDispatchableJobs,
  buildJobPrompt, scheduleHold, supersededRuns, createRunJob, runsToPrune,
  JOB_TYPES, DEFAULT_JOB_TYPE,
} from '../lib/jobs.js';
import { nextCronIso } from '../lib/cron.js';

const REPO = '/repos/alpha';
const make = (over = {}) => {
  const { job, error } = createJob({ title: 'A job', repoPath: REPO, ...over });
  if (error) throw new Error(error);
  return job;
};

// --- Type resolution ---

describe('job types', () => {
  it('defaults to one-time, and treats a card written before types existed as one', () => {
    expect(make().type).toBe(DEFAULT_JOB_TYPE);
    expect(jobType({ title: 'legacy' })).toBe('one-time');
    expect(isScheduled({ title: 'legacy' })).toBe(false);
    expect(JOB_TYPES).toEqual(['one-time', 'scheduled']);
  });

  it('makes a card scheduled when it is given a schedule and no type', () => {
    const job = make({ schedule: '0 9 * * 1-5' });
    expect(job.type).toBe('scheduled');
    expect(job.schedule).toBe('0 9 * * 1-5');
    expect(Date.parse(job.nextRunAt)).not.toBeNaN();
    expect(job.runCount).toBe(0);
    expect(job.lastRunAt).toBeNull();
  });

  it('gives a one-time card no schedule fields to go stale', () => {
    const job = make();
    expect(job.schedule).toBeNull();
    expect(job.nextRunAt).toBeNull();
  });

  it('refuses a scheduled card whose cron does not parse, with the parser reason', () => {
    expect(createJob({ title: 'x', repoPath: REPO, type: 'scheduled' }).error).toMatch(/needs a cron schedule/i);
    expect(createJob({ title: 'x', repoPath: REPO, schedule: 'every friday' }).error).toMatch(/five fields/i);
    expect(createJob({ title: 'x', repoPath: REPO, type: 'weekly' }).error).toMatch(/unknown job type/i);
  });

  it('drops a schedule from a one-time card rather than refusing the save', () => {
    // The edit path: switching the form's type back leaves the cron text in the
    // box, and failing that save would be baffling.
    expect(resolveJobType({ type: 'one-time', schedule: '0 9 * * *' })).toEqual({ type: 'one-time', schedule: null });
  });

  it('stores a cron that can never fire, but with no next run time', () => {
    // "30 February" parses; it just never comes round. Refusing it would mean
    // the parser having to know about calendars, and the card says so instead.
    const job = make({ schedule: '0 0 30 2 *' });
    expect(job.type).toBe('scheduled');
    expect(job.nextRunAt).toBeNull();
  });
});

// --- Due-ness and dispatch selection ---

describe('isJobDue', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');

  it('always says yes to a one-time job — being in To do is the whole condition', () => {
    expect(isJobDue(make(), now)).toBe(true);
  });

  it('holds a scheduled job back until its next run time arrives', () => {
    const job = { ...make({ schedule: '0 9 * * *' }), nextRunAt: new Date(now + 60_000).toISOString() };
    expect(isJobDue(job, now)).toBe(false);
    expect(isJobDue(job, now + 60_000)).toBe(true);
  });

  it('treats a missing or unreadable next run time as due, never as stuck forever', () => {
    const job = make({ schedule: '0 9 * * *' });
    expect(isJobDue({ ...job, nextRunAt: null }, now)).toBe(true);
    expect(isJobDue({ ...job, nextRunAt: 'not a date' }, now)).toBe(true);
  });

  it('holds a paused card, scheduled or not', () => {
    // The guard sits above the scheduled check on purpose: isJobDue is the one
    // gate every dispatch route passes through, so a paused card of any kind
    // stays put without a second check at each door.
    expect(isJobDue({ ...make(), paused: true }, now)).toBe(false);
    expect(isJobDue({ title: 'one-time', paused: true }, now)).toBe(false);
    expect(isJobDue({ title: 'one-time', paused: false }, now)).toBe(true);
  });
});

describe('selectDispatchableJobs with schedules', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');

  it('never dispatches a schedule itself, due or not — it is fired instead', () => {
    const due = { ...make({ schedule: '0 9 * * *' }), nextRunAt: new Date(now - 1000).toISOString() };
    expect(selectDispatchableJobs([due], { now })).toEqual([]);
  });

  it('holds a run to the per-repo cap like any other card', () => {
    const busy = { ...make(), id: 'one', state: 'in-progress', agentSessionId: 's1' };
    const run = { ...make(), id: 'run', scheduleId: 'sched' };
    expect(selectDispatchableJobs([busy, run], { now, maxPerRepo: 1, liveSessionIds: new Set(['s1']) })).toEqual([]);
  });
});

describe('scheduleHold', () => {
  const schedule = { ...make({ schedule: '@hourly' }), id: 'sched' };
  const run = (over) => ({ ...make(), scheduleId: 'sched', ...over });

  it('fires when the schedule has no unfinished run', () => {
    expect(scheduleHold(schedule, [schedule])).toBeNull();
    expect(scheduleHold(schedule, [schedule, run({ state: 'done' })])).toBeNull();
  });

  it('holds off while the previous run is still queued or going', () => {
    expect(scheduleHold(schedule, [run({ state: 'todo' })])).toMatch(/has not started yet/);
    expect(scheduleHold(schedule, [run({ state: 'todo', lastError: 'repo gone' })])).toMatch(/could not start: repo gone/);
    expect(scheduleHold(schedule, [run({ state: 'in-progress' })])).toMatch(/still going/);
  });

  it('holds off while a PR run waits in Review, naming the PR', () => {
    expect(scheduleHold(schedule, [run({ state: 'review', requiresPr: true, prNumber: 7 })])).toMatch(/PR #7/);
  });

  it('holds off on a PR run in Review whose PR number is not known yet', () => {
    expect(scheduleHold(schedule, [run({ state: 'review', requiresPr: true, prNumber: null })])).toMatch(/previous run's pull request/);
  });

  it('fires past a no-PR run in Review — the next run supersedes it', () => {
    expect(scheduleHold(schedule, [run({ state: 'review', requiresPr: false })])).toBeNull();
  });

  it('ignores runs of other schedules', () => {
    expect(scheduleHold(schedule, [{ ...run({ state: 'in-progress' }), scheduleId: 'other' }])).toBeNull();
  });
});

describe('supersededRuns', () => {
  const run = (id, postedAt, over = {}) => ({ ...make(), id, postedAt, scheduleId: 'sched', state: 'review', requiresPr: false, ...over });

  it('names every no-PR Review run of a schedule but its newest', () => {
    const jobs = [run('a', '2026-06-10T01:00:00Z'), run('c', '2026-06-10T03:00:00Z'), run('b', '2026-06-10T02:00:00Z')];
    expect(supersededRuns(jobs).map(({ old, by }) => [old.id, by.id])).toEqual([['a', 'c'], ['b', 'c']]);
  });

  it('lets a newer PR run replace a no-PR run left from before the switch', () => {
    const jobs = [run('old', '2026-06-10T01:00:00Z'), run('pr', '2026-06-10T02:00:00Z', { requiresPr: true })];
    expect(supersededRuns(jobs).map(({ old, by }) => [old.id, by.id])).toEqual([['old', 'pr']]);
  });

  it('never supersedes a PR run, a run outside Review, or across schedules', () => {
    const jobs = [
      run('pr', '2026-06-10T01:00:00Z', { requiresPr: true }),
      run('going', '2026-06-10T01:00:00Z', { state: 'in-progress' }),
      run('mine', '2026-06-10T01:00:00Z'),
      run('theirs', '2026-06-10T02:00:00Z', { scheduleId: 'other' }),
    ];
    expect(supersededRuns(jobs)).toEqual([]);
  });
});

describe('createRunJob', () => {
  it('posts a one-time card carrying what the schedule says its runs are', () => {
    const schedule = { ...make({ title: 'Nightly', schedule: '@daily', detail: 'Check.', agent: 'codex', permissionMode: 'plan', requiresPr: true }), id: 'sched', attachments: [{ name: 'a.png', path: '/x/a.png' }] };
    const { job } = createRunJob(schedule);
    expect(job.type).toBe('one-time');
    expect(job.schedule).toBeNull();
    expect(job.scheduleId).toBe('sched');
    expect([job.title, job.detail, job.agent, job.permissionMode, job.requiresPr]).toEqual(['Nightly', 'Check.', 'codex', 'plan', true]);
    expect(job.attachments).toEqual([]);   // copied into the run's own dir by the server
    expect(createRunJob({ ...schedule, postedByAgent: 'Viper' }).job.postedByAgent).toBe('Viper');
  });

  it('gives a run of a default schedule the no-PR prompt', () => {
    const { job } = createRunJob({ ...make({ schedule: '@daily' }), id: 's' });
    expect(buildJobPrompt(job)).not.toMatch(/\/ship/);
    expect(buildJobPrompt(job)).toMatch(/finish_job[\s\S]*summary/);
  });
});

describe('a schedule that can never fire again', () => {
  // "0 0 30 2 *" parses fine and matches no date that will ever exist, so it
  // has no next run time and never will. Treating that absence as "due" would
  // dispatch the card on every single scan, for ever.
  const never = { ...make({ schedule: '0 0 30 2 *' }), state: 'todo' };

  it('is never due, even though it carries no next run time', () => {
    expect(never.nextRunAt).toBeNull();
    expect(isJobDue(never, Date.now())).toBe(false);
    expect(selectDispatchableJobs([never])).toEqual([]);
  });

  it('still lets a card whose due time merely went missing run and re-arm', () => {
    const lost = { ...make({ schedule: '0 9 * * *' }), nextRunAt: null };
    expect(isJobDue(lost, Date.now())).toBe(true);
  });
});

describe('schedule length', () => {
  it('refuses an over-long schedule rather than storing a truncated prefix', () => {
    // Truncating first would either hide the error or silently keep a
    // valid-looking prefix of something the user did not write.
    const tooLong = '0 9 * * ' + '1,'.repeat(100) + '5';
    expect(createJob({ title: 'x', repoPath: REPO, schedule: tooLong }).error).toMatch(/too long/i);
  });
});

describe('runsToPrune', () => {
  const done = (id, doneAt, scheduleId = 's') => ({ ...make(), id, scheduleId, state: 'done', doneAt });

  it('keeps each schedule\'s newest finished runs and names the rest, oldest first', () => {
    const jobs = [done('a', '2026-01-01'), done('c', '2026-01-03'), done('b', '2026-01-02'), done('x', '2026-01-01', 'other')];
    expect(runsToPrune(jobs, 2).map(j => j.id)).toEqual(['a']);
  });

  it('leaves unfinished runs and one-time cards alone', () => {
    const jobs = [done('a', '2026-01-01'), { ...done('live', '2026-01-02'), state: 'review' }, { ...make(), id: 'plain', state: 'done' }];
    expect(runsToPrune(jobs, 0).map(j => j.id)).toEqual(['a']);
  });
});
