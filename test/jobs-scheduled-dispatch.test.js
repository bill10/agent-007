import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import {
  addJob, updateJob, moveJob, dispatchOnce, fireSchedules, supersedeRuns, finishJobForAgent, pruneFinishedRuns,
  runScan, allJobs, boardSettings, jobsPayload, postJobForAgent, setJobPaused,
} from '../server/jobs.js';
import { jobType } from '../lib/jobs.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-sched-'));
const noopBroadcast = () => {};

function resetBoard() {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
}

// Same stand-in as jobs-dispatch.test.js: records its arguments, hands back a
// session shaped like the real one, spawns nothing.
function fakeCreateSession(calls) {
  let n = 0;
  return async (command, name, repoPath, branch, ownerId, meta) => {
    calls.push({ command, repoPath, branch, meta });
    n++;
    const session = {
      id: `session-${n}`, name: `Agent${n}`, command, repoPath,
      branchName: `bill/cocktail${n}`, worktreePath: `/wt/${n}`,
      state: 'WORKING', exited: false, lastOutputAt: Date.now(),
      spawnedBy: meta?.spawnedBy, jobId: meta?.jobId,
    };
    sessions.set(session.id, session);
    return { session };
  };
}

// Records which sessions were closed, and closes them the way killSession does.
function fakeKillSession(killed) {
  return async (id) => {
    killed.push(id);
    sessions.delete(id);
  };
}

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 3600_000).toISOString();

beforeEach(resetBoard);

// A schedule that is due right now.
function dueSchedule(over = {}) {
  const { job } = addJob({ title: 'Hourly check', repoPath: REPO, schedule: '@hourly', ...over }, noopBroadcast);
  job.nextRunAt = past();
  return job;
}
const runsOf = (schedule) => allJobs().filter(j => j.scheduleId === schedule.id);

