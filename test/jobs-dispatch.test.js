import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { dispatchOnce, addJob, moveJob, deleteJob, updateSettings, boardSettings, allJobs, jobsPayload, checkPullRequests } from '../server/jobs.js';
import { parseCommand } from '../lib/helpers.js';

// A real directory, because dispatchOnce filters to repos that exist on disk.
const REPO = mkdtempSync(join(tmpdir(), 'a007-jobrepo-'));
const REPO2 = mkdtempSync(join(tmpdir(), 'a007-jobrepo2-'));

// Swallow config writes: saveConfig targets the developer's real ~/.agent-007.
const noopBroadcast = () => {};

function resetBoard() {
  config.repos = [{ path: REPO }, { path: REPO2 }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
}

// Stand-in for server.js's createSession: records its arguments and hands back
// a session shaped like the real one, without spawning a PTY.
function fakeCreateSession(calls, { fail = false } = {}) {
  let n = 0;
  return async (command, name, repoPath, branch, ownerId, meta) => {
    calls.push({ command, repoPath, ownerId, meta });
    if (fail) return { error: 'Failed to create worktree: disk on fire' };
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

describe('dispatchOnce', () => {
  beforeEach(resetBoard);

  it('moves a todo job to in-progress and records who is working on it and since when', async () => {
    addJob({ title: 'Add caching', detail: 'LRU, 100 entries', repoPath: REPO, postedByName: 'Bill' }, noopBroadcast);
    const calls = [];
    const dispatched = await dispatchOnce(fakeCreateSession(calls), noopBroadcast);

    expect(dispatched).toHaveLength(1);
    const job = allJobs()[0];
    expect(job.state).toBe('in-progress');
    expect(job.agentSessionId).toBe('session-1');
    expect(job.agentName).toBe('Agent1');
    expect(job.branchName).toBe('bill/cocktail1');
    expect(Date.parse(job.startedAt)).not.toBeNaN();
  });

  it('sends the job as a single argv and tags the session as board-spawned', async () => {
    addJob({ title: 'Fix "the" bug', detail: 'Detail here', repoPath: REPO }, noopBroadcast);
    const calls = [];
    await dispatchOnce(fakeCreateSession(calls), noopBroadcast);

    expect(calls).toHaveLength(1);
    // The board must never steal the user's focus, so the client needs to know
    // this session came from the dispatcher.
    expect(calls[0].meta.spawnedBy).toBe('board');
    expect(calls[0].meta.jobId).toBe(allJobs()[0].id);

    const parsed = parseCommand(calls[0].command);
    expect(parsed.file).toBe('claude');
    expect(parsed.args).toHaveLength(3);
    expect(parsed.args[2]).toContain('Fix "the" bug');
    expect(parsed.args[2]).toContain('Detail here');
  });

  it('publishes the new session so it gets a terminal tab', async () => {
    // Without this the agent runs invisibly and the user cannot answer it.
    addJob({ title: 'J', repoPath: REPO }, noopBroadcast);
    const published = [];
    await dispatchOnce(fakeCreateSession([]), noopBroadcast, { onSessionCreated: (s) => published.push(s) });
    expect(published.map(s => s.id)).toEqual(['session-1']);
  });

  it('stops at the per-repo cap and leaves the rest queued', async () => {
    for (let i = 0; i < 5; i++) addJob({ title: `J${i}`, repoPath: REPO }, noopBroadcast);
    updateSettings({ maxPerRepo: 2 }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);

    const states = allJobs().map(j => j.state);
    expect(states.filter(s => s === 'in-progress')).toHaveLength(2);
    expect(states.filter(s => s === 'todo')).toHaveLength(3);
  });

  it('frees the slot again once a job reaches review', async () => {
    for (let i = 0; i < 3; i++) addJob({ title: `J${i}`, repoPath: REPO }, noopBroadcast);
    updateSettings({ maxPerRepo: 1 }, noopBroadcast);
    const create = fakeCreateSession([]);
    await dispatchOnce(create, noopBroadcast);
    expect(allJobs().filter(j => j.state === 'in-progress')).toHaveLength(1);

    // At the cap: nothing new goes out.
    await dispatchOnce(create, noopBroadcast);
    expect(allJobs()[1].state).toBe('todo');

    // In normal operation the agent is retired at the same moment the card
    // moves, which is what keeps in-progress count == live agent count. A
    // manual move is the user's own call.
    moveJob(allJobs()[0].id, 'review', noopBroadcast);
    await dispatchOnce(create, noopBroadcast);
    expect(allJobs()[1].state).toBe('in-progress');
  });

  it('does not let a dead agent block its repo forever', async () => {
    addJob({ title: 'first', repoPath: REPO }, noopBroadcast);
    addJob({ title: 'second', repoPath: REPO }, noopBroadcast);
    updateSettings({ maxPerRepo: 1 }, noopBroadcast);
    const create = fakeCreateSession([]);
    await dispatchOnce(create, noopBroadcast);

    // The agent dies (crash, or the user closed the tab). The card stays put —
    // we never auto-revert — but its slot has to come back.
    sessions.delete('session-1');
    await dispatchOnce(create, noopBroadcast);
    expect(allJobs()[1].state).toBe('in-progress');
  });

  it('caps each repo separately', async () => {
    addJob({ title: 'a', repoPath: REPO }, noopBroadcast);
    addJob({ title: 'b', repoPath: REPO2 }, noopBroadcast);
    updateSettings({ maxPerRepo: 1 }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    expect(allJobs().every(j => j.state === 'in-progress')).toBe(true);
  });

  it('leaves the job in todo and records the reason when the spawn fails', async () => {
    addJob({ title: 'doomed', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([], { fail: true }), noopBroadcast);
    const job = allJobs()[0];
    expect(job.state).toBe('todo');           // retried on the next tick
    expect(job.lastError).toMatch(/disk on fire/);
  });

  it('clears a stale error once the job starts', async () => {
    addJob({ title: 'flaky', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([], { fail: true }), noopBroadcast);
    expect(allJobs()[0].lastError).toBeTruthy();
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    expect(allJobs()[0].state).toBe('in-progress');
    expect(allJobs()[0].lastError).toBeNull();
  });

  it('skips jobs whose repo is no longer configured', async () => {
    addJob({ title: 'orphaned repo', repoPath: '/does/not/exist' }, noopBroadcast);
    const calls = [];
    await dispatchOnce(fakeCreateSession(calls), noopBroadcast);
    expect(calls).toHaveLength(0);
    expect(allJobs()[0].state).toBe('todo');
  });
});

describe('board mutations', () => {
  beforeEach(resetBoard);

  it('returning a job to todo unlinks the agent so it can be dispatched again', async () => {
    addJob({ title: 'redo', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const id = allJobs()[0].id;
    moveJob(id, 'todo', noopBroadcast);
    const job = allJobs()[0];
    expect(job.state).toBe('todo');
    expect(job.agentSessionId).toBeNull();
    expect(job.agentName).toBeNull();
    expect(job.startedAt).toBeNull();
  });

  it('rejects an unknown state', () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    expect(moveJob(allJobs()[0].id, 'done', noopBroadcast).error).toMatch(/Unknown state/);
  });

  it('reports a missing job rather than throwing', () => {
    expect(moveJob('nope', 'review', noopBroadcast).error).toMatch(/not found/i);
    expect(deleteJob('nope', noopBroadcast).error).toMatch(/not found/i);
  });

  it('clamps the cap and interval to sane bounds', () => {
    expect(updateSettings({ maxPerRepo: 999 }, noopBroadcast).settings.maxPerRepo).toBe(10);
    expect(updateSettings({ maxPerRepo: 0 }, noopBroadcast).settings.maxPerRepo).toBe(1);
    expect(updateSettings({ intervalMs: 5 }, noopBroadcast).settings.intervalMs).toBe(30_000);
  });

  it('starts with the dispatcher stopped', () => {
    expect(boardSettings().running).toBe(false);
  });

  it('derives live status onto the wire payload without persisting it', async () => {
    addJob({ title: 'live', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    sessions.get('session-1').state = 'MESSAGE';

    const payload = jobsPayload();
    expect(payload.jobs[0].status).toBe('needs-input');
    expect(payload.jobs[0].agentAlive).toBe(true);
    // The stored record stays clean — status is a view of a live PTY.
    expect(allJobs()[0].status).toBeUndefined();
  });
});

// --- Closing the agent once its PR is open ---

describe('checkPullRequests closing the agent', () => {
  beforeEach(resetBoard);

  // Stub the gh lookup: these tests are about what happens once a PR is found,
  // not about talking to GitHub.
  const withPr = (pr) => async () => pr;

  async function dispatched() {
    addJob({ title: 'shipped', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    return allJobs()[0];
  }

  it('moves the job to review and records the PR', async () => {
    const job = await dispatched();
    const findPr = withPr({ url: 'https://gh/o/r/pull/5', number: 5, isDraft: false });
    const killed = [];
    await checkPullRequests(noopBroadcast, { findPr, killSession: async (id) => killed.push(id) });

    expect(job.state).toBe('review');
    expect(job.prNumber).toBe(5);
    expect(job.prUrl).toBe('https://gh/o/r/pull/5');
    expect(Date.parse(job.reviewAt)).not.toBeNaN();
  });

  it('closes the agent by default', async () => {
    const job = await dispatched();
    const findPr = withPr({ url: 'u', number: 1 });
    const killed = [];
    await checkPullRequests(noopBroadcast, { findPr, killSession: async (id) => killed.push(id) });
    expect(killed).toEqual([job.agentSessionId]);
  });

  it('still moves the job to review if closing the agent throws', async () => {
    // The PR is open either way — a cleanup failure must not strand the card.
    await dispatched();
    const findPr = withPr({ url: 'u', number: 2 });
    await checkPullRequests(noopBroadcast, { findPr, killSession: async () => { throw new Error('worktree busy'); } });
    expect(allJobs()[0].state).toBe('review');
  });

  it('keeps the credit on the card after the agent is gone', async () => {
    // Requirement 3: who worked on it, and since when — a review card must
    // still answer that once its agent has been retired.
    const job = await dispatched();
    const agentName = job.agentName, branch = job.branchName, started = job.startedAt;
    const findPr = withPr({ url: 'u', number: 3 });
    await checkPullRequests(noopBroadcast, { findPr, killSession: async (id) => sessions.delete(id) });
    expect(job.agentName).toBe(agentName);
    expect(job.branchName).toBe(branch);
    expect(job.startedAt).toBe(started);
  });

  it('frees the slot for the next queued job', async () => {
    addJob({ title: 'first', repoPath: REPO }, noopBroadcast);
    addJob({ title: 'second', repoPath: REPO }, noopBroadcast);
    updateSettings({ maxPerRepo: 1 }, noopBroadcast);
    const create = fakeCreateSession([]);
    await dispatchOnce(create, noopBroadcast);
    expect(allJobs()[1].state).toBe('todo');    // capped out

    const findPr = withPr({ url: 'u', number: 4 });
    await checkPullRequests(noopBroadcast, { findPr, killSession: async (id) => sessions.delete(id) });

    await dispatchOnce(create, noopBroadcast);
    expect(allJobs()[0].state).toBe('review');
    expect(allJobs()[1].state).toBe('in-progress');
  });
});

// --- Nothing accumulates, because every agent is retired at its PR ---

describe('agents do not pile up across many jobs', () => {
  beforeEach(resetBoard);

  it('never runs more agents than the cap, and drains the whole queue', async () => {
    // The cap counts in-progress jobs, which is only equal to the number of
    // live agents because an agent is ALWAYS closed when its PR opens. This is
    // the test that keeps those two facts tied together: if agents ever stopped
    // being retired, they would accumulate here.
    updateSettings({ maxPerRepo: 2 }, noopBroadcast);
    for (let i = 0; i < 8; i++) addJob({ title: `J${i}`, repoPath: REPO }, noopBroadcast);

    const create = fakeCreateSession([]);
    const findPr = async () => ({ url: 'u', number: 1 });
    const kill = async (id) => { sessions.delete(id); };

    let peak = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      await dispatchOnce(create, noopBroadcast);
      peak = Math.max(peak, [...sessions.values()].filter(s => !s.exited).length);
      await checkPullRequests(noopBroadcast, { findPr, killSession: kill });
    }

    expect(peak).toBeLessThanOrEqual(2);
    expect([...sessions.values()].filter(s => !s.exited)).toHaveLength(0);
    expect(allJobs().filter(j => j.state === 'review')).toHaveLength(8);
  });
});
