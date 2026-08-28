import { describe, it, expect } from 'vitest';
import {
  createJob, resolveJobType, jobType, isScheduled, isJobDue, selectDispatchableJobs,
  buildJobPrompt, buildJobCommand, isScheduledRunOver, scheduledRunReset,
  JOB_TYPES, DEFAULT_JOB_TYPE, STALLED_AFTER_MS,
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
});

describe('selectDispatchableJobs with scheduled jobs', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');
  const soon = new Date(now + 3600_000).toISOString();

  it('leaves a job that is not due yet in To do', () => {
    const jobs = [{ ...make({ schedule: '0 9 * * *' }), nextRunAt: soon }];
    expect(selectDispatchableJobs(jobs, { now })).toEqual([]);
  });

  it('dispatches it once it comes due', () => {
    const jobs = [{ ...make({ schedule: '0 9 * * *' }), nextRunAt: new Date(now - 1000).toISOString() }];
    expect(selectDispatchableJobs(jobs, { now })).toHaveLength(1);
  });

  it('does not let a job waiting on its schedule block the queue behind it', () => {
    // The pending scheduled card is FIRST in posting order. If it consumed a
    // slot (or stopped the walk) the one-time job behind it would never go out.
    const pending = { ...make({ schedule: '0 9 * * *' }), id: 'sched', postedAt: '2026-01-01T00:00:00Z', nextRunAt: soon };
    const queued = { ...make(), id: 'one', postedAt: '2026-01-02T00:00:00Z' };
    const selected = selectDispatchableJobs([pending, queued], { now, maxPerRepo: 1 });
    expect(selected.map(j => j.id)).toEqual(['one']);
  });

  it('still counts a scheduled run in flight against the per-repo cap', () => {
    const running = { ...make({ schedule: '0 9 * * *' }), id: 'sched', state: 'in-progress', agentSessionId: 's1' };
    const queued = { ...make(), id: 'one' };
    expect(selectDispatchableJobs([running, queued], { now, maxPerRepo: 1 })).toEqual([]);
  });
});

// --- Prompt ---

describe('the scheduled prompt', () => {
  const scheduled = make({ title: 'Summarise yesterday', schedule: '0 9 * * *', detail: 'Read the log.' });

  it('drops the review/ship instruction, which assumes a coding task', () => {
    const prompt = buildJobPrompt(scheduled);
    expect(prompt).not.toMatch(/\/review/);
    expect(prompt).not.toMatch(/\/ship/);
    expect(prompt).not.toMatch(/pull request the board watches|watches for the pull request/i);
    // And says so out loud, so the agent does not invent a change to ship.
    expect(prompt).toMatch(/not necessarily a coding task/i);
    expect(prompt).toMatch(/do not open a pull request unless/i);
  });

  it('keeps the title, the detail and the schedule that produced the run', () => {
    const prompt = buildJobPrompt(scheduled);
    expect(prompt.startsWith('Summarise yesterday\n\nRead the log.')).toBe(true);
    expect(prompt).toContain('(0 9 * * *)');
  });

  it('keeps telling the agent to assume rather than ask — nobody is watching', () => {
    expect(buildJobPrompt(scheduled)).toMatch(/prefer a reasonable assumption over a\s+question/i);
  });

  it('leaves the one-time prompt exactly as it was', () => {
    const prompt = buildJobPrompt(make({ title: 'Add caching' }));
    expect(prompt).toMatch(/when the work is finished, run \/ship/i);
    expect(prompt).not.toMatch(/scheduled run/i);
  });

  it('still ships as a single quoted argv', () => {
    expect(buildJobCommand(scheduled)).toMatch(/^claude --permission-mode auto "/);
  });
});

// --- Run completion ---

describe('isScheduledRunOver', () => {
  const now = Date.now();
  const job = { ...make({ schedule: '0 9 * * *' }), state: 'in-progress' };
  const session = (over = {}) => ({ state: 'WORKING', exited: false, lastOutputAt: now, ...over });

  it('is over when the agent exited, or when there is no session left at all', () => {
    expect(isScheduledRunOver(job, session({ exited: true }), { now })).toBe(true);
    expect(isScheduledRunOver(job, null, { now })).toBe(true);
  });

  it('is over when the agent has been parked at its prompt past the quiet window', () => {
    expect(isScheduledRunOver(job, session({ state: 'WAITING', lastOutputAt: now - STALLED_AFTER_MS - 1000 }), { now })).toBe(true);
  });

  it('is not over while the agent is working, or only just went quiet', () => {
    expect(isScheduledRunOver(job, session(), { now })).toBe(false);
    expect(isScheduledRunOver(job, session({ state: 'WAITING', lastOutputAt: now - 1000 }), { now })).toBe(false);
  });

  it('is never over while the agent is asking the user something', () => {
    // Killing it would throw away the answer it is waiting for; the card shows
    // "needs you" and holds its slot, exactly as a one-time job does.
    const asking = session({ state: 'MESSAGE', lastOutputAt: now - STALLED_AFTER_MS - 60_000 });
    expect(isScheduledRunOver(job, asking, { now })).toBe(false);
  });

  it('says nothing about one-time jobs or about cards that are not running', () => {
    expect(isScheduledRunOver({ ...make(), state: 'in-progress' }, null, { now })).toBe(false);
    expect(isScheduledRunOver({ ...job, state: 'todo' }, null, { now })).toBe(false);
  });
});

describe('scheduledRunReset', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');

  it('re-arms the card in To do with its next run measured from now', () => {
    const job = {
      ...make({ schedule: '0 9 * * *' }), state: 'in-progress',
      agentSessionId: 's1', agentName: 'Viper', branchName: 'bill/x',
      worktreePath: '/wt/1', startedAt: 'whenever', prCheckError: 'stale',
      lastError: 'agent lost', lastRunAt: '2026-06-10T09:00:00.000Z',
    };
    const reset = scheduledRunReset(job, now);
    expect(reset.state).toBe('todo');
    expect(reset.agentSessionId).toBeNull();
    expect(reset.agentName).toBeNull();
    expect(reset.branchName).toBeNull();
    expect(reset.worktreePath).toBeNull();
    expect(reset.prCheckError).toBeNull();
    // A completed run supersedes whatever went wrong before it.
    expect(reset.lastError).toBeNull();
    // But not lastRunAt: that is set once at dispatch and means when the last
    // run STARTED, the one reading still meaningful after startedAt is cleared.
    expect(reset.lastRunAt).toBeUndefined();
    // From now, not stepped on from the previous due time — so a run that
    // overran its own interval does not come due again the instant it lands.
    expect(reset.nextRunAt).toBe(nextCronIso('0 9 * * *', now));
    expect(Date.parse(reset.nextRunAt)).toBeGreaterThan(now);
  });

  it('leaves no next run time on a schedule that will never come round again', () => {
    const job = { ...make({ schedule: '0 0 30 2 *' }), state: 'in-progress' };
    expect(scheduledRunReset(job, now).nextRunAt).toBeNull();
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