describe('firing a schedule', () => {
  it('waits for the schedule instead of firing the moment it is posted', () => {
    addJob({ title: 'Daily digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    expect(fireSchedules(noopBroadcast)).toEqual([]);
    expect(allJobs()).toHaveLength(1);
  });

  it('posts a run card when due, and the run goes out while the schedule stays put', async () => {
    const schedule = dueSchedule();
    const [run] = fireSchedules(noopBroadcast);
    expect(run.scheduleId).toBe(schedule.id);
    expect(schedule.runCount).toBe(1);
    expect(schedule.lastRunJobId).toBe(run.id);
    expect(Date.parse(schedule.nextRunAt)).toBeGreaterThan(Date.now());

    const calls = [];
    const dispatched = await dispatchOnce(fakeCreateSession(calls), noopBroadcast);
    expect(dispatched.map(d => d.job.id)).toEqual([run.id]);
    expect(calls[0].command).not.toMatch(/\/ship/);   // a default schedule's runs report a summary
    expect(schedule.state).toBe('todo');
    expect(run.state).toBe('in-progress');
  });

  it('fires and dispatches the run in one scan', async () => {
    const schedule = dueSchedule();
    const calls = [];
    await runScan(fakeCreateSession(calls), noopBroadcast, { killSession: fakeKillSession([]), findPr: async () => ({}), findMerged: async () => ({}) });
    expect(runsOf(schedule)[0].state).toBe('in-progress');
  });
});

describe('a schedule whose run cannot be posted', () => {
  it('records why on the schedule, moves on, and clears it once a run goes out', () => {
    const schedule = dueSchedule();
    schedule.title = '';   // hand-edited config.json: createJob refuses a blank title
    expect(fireSchedules(noopBroadcast)).toEqual([]);
    expect(runsOf(schedule)).toHaveLength(0);
    expect(schedule.lastError).toMatch(/Could not post this run: Title is required/);
    expect(schedule.runCount).toBe(0);
    expect(Date.parse(schedule.nextRunAt)).toBeGreaterThan(Date.now());

    schedule.title = 'Hourly check';
    schedule.nextRunAt = past();
    expect(fireSchedules(noopBroadcast)).toHaveLength(1);
    expect(schedule.lastError).toBeNull();
    expect(schedule.lastErrorAt).toBeNull();
  });
});

describe('a schedule holding off', () => {
  it('skips a firing while the previous run is still going, and says so', async () => {
    const schedule = dueSchedule();
    fireSchedules(noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    schedule.nextRunAt = past();
    expect(fireSchedules(noopBroadcast)).toEqual([]);
    expect(runsOf(schedule)).toHaveLength(1);
    expect(schedule.lastSkipReason).toMatch(/still going/);
    // Moved on rather than retried every scan: a skipped firing is not replayed.
    expect(Date.parse(schedule.nextRunAt)).toBeGreaterThan(Date.now());
  });

  it('skips while a PR run waits in Review, and fires once it is done', async () => {
    const schedule = dueSchedule({ requiresPr: true });
    const [run] = fireSchedules(noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const pr = { url: 'https://github.com/o/r/pull/7', number: 7 };
    await finishJobForAgent({ session: sessions.get(run.agentSessionId), prUrl: pr.url }, noopBroadcast, { findPr: async () => ({ pr }) });
    expect(run.state).toBe('review');

    schedule.nextRunAt = past();
    expect(fireSchedules(noopBroadcast)).toEqual([]);
    expect(schedule.lastSkipReason).toMatch(/PR #7/);

    await moveJob(run.id, 'done', noopBroadcast, { killSession: fakeKillSession([]) });
    schedule.nextRunAt = past();
    expect(fireSchedules(noopBroadcast)).toHaveLength(1);
    expect(schedule.lastSkipReason).toBeNull();
  });
});

describe('superseding no-PR runs', () => {
  // One creator for the whole test, so session ids do not repeat.
  let create;
  beforeEach(() => { create = fakeCreateSession([]); });

  // Two runs of one schedule, both finished and waiting in Review.
  async function twoFinishedRuns() {
    const schedule = dueSchedule();
    const runs = [];
    for (const summary of ['first', 'second']) {
      schedule.nextRunAt = past();
      const [run] = fireSchedules(noopBroadcast);
      run.postedAt = new Date(Date.now() + runs.length).toISOString();   // strictly ordered
      await dispatchOnce(create, noopBroadcast);
      await finishJobForAgent({ session: sessions.get(run.agentSessionId), summary }, noopBroadcast);
      sessions.get(run.agentSessionId).state = 'WAITING';   // done, idle at its prompt
      runs.push(run);
    }
    return { schedule, runs };
  }

  it('fires past a no-PR run in Review, then files the older one away with its agent', async () => {
    const { runs: [first, second] } = await twoFinishedRuns();
    const firstAgent = first.agentSessionId;
    const killed = [];
    await supersedeRuns(noopBroadcast, { killSession: fakeKillSession(killed) });
    expect(first.state).toBe('done');
    expect(first.supersededBy).toBe(second.id);
    expect(first.resultSummary).toBe('first');   // kept in the archive
    expect(killed).toEqual([firstAgent]);
    expect(second.state).toBe('review');
    expect(second.supersededRuns).toBe(1);
  });

  it('leaves a run whose agent is busy for a later scan', async () => {
    const { runs: [first] } = await twoFinishedRuns();
    sessions.get(first.agentSessionId).state = 'MESSAGE';   // someone is talking to it
    await supersedeRuns(noopBroadcast, { killSession: fakeKillSession([]) });
    expect(first.state).toBe('review');
    sessions.get(first.agentSessionId).state = 'WAITING';
    await supersedeRuns(noopBroadcast, { killSession: fakeKillSession([]) });
    expect(first.state).toBe('done');
  });

  it('keeps the run that reached Review last, even if it was posted first', async () => {
    const { runs: [first, second] } = await twoFinishedRuns();
    first.reviewAt = new Date(Date.now() + 60_000).toISOString();   // sent back and returned
    await supersedeRuns(noopBroadcast, { killSession: fakeKillSession([]) });
    expect(second.state).toBe('done');
    expect(first.state).toBe('review');
  });

  it('carries the count forward, so the newest says how many went unread', async () => {
    const { schedule, runs: [, second] } = await twoFinishedRuns();
    await supersedeRuns(noopBroadcast, { killSession: fakeKillSession([]) });
    schedule.nextRunAt = past();
    const [third] = fireSchedules(noopBroadcast);
    third.postedAt = new Date(Date.now() + 10).toISOString();
    await dispatchOnce(create, noopBroadcast);
    await finishJobForAgent({ session: sessions.get(third.agentSessionId), summary: 'third' }, noopBroadcast);
    sessions.get(third.agentSessionId).state = 'WAITING';
    await supersedeRuns(noopBroadcast, { killSession: fakeKillSession([]) });
    expect(second.state).toBe('done');
    expect(third.supersededRuns).toBe(2);
  });
  it('leaves a run where it is when the move to Done is refused, and counts nothing', async () => {
    const { runs: [first, second] } = await twoFinishedRuns();
    // A run card hand-edited into a schedule: moveJob refuses every move of one.
    Object.assign(first, { type: 'scheduled', schedule: '@hourly' });
    expect(await supersedeRuns(noopBroadcast, { killSession: fakeKillSession([]) })).toEqual([]);
    expect(first.state).toBe('review');
    expect(first.supersededBy).toBeUndefined();
    expect(second.supersededRuns).toBeUndefined();
  });
});

describe('pausing a schedule', () => {
  it('holds a due schedule until it is resumed, without replaying the held firing', () => {
    const schedule = dueSchedule();
    setJobPaused(schedule.id, true, noopBroadcast);
    expect(fireSchedules(noopBroadcast)).toEqual([]);

    setJobPaused(schedule.id, false, noopBroadcast);
    expect(Date.parse(schedule.nextRunAt)).toBeGreaterThan(Date.now());
    expect(fireSchedules(noopBroadcast)).toEqual([]);

    schedule.nextRunAt = past();
    expect(fireSchedules(noopBroadcast)).toHaveLength(1);
  });

  it('leaves a run already posted alone', async () => {
    const schedule = dueSchedule();
    const [run] = fireSchedules(noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    setJobPaused(schedule.id, true, noopBroadcast);
    expect(run.state).toBe('in-progress');
    expect(sessions.has(run.agentSessionId)).toBe(true);
  });

  it('rejects an unknown card and no-ops a repeat of the state it is in', () => {
    addJob({ title: 'Daily digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const job = allJobs()[0];
    expect(setJobPaused('nope', true, noopBroadcast).error).toBeTruthy();
    setJobPaused(job.id, true, noopBroadcast);
    const armed = allJobs()[0].nextRunAt;
    setJobPaused(job.id, true, noopBroadcast);
    expect(allJobs()[0].nextRunAt).toBe(armed);
  });
});

describe('editing and moving a schedule', () => {
  it('recomputes the next run when the schedule changes', () => {
    addJob({ title: 'Digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const job = allJobs()[0];
    const before = Date.parse(job.nextRunAt);
    updateJob(job.id, { schedule: '*/5 * * * *' }, noopBroadcast);
    expect(job.schedule).toBe('*/5 * * * *');
    // The old due time belonged to the old cron, so it must not survive: every
    // five minutes is at most five minutes away, not up to a day.
    const after = Date.parse(job.nextRunAt);
    // Or-equal: between 08:55 and 09:00 both crons resolve to the same 09:00,
    // and the upper bound below is what proves the recompute happened.
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThan(Date.now());
    expect(after).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it('refuses a broken cron without half-applying the type change', () => {
    addJob({ title: 'Digest', repoPath: REPO }, noopBroadcast);
    const job = allJobs()[0];
    const before = { type: job.type, schedule: job.schedule };
    expect(updateJob(job.id, { type: 'scheduled', schedule: 'every friday' }, noopBroadcast).error).toMatch(/five fields/i);
    expect(job.type).toBe(before.type);
    expect(job.schedule).toBe(before.schedule);
  });

  it('turns a scheduled card back into a one-time one, clearing what no longer applies', () => {
    addJob({ title: 'Digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const job = allJobs()[0];
    updateJob(job.id, { type: 'one-time', schedule: '0 9 * * *' }, noopBroadcast);
    expect(job.type).toBe('one-time');
    expect(job.schedule).toBeNull();
    expect(job.nextRunAt).toBeNull();
  });

  it('lets an ordinary save resend the same type and schedule, without eating a due firing', () => {
    addJob({ title: 'Digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const job = allJobs()[0];
    job.nextRunAt = past();   // overdue — a firing is about to happen
    updateJob(job.id, { title: 'Digest v2', type: 'scheduled', schedule: '0 9 * * *' }, noopBroadcast);
    expect(job.title).toBe('Digest v2');
    // The save resent the current schedule; the pending firing survives.
    expect(Date.parse(job.nextRunAt)).toBeLessThan(Date.now());
  });

  it('refuses to move a schedule anywhere — its runs are the cards that move', async () => {
    addJob({ title: 'Digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const job = allJobs()[0];
    for (const state of ['in-progress', 'review', 'done']) {
      expect((await moveJob(job.id, state, noopBroadcast, {})).error).toMatch(/schedule stays in To do/);
    }
    expect(job.state).toBe('todo');
  });
});

describe('posting a scheduled job on an agent behalf', () => {
  it('takes a bare schedule and reports back the card it made', () => {
    const result = postJobForAgent({ title: 'Digest', repo: REPO, schedule: '@daily' }, noopBroadcast);
    expect(result.error).toBeUndefined();
    expect(result.job.type).toBe('scheduled');
    expect(result.job.schedule).toBe('@daily');
    expect(Date.parse(result.job.nextRunAt)).not.toBeNaN();
  });

  it('rejects a non-string schedule instead of silently making a one-time card', () => {
    expect(postJobForAgent({ title: 'Digest', repo: REPO, schedule: 30 }, noopBroadcast).error).toMatch(/schedule must be a string/i);
    expect(allJobs()).toHaveLength(0);
  });

  it('hands the cron error back to the agent instead of queueing a card that never fires', () => {
    expect(postJobForAgent({ title: 'Digest', repo: REPO, schedule: 'daily at 9' }, noopBroadcast).error).toMatch(/five fields/i);
    expect(allJobs()).toHaveLength(0);
  });
});

describe('the wire shape', () => {
  it('gives every card a type, including one written before types existed', () => {
    addJob({ title: 'Legacy', repoPath: REPO }, noopBroadcast);
    delete allJobs()[0].type;
    addJob({ title: 'Digest', repoPath: REPO, schedule: '@hourly' }, noopBroadcast);
    const { jobs } = jobsPayload();
    expect(jobs.map(j => j.type)).toEqual(['one-time', 'scheduled']);
  });
});

describe('a run sharing its schedule\'s files', () => {
  it('does not delete the schedule\'s file when one is dropped from the run', async () => {
    const { job: schedule } = addJob({
      title: 'With a file', repoPath: REPO, schedule: '@hourly',
      attachments: [{ name: 'shot.png', data: Buffer.from('png').toString('base64') }],
    }, noopBroadcast);
    schedule.nextRunAt = past();
    const [run] = fireSchedules(noopBroadcast);
    const shared = schedule.attachments[0].path;
    updateJob(run.id, { attachments: [] }, noopBroadcast);
    const { existsSync } = await import('fs');
    expect(existsSync(shared)).toBe(true);
    expect(run.attachments).toEqual([]);
  });
});

describe('adversarial review regressions', () => {
  it('abandons a spawn whose card was turned into a schedule meanwhile', async () => {
    const { job } = addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    const killed = [];
    const create = async (...args) => {
      updateJob(job.id, { type: 'scheduled', schedule: '@daily' }, noopBroadcast);
      return fakeCreateSession([])(...args);
    };
    await dispatchOnce(create, noopBroadcast, { killSession: fakeKillSession(killed) });
    expect(job.state).toBe('todo');
    expect(killed).toHaveLength(1);
  });

  it('unlinks a run turned into a schedule, so it cannot hold its parent off', () => {
    const schedule = dueSchedule();
    const [run] = fireSchedules(noopBroadcast);
    updateJob(run.id, { type: 'scheduled', schedule: '@daily' }, noopBroadcast);
    expect(run.scheduleId).toBeUndefined();
    schedule.nextRunAt = past();
    expect(fireSchedules(noopBroadcast)).toHaveLength(1);
  });
});

describe('pruning finished runs', () => {
  it('deletes a schedule\'s finished runs past the cap, with their files, and keeps its count', async () => {
    const schedule = dueSchedule();
    for (let i = 0; i < 52; i++) {
      allJobs().push({ id: `run-${i}`, title: 't', repoPath: REPO, type: 'one-time', scheduleId: schedule.id, state: 'done', doneAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), attachments: [] });
    }
    schedule.runCount = 52;
    const pruned = await pruneFinishedRuns(noopBroadcast);
    expect(pruned.map(j => j.id)).toEqual(['run-1', 'run-0']);
    expect(runsOf(schedule)).toHaveLength(50);
    expect(schedule.runCount).toBe(52);
  });

  it('leaves a finished run whose agent is still alive for a later scan', () => {
    const schedule = dueSchedule();
    for (let i = 0; i < 51; i++) {
      allJobs().push({ id: `run-${i}`, title: 't', repoPath: REPO, type: 'one-time', scheduleId: schedule.id, state: 'done', doneAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), attachments: [] });
    }
    sessions.set('alive', { id: 'alive', exited: false });
    allJobs().find(j => j.id === 'run-0').agentSessionId = 'alive';
    expect(pruneFinishedRuns(noopBroadcast)).toEqual([]);
    expect(runsOf(schedule)).toHaveLength(51);
  });
});
