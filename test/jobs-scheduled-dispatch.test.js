import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import {
  addJob, updateJob, moveJob, dispatchOnce, fireSchedules, supersedeRuns, finishJobForAgent, pruneFinishedRuns,
  runScan, allJobs, boardSettings, jobsPayload, postJobForAgent, setJobPaused, checkMergedPullRequests,
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

// The closed-PR path acts on the second of two readings a scan apart, once
// the card's agent is idle, and only when nothing is open on the branch. This
// runs the sweep that way.
async function closedSweep(broadcast, opts) {
  for (const s of sessions.values()) if (!s.exited) s.state = 'WAITING';
  for (let i = 0; i < 2; i++) {
    await checkMergedPullRequests(broadcast, { findPr: async () => ({ pr: null }), ...opts });
    ageClosedReadings();
  }
}

// Stands in for the minute a closed reading must hold before it counts.
function ageClosedReadings() {
  for (const j of allJobs()) if (j.prClosedSeenAt) j.prClosedSeenAt = new Date(Date.now() - 120_000).toISOString();
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

describe('a card whose PR was closed without merging', () => {
  async function prRunInReview() {
    const schedule = dueSchedule({ requiresPr: true });
    const [run] = fireSchedules(noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const pr = { url: 'https://github.com/o/r/pull/7', number: 7 };
    await finishJobForAgent({ session: sessions.get(run.agentSessionId), prUrl: pr.url }, noopBroadcast, { findPr: async () => ({ pr }) });
    return { schedule, run };
  }
  const notMerged = async () => ({ pr: null });

  it('files the run to Done, closes its agent, and lets the schedule fire again', async () => {
    const { schedule, run } = await prRunInReview();
    const agent = run.agentSessionId;
    const killed = [];
    await closedSweep(noopBroadcast, {
      findMerged: notMerged,
      findClosed: async (repo, branch, { prNumber }) => ({ pr: prNumber === 7 ? { url: 'u', number: 7 } : null }),
      killSession: fakeKillSession(killed),
    });
    expect(run.state).toBe('done');
    expect(run.prClosedAt).toBeTruthy();
    expect(run.prMergedAt).toBeFalsy();
    expect(killed).toEqual([agent]);
    schedule.nextRunAt = past();
    expect(fireSchedules(noopBroadcast)).toHaveLength(1);
  });

  it('leaves the run waiting while its PR is still open', async () => {
    const { schedule, run } = await prRunInReview();
    await closedSweep(noopBroadcast, { findMerged: notMerged, findClosed: async () => ({ pr: null }), killSession: fakeKillSession([]) });
    expect(run.state).toBe('review');
    schedule.nextRunAt = past();
    expect(fireSchedules(noopBroadcast)).toEqual([]);
  });

  it('files a one-time card to Done the same way, closing its agent', async () => {
    const { job } = addJob({ title: 'plain', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const agent = job.agentSessionId;
    const pr = { url: 'https://github.com/o/r/pull/9', number: 9 };
    await finishJobForAgent({ session: sessions.get(agent), prUrl: pr.url }, noopBroadcast, { findPr: async () => ({ pr }) });
    const killed = [];
    await closedSweep(noopBroadcast, { findMerged: notMerged, findClosed: async () => ({ pr }), killSession: fakeKillSession(killed) });
    expect(job.state).toBe('done');
    expect(job.prClosedAt).toBeTruthy();
    expect(killed).toEqual([agent]);
  });

  it('asks nothing about a card still In progress, which has no PR of record yet', async () => {
    const { job } = addJob({ title: 'going', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    let asked = false;
    await closedSweep(noopBroadcast, { findMerged: notMerged, findClosed: async () => { asked = true; return { pr: null }; } });
    expect(asked).toBe(false);
    expect(job.state).toBe('in-progress');
  });
});

describe('a closed PR, at the edges', () => {
  async function prCardInReview(over = {}) {
    const { job } = addJob({ title: 'plain', repoPath: REPO, ...over }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const pr = { url: 'https://github.com/o/r/pull/9', number: 9 };
    await finishJobForAgent({ session: sessions.get(job.agentSessionId), prUrl: pr.url }, noopBroadcast, { findPr: async () => ({ pr }) });
    return { job, pr };
  }
  const notMerged = async () => ({ pr: null });

  it('leaves the card alone when it moves while the closed check is out', async () => {
    const { job, pr } = await prCardInReview();
    const killed = [];
    await closedSweep(noopBroadcast, {
      findMerged: notMerged,
      findClosed: async () => { job.state = 'in-progress'; return { pr }; },
      killSession: fakeKillSession(killed),
    });
    expect(job.state).toBe('in-progress');
    expect(job.prClosedAt).toBeFalsy();
    expect(killed).toEqual([]);
  });

  it('leaves the card alone when its PR of record changes while the closed check is out', async () => {
    const { job, pr } = await prCardInReview();
    await closedSweep(noopBroadcast, {
      findMerged: notMerged,
      findClosed: async () => { job.prNumber = 10; return { pr }; },
      killSession: fakeKillSession([]),
    });
    expect(job.state).toBe('review');
    expect(job.prClosedAt).toBeFalsy();
  });

  it('keeps the card in Review when the closed check itself fails', async () => {
    const { job } = await prCardInReview();
    await closedSweep(noopBroadcast, {
      findMerged: notMerged,
      findClosed: async () => ({ pr: null, error: 'Could not resolve to a Repository' }),
      killSession: fakeKillSession([]),
    });
    expect(job.state).toBe('review');
    expect(job.prCheckError).toMatch(/closed — Could not resolve/);
  });

  it('does not ask about a closed PR when the merge check failed, or when the card has no PR number', async () => {
    const { job } = await prCardInReview();
    let asked = 0;
    const findClosed = async () => { asked++; return { pr: null }; };
    await closedSweep(noopBroadcast, { findMerged: async () => ({ pr: null, error: 'nope' }), findClosed });
    job.prNumber = null;
    await closedSweep(noopBroadcast, { findMerged: notMerged, findClosed });
    expect(asked).toBe(0);
    expect(job.state).toBe('review');
  });

  it('says the PR was closed, and only says the schedule can run again for a run', async () => {
    const { pr } = await prCardInReview();
    const notes = [];
    await closedSweep(m => notes.push(m), { findMerged: notMerged, findClosed: async () => ({ pr }), killSession: fakeKillSession([]) });
    const note = notes.find(m => m.type === 'notification');
    expect(note.message).toMatch(/PR #9 was closed without merging/);
    expect(note.message).not.toMatch(/schedule/);

    resetBoard();
    dueSchedule({ requiresPr: true });
    const [run] = fireSchedules(noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await finishJobForAgent({ session: sessions.get(run.agentSessionId), prUrl: pr.url }, noopBroadcast, { findPr: async () => ({ pr }) });
    const runNotes = [];
    await closedSweep(m => runNotes.push(m), { findMerged: notMerged, findClosed: async () => ({ pr }), killSession: fakeKillSession([]) });
    expect(runNotes.find(m => m.type === 'notification').message).toMatch(/Its schedule can run again/);
  });

  it('closes only the linked agent, never a hand-opened session on the same branch', async () => {
    const { job, pr } = await prCardInReview();
    sessions.delete(job.agentSessionId);   // the linked agent is gone, so only the branch could match
    const byHand = { id: 'by-hand', name: 'Hand', repoPath: REPO, branchName: job.branchName, exited: false };
    sessions.set(byHand.id, byHand);
    const killed = [];
    await closedSweep(noopBroadcast, { findMerged: notMerged, findClosed: async () => ({ pr }), killSession: fakeKillSession(killed) });
    expect(job.state).toBe('done');
    expect(killed).toEqual([]);
    expect(sessions.has('by-hand')).toBe(true);
  });

  it('is swept by a scan, which forwards findClosed', async () => {
    const { job, pr } = await prCardInReview();
    sessions.get(job.agentSessionId).state = 'WAITING';
    for (let i = 0; i < 2; i++) {
      await runScan(fakeCreateSession([]), noopBroadcast, {
        killSession: fakeKillSession([]), findPr: async () => ({}), findMerged: notMerged, findClosed: async () => ({ pr }),
      });
      ageClosedReadings();
    }
    expect(job.state).toBe('done');
    expect(job.prClosedAt).toBeTruthy();
  });
});

describe('a closed PR and the card\'s files', () => {
  it('clears the attachments of a card filed away for a closed PR', async () => {
    const { job } = addJob({ title: 'with a file', repoPath: REPO, attachments: [{ name: 'a.png', data: Buffer.from('x').toString('base64') }] }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const pr = { url: 'https://github.com/o/r/pull/3', number: 3 };
    await finishJobForAgent({ session: sessions.get(job.agentSessionId), prUrl: pr.url }, noopBroadcast, { findPr: async () => ({ pr }) });
    const file = job.attachments[0].path;
    await closedSweep(noopBroadcast, { findMerged: async () => ({ pr: null }), findClosed: async () => ({ pr }), killSession: fakeKillSession([]) });
    const { existsSync } = await import('fs');
    expect(job.state).toBe('done');
    expect(job.attachments).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});

describe('the closed-PR guards', () => {
  async function prCardInReview() {
    const { job } = addJob({ title: 'guarded', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const pr = { url: 'https://github.com/o/r/pull/41', number: 41 };
    await finishJobForAgent({ session: sessions.get(job.agentSessionId), prUrl: pr.url }, noopBroadcast, { findPr: async () => ({ pr }) });
    sessions.get(job.agentSessionId).state = 'WAITING';
    return { job, pr };
  }
  const opts = (over = {}) => ({ findMerged: async () => ({ pr: null }), findClosed: async () => ({ pr: { url: 'u', number: 41 } }), findPr: async () => ({ pr: null }), killSession: fakeKillSession([]), ...over });

  it('waits for a second closed reading a minute later before filing the card', async () => {
    const { job } = await prCardInReview();
    await checkMergedPullRequests(noopBroadcast, opts());
    expect(job.state).toBe('review');
    expect(job.prClosedSeenAt).toBeTruthy();
    await checkMergedPullRequests(noopBroadcast, opts());
    expect(job.state).toBe('review');   // seconds later, e.g. Run now: not yet
    ageClosedReadings();
    await checkMergedPullRequests(noopBroadcast, opts());
    expect(job.state).toBe('done');
  });

  it('treats the same PR open again as not closed, and a failed open-PR lookup as undecided', async () => {
    const { job, pr } = await prCardInReview();
    await checkMergedPullRequests(noopBroadcast, opts());
    ageClosedReadings();
    await checkMergedPullRequests(noopBroadcast, opts({ findPr: async () => ({ pr }) }));   // reopened in between
    expect(job.state).toBe('review');
    expect(job.prClosedSeenAt).toBeNull();
    await checkMergedPullRequests(noopBroadcast, opts());
    ageClosedReadings();
    await checkMergedPullRequests(noopBroadcast, opts({ findPr: async () => ({ pr: null, error: 'rate limited' }) }));
    expect(job.state).toBe('review');
    expect(job.prCheckError).toMatch(/replacement pull request — rate limited/);
  });

  it('forgets a closed reading once the PR is reopened', async () => {
    const { job } = await prCardInReview();
    await checkMergedPullRequests(noopBroadcast, opts());
    await checkMergedPullRequests(noopBroadcast, opts({ findClosed: async () => ({ pr: null }) }));
    expect(job.prClosedSeenAt).toBeNull();
    await checkMergedPullRequests(noopBroadcast, opts());
    expect(job.state).toBe('review');
  });

  it('adopts the replacement PR opened on the same branch instead of filing the card', async () => {
    const { job } = await prCardInReview();
    const killed = [];
    const next = { url: 'https://github.com/o/r/pull/42', number: 42 };
    for (let i = 0; i < 2; i++) {
      await checkMergedPullRequests(noopBroadcast, opts({ findPr: async () => ({ pr: next }), killSession: fakeKillSession(killed) }));
    }
    expect(job.state).toBe('review');
    expect(job.prNumber).toBe(42);
    expect(killed).toEqual([]);
  });

  it('waits while the agent is busy, and files the card once it is quiet', async () => {
    const { job } = await prCardInReview();
    sessions.get(job.agentSessionId).state = 'MESSAGE';
    await checkMergedPullRequests(noopBroadcast, opts());
    ageClosedReadings();
    await checkMergedPullRequests(noopBroadcast, opts());
    expect(job.state).toBe('review');
    sessions.get(job.agentSessionId).state = 'WAITING';
    await checkMergedPullRequests(noopBroadcast, opts());
    expect(job.state).toBe('done');
  });

  it('lets finish_job in Review adopt a replacement PR on the card\'s branch', async () => {
    const { job } = await prCardInReview();
    const next = { url: 'https://github.com/o/r/pull/42', number: 42 };
    await finishJobForAgent({ session: sessions.get(job.agentSessionId), prUrl: next.url }, noopBroadcast, { findPr: async () => ({ pr: next }) });
    expect(job.prNumber).toBe(42);
    await finishJobForAgent({ session: sessions.get(job.agentSessionId), prUrl: 'https://github.com/o/r/pull/99' }, noopBroadcast, { findPr: async () => ({ pr: next }) });
    expect(job.prNumber).toBe(42);   // not the branch's open PR, so ignored
  });
});

describe('a closed reading and leaving Review', () => {
  it('is forgotten when the card leaves Review, so a later closed PR needs two fresh readings', async () => {
    const { job } = addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const pr = { url: 'https://github.com/o/r/pull/5', number: 5 };
    await finishJobForAgent({ session: sessions.get(job.agentSessionId), prUrl: pr.url }, noopBroadcast, { findPr: async () => ({ pr }) });
    job.prClosedSeenAt = new Date(Date.now() - 120_000).toISOString();
    await moveJob(job.id, 'in-progress', noopBroadcast);
    expect(job.prClosedSeenAt).toBeNull();
  });
});
