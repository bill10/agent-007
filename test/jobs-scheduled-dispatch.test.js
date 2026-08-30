import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import {
  addJob, updateJob, moveJob, deleteJob, dispatchOnce, finishScheduledRuns, checkPullRequests, checkMergedPullRequests,
  runScan, allJobs, boardSettings, jobsPayload, postJobForAgent,
} from '../server/jobs.js';
import { STALLED_AFTER_MS } from '../lib/jobs.js';

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

describe('dispatching a scheduled job', () => {
  it('waits for the schedule instead of going out the moment it is posted', async () => {
    // "0 9 * * *" is at most a day away, so a freshly posted card is not due.
    addJob({ title: 'Daily digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const calls = [];
    expect(await dispatchOnce(fakeCreateSession(calls), noopBroadcast)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(allJobs()[0].state).toBe('todo');
  });

  it('sends the scheduled prompt, not the review/ship one, once it is due', async () => {
    addJob({ title: 'Daily digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    allJobs()[0].nextRunAt = past();
    const calls = [];
    const dispatched = await dispatchOnce(fakeCreateSession(calls), noopBroadcast);

    expect(dispatched).toHaveLength(1);
    expect(calls[0].command).not.toMatch(/\/ship/);
    expect(calls[0].command).toMatch(/scheduled run/i);
    const job = allJobs()[0];
    expect(job.state).toBe('in-progress');
    expect(job.agentSessionId).toBe('session-1');
    expect(job.runCount).toBe(1);
    expect(job.lastRunAt).toBe(job.startedAt);
  });
});

describe('the PR watcher and scheduled jobs', () => {
  it('leaves a scheduled run alone even when its branch has an open PR', async () => {
    // Moving it to Review would take the card out of rotation for good: the
    // column a scheduled job cycles through is To do, not Review.
    addJob({ title: 'Nightly sweep', repoPath: REPO, schedule: '0 3 * * *' }, noopBroadcast);
    Object.assign(allJobs()[0], { state: 'in-progress', branchName: 'bill/sweep', agentSessionId: 's1' });
    const findPr = async () => ({ pr: { url: 'https://x/pull/7', number: 7 } });

    expect(await checkPullRequests(noopBroadcast, { findPr })).toEqual([]);
    expect(allJobs()[0].state).toBe('in-progress');
  });

  it('leaves a scheduled run alone even when its branch has a merged PR', async () => {
    // Done is terminal. Filing the card away would end the standing job the
    // first time one of its runs happened to ship something.
    addJob({ title: 'Nightly sweep', repoPath: REPO, schedule: '0 3 * * *' }, noopBroadcast);
    Object.assign(allJobs()[0], { state: 'in-progress', branchName: 'bill/sweep', agentSessionId: 's1', startedAt: past() });
    const findMerged = async () => ({ pr: { url: 'https://x/pull/7', number: 7, mergedAt: new Date().toISOString() } });

    expect(await checkMergedPullRequests(noopBroadcast, { findMerged })).toEqual([]);
    expect(allJobs()[0].state).toBe('in-progress');
    expect(allJobs()[0].prMergedAt).toBeNull();
  });
});

describe('finishScheduledRuns', () => {
  function runningJob(sessionOver = {}) {
    addJob({ title: 'Daily digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const job = allJobs()[0];
    const session = {
      id: 's1', name: 'Viper', branchName: 'bill/x', worktreePath: '/wt/1',
      repoPath: REPO, state: 'WORKING', exited: false, lastOutputAt: Date.now(), ...sessionOver,
    };
    sessions.set(session.id, session);
    Object.assign(job, {
      state: 'in-progress', agentSessionId: session.id, agentName: session.name,
      branchName: session.branchName, worktreePath: session.worktreePath,
      startedAt: past(), runCount: 1, lastRunAt: past(),
    });
    return job;
  }

  it('keeps the agent and re-arms the card once the run goes quiet', async () => {
    const job = runningJob({ state: 'WAITING', lastOutputAt: Date.now() - STALLED_AFTER_MS - 1000 });
    const finished = await finishScheduledRuns(noopBroadcast);

    expect(finished).toHaveLength(1);
    expect(job.state).toBe('todo');
    expect(job.agentSessionId).toBeNull();
    expect(job.branchName).toBeNull();
    // The agent is NOT closed: its terminal is the run's only output, and the
    // card keeps a pointer to it until the next run retires it.
    expect(sessions.has('s1')).toBe(true);
    expect(job.lastRunSessionId).toBe('s1');
    expect(job.lastRunAgentName).toBe('Viper');
    // Re-armed rather than blanked: the schedule and the run record survive.
    expect(job.schedule).toBe('0 9 * * *');
    expect(job.runCount).toBe(1);
    expect(Date.parse(job.nextRunAt)).toBeGreaterThan(Date.now());
  });

  it('retires the kept agent when the next run dispatches', async () => {
    const job = runningJob({ state: 'WAITING', lastOutputAt: Date.now() - STALLED_AFTER_MS - 1000 });
    await finishScheduledRuns(noopBroadcast);
    expect(job.lastRunSessionId).toBe('s1');

    job.nextRunAt = past();   // due again, with the old tab still open
    const calls = [];
    const killed = [];
    await dispatchOnce(fakeCreateSession(calls), noopBroadcast, { killSession: fakeKillSession(killed) });

    expect(killed).toEqual(['s1']);
    expect(job.lastRunSessionId).toBeNull();
    expect(job.state).toBe('in-progress');
    expect(job.agentSessionId).toBe('session-1');
  });

  it('retires the kept agent when the card is deleted', async () => {
    const job = runningJob({ state: 'WAITING', lastOutputAt: Date.now() - STALLED_AFTER_MS - 1000 });
    await finishScheduledRuns(noopBroadcast);
    const killed = [];
    await deleteJob(job.id, noopBroadcast, { killSession: fakeKillSession(killed) });
    expect(killed).toEqual(['s1']);
    expect(allJobs()).toHaveLength(0);
  });

  it('leaves a run that is still working exactly where it is', async () => {
    const job = runningJob();
    expect(await finishScheduledRuns(noopBroadcast)).toEqual([]);
    expect(job.state).toBe('in-progress');
  });

  it('leaves a run that is asking the user a question alone', async () => {
    const job = runningJob({ state: 'MESSAGE', lastOutputAt: Date.now() - STALLED_AFTER_MS - 60_000 });
    await finishScheduledRuns(noopBroadcast);
    expect(job.state).toBe('in-progress');
  });

  it('recovers a run whose agent died with the server', async () => {
    const job = runningJob();
    sessions.clear();          // what a restart leaves behind
    await finishScheduledRuns(noopBroadcast);
    expect(job.state).toBe('todo');
    expect(Date.parse(job.nextRunAt)).toBeGreaterThan(Date.now());
  });

  it('re-arms a finished run before the same scan dispatches, in one tick', async () => {
    // Ordering, not the cap (scheduled cards sit outside it): the run that
    // ended since the last tick is back in To do before dispatch looks.
    boardSettings().maxPerRepo = 1;
    const done = runningJob({ state: 'WAITING', lastOutputAt: 0 });
    addJob({ title: 'Queued work', repoPath: REPO }, noopBroadcast);
    const calls = [];
    const killed = [];

    await runScan(fakeCreateSession(calls), noopBroadcast, { killSession: fakeKillSession(killed) });

    expect(done.state).toBe('todo');
    expect(calls).toHaveLength(1);
    expect(allJobs().find(j => j.title === 'Queued work').state).toBe('in-progress');
  });
});

describe('editing and moving a scheduled card', () => {
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

  it('re-arms from the NEW schedule when a card was edited while its run was in flight', async () => {
    addJob({ title: 'Digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const job = allJobs()[0];
    sessions.set('s1', { id: 's1', state: 'WAITING', exited: false, lastOutputAt: 0 });
    Object.assign(job, { state: 'in-progress', agentSessionId: 's1', branchName: 'bill/x' });

    updateJob(job.id, { schedule: '*/5 * * * *' }, noopBroadcast);
    // No due time while the run is in flight — the run-end reset owns it.
    expect(job.nextRunAt).toBeNull();

    await finishScheduledRuns(noopBroadcast);
    expect(job.state).toBe('todo');
    // Re-armed from the NEW cron: every five minutes is minutes away, not 9am.
    expect(Date.parse(job.nextRunAt)).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it('re-arms rather than immediately re-fires when the user ends a run by hand', async () => {
    addJob({ title: 'Digest', repoPath: REPO, schedule: '0 9 * * *' }, noopBroadcast);
    const job = allJobs()[0];
    Object.assign(job, { state: 'in-progress', branchName: 'bill/x', nextRunAt: past() });

    await moveJob(job.id, 'todo', noopBroadcast, {});

    expect(job.state).toBe('todo');
    expect(Date.parse(job.nextRunAt)).toBeGreaterThan(Date.now());
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
