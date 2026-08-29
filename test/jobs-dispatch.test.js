import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { dispatchOnce, addJob, moveJob, deleteJob, updateSettings, boardSettings, allJobs, jobsPayload, checkPullRequests, checkMergedPullRequests, runScan, relinkSessionToJob } from '../server/jobs.js';
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
    calls.push({ command, repoPath, branch, ownerId, meta });
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
    await moveJob(allJobs()[0].id, 'review', noopBroadcast);
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
    await moveJob(id, 'todo', noopBroadcast);
    const job = allJobs()[0];
    expect(job.state).toBe('todo');
    expect(job.agentSessionId).toBeNull();
    expect(job.agentName).toBeNull();
    expect(job.startedAt).toBeNull();
  });

  it('rejects an unknown state', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    expect((await moveJob(allJobs()[0].id, 'archived', noopBroadcast)).error).toMatch(/Unknown state/);
  });

  it('reports a missing job rather than throwing', async () => {
    expect((await moveJob('nope', 'review', noopBroadcast)).error).toMatch(/not found/i);
    expect((await deleteJob('nope', noopBroadcast)).error).toMatch(/not found/i);
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
  const withPr = (pr) => async () => ({ pr });

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
    const sid = job.agentSessionId;   // captured before: the link is cleared on a successful kill
    const findPr = withPr({ url: 'u', number: 1 });
    const killed = [];
    await checkPullRequests(noopBroadcast, { findPr, killSession: async (id) => killed.push(id) });
    expect(killed).toEqual([sid]);
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

// --- Review -> Done, once the PR merges ---

describe('checkMergedPullRequests', () => {
  beforeEach(resetBoard);

  const merged = (pr) => async () => ({ pr });

  // A job sitting in Review with a branch and an open PR, agent already gone —
  // exactly the state the automatic path leaves behind.
  async function inReview() {
    addJob({ title: 'landed', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'https://gh/o/r/pull/5', number: 5 } }),
      killSession: async (id) => sessions.delete(id),
    });
    return allJobs()[0];
  }

  it('takes a merged job off the board and records when it merged', async () => {
    const job = await inReview();
    const finished = await checkMergedPullRequests(noopBroadcast, {
      findMerged: merged({ url: 'https://gh/o/r/pull/5', number: 5, mergedAt: '2026-08-28T10:00:00Z' }),
    });
    expect(finished).toHaveLength(1);
    expect(job.state).toBe('done');
    expect(job.prMergedAt).toBe('2026-08-28T10:00:00Z');
    expect(Date.parse(job.doneAt)).not.toBeNaN();
    // The record survives: the card is the only place the PR link lives.
    expect(job.prUrl).toBe('https://gh/o/r/pull/5');
    expect(job.prNumber).toBe(5);
  });

  it('leaves a job in review while its PR is still open', async () => {
    const job = await inReview();
    await checkMergedPullRequests(noopBroadcast, { findMerged: merged(null) });
    expect(job.state).toBe('review');
    expect(job.prMergedAt).toBeNull();
  });

  it('never asks about a job that has not been dispatched', async () => {
    addJob({ title: 'queued', repoPath: REPO }, noopBroadcast);
    const asked = [];
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async (_r, b) => { asked.push(b); return { pr: null }; },
    });
    expect(asked).toHaveLength(0);
    expect(allJobs()[0].state).toBe('todo');
  });

  it('finishes an in-progress job whose PR opened and merged between two scans', async () => {
    // `gh pr list --state open` cannot see a merged PR, so checkPullRequests
    // finds nothing and leaves the card in progress. A Review-only sweep would
    // never look at it again: the card would sit there reading "agent gone"
    // forever for work that had actually shipped.
    addJob({ title: 'shipped and landed', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;
    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr: null }) });
    expect(job.state).toBe('in-progress');

    const killed = [];
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: merged({ url: 'https://gh/o/r/pull/4', number: 4, mergedAt: new Date().toISOString() }),
      killSession: async (id) => killed.push(id),
    });
    expect(job.state).toBe('done');
    expect(job.prNumber).toBe(4);
    // Leaving in-progress is what the cap counts, so this agent has to go.
    expect(killed).toEqual([sid]);
    expect(Date.parse(job.reviewAt)).not.toBeNaN();
  });

  it('asks about this card\'s PR by number once it has one', async () => {
    const job = await inReview();
    let asked = null;
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async (_r, _b, opts) => { asked = opts; return { pr: null }; },
    });
    expect(asked.prNumber).toBe(5);
    expect(asked.mergedAfter).toBe(job.reviewAt);
  });

  it('falls back to "merged after this attempt started" when there is no PR of record', async () => {
    // A card moved to Review by hand has no prNumber, so the only thing that
    // separates its merge from a previous job's on the same branch name is when
    // the merge happened.
    addJob({ title: 'by hand', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'review', noopBroadcast);
    let asked = null;
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async (_r, _b, opts) => { asked = opts; return { pr: null }; },
    });
    expect(asked.prNumber).toBeNull();
    expect(asked.mergedAfter).toBe(job.reviewAt);
  });

  it('leaves a finished job finished — the sweep never sees it again', async () => {
    // Done is terminal, so a swept card cannot come back and be re-swept. The
    // state filter is what enforces it; prMergedAt is a second belt.
    const job = await inReview();
    const findMerged = merged({ url: 'u', number: 5, mergedAt: '2026-08-28T10:00:00Z' });
    await checkMergedPullRequests(noopBroadcast, { findMerged });
    expect(job.state).toBe('done');
    const doneAt = job.doneAt;

    const finished = await checkMergedPullRequests(noopBroadcast, { findMerged });
    expect(finished).toEqual([]);
    expect(job.state).toBe('done');
    expect(job.doneAt).toBe(doneAt);
  });

  it('leaves the agent alone — a re-adopted agent may be working the review', async () => {
    // This runs every scan, unlike the one-shot retirement at the PR. Killing
    // here would make Review permanently hostile to working on your own PR.
    const job = await inReview();
    job.agentSessionId = 'session-99';
    sessions.set('session-99', { id: 'session-99', exited: false, branchName: job.branchName, repoPath: REPO });
    await checkMergedPullRequests(noopBroadcast, { findMerged: merged({ url: 'u', number: 5 }) });
    expect(job.state).toBe('done');
    expect(sessions.get('session-99').exited).toBe(false);
  });

  it('says so on the card when it cannot check, and clears the note once it can', async () => {
    const job = await inReview();
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async () => ({ pr: null, error: 'Could not resolve to a Repository' }),
    });
    expect(job.state).toBe('review');
    expect(job.prCheckError).toMatch(/Could not resolve to a Repository/);

    await checkMergedPullRequests(noopBroadcast, { findMerged: merged(null) });
    expect(job.prCheckError).toBeNull();
  });

  it('does not apply a merge to a job that moved while the lookup was in flight', async () => {
    const job = await inReview();
    const findMerged = async () => {
      await moveJob(job.id, 'in-progress', noopBroadcast);
      return { pr: { url: 'u', number: 5, mergedAt: '2026-08-28T10:00:00Z' } };
    };
    await checkMergedPullRequests(noopBroadcast, { findMerged });
    expect(job.state).toBe('in-progress');
    expect(job.prMergedAt).toBeNull();
  });

  it('does not re-stamp the note while the same failure repeats', async () => {
    // A permanent failure recurs every scan; it must not churn config.json.
    const job = await inReview();
    const failing = async () => ({ pr: null, error: 'gh: not authenticated' });
    await checkMergedPullRequests(noopBroadcast, { findMerged: failing });
    const firstStamp = job.prCheckErrorAt;
    await checkMergedPullRequests(noopBroadcast, { findMerged: failing });
    expect(job.prCheckErrorAt).toBe(firstStamp);
  });

  it('stamps prMergedAt even when the merged PR reports no mergedAt', async () => {
    // parseMergedPr accepts a PR carrying only state:MERGED, so this shape is
    // reachable, and the archive reads prMergedAt to say when the work landed.
    // A null there would leave a merged card claiming only "finished".
    const job = await inReview();
    await checkMergedPullRequests(noopBroadcast, { findMerged: merged({ url: 'u', number: 5, mergedAt: null }) });
    expect(Date.parse(job.prMergedAt)).not.toBeNaN();
  });

  it('never asks about a review job that has no branch', async () => {
    // A job moved to Review by hand from To do has no branch to query.
    addJob({ title: 'branchless', repoPath: REPO }, noopBroadcast);
    const job = allJobs()[0];
    job.state = 'review';
    const asked = [];
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async (_r, b) => { asked.push(b); return { pr: null }; },
    });
    expect(asked).toHaveLength(0);
    expect(job.state).toBe('review');
  });

  it('does not resurrect a job deleted while the lookup was in flight', async () => {
    const job = await inReview();
    const findMerged = async () => {
      await deleteJob(job.id, noopBroadcast);
      return { pr: { url: 'u', number: 5, mergedAt: '2026-08-28T10:00:00Z' } };
    };
    const finished = await checkMergedPullRequests(noopBroadcast, { findMerged });
    expect(allJobs()).toHaveLength(0);
    expect(finished).toHaveLength(0);
  });

  it('does not apply a merge found for a branch the job no longer has', async () => {
    const job = await inReview();
    const findMerged = async () => {
      job.branchName = 'bill/something-else';
      return { pr: { url: 'u', number: 5, mergedAt: '2026-08-28T10:00:00Z' } };
    };
    await checkMergedPullRequests(noopBroadcast, { findMerged });
    expect(job.state).toBe('review');
    expect(job.prMergedAt).toBeNull();
  });

  it('finishes a job that opens and merges within one scan', async () => {
    // This is why the sweeps run in this order: PRs found, then merges swept.
    // Reversed, such a job would sit in Review for a whole extra interval.
    addJob({ title: 'fast', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await runScan(fakeCreateSession([]), noopBroadcast, {
      findPr: async () => ({ pr: { url: 'https://gh/o/r/pull/9', number: 9 } }),
      findMerged: merged({ url: 'https://gh/o/r/pull/9', number: 9, mergedAt: '2026-08-28T10:00:00Z' }),
      killSession: async (id) => sessions.delete(id),
    });
    expect(job.state).toBe('done');
    expect(job.prNumber).toBe(9);
  });

  it('runs as part of a scan, so a merged PR finishes its job unattended', async () => {
    const job = await inReview();
    await runScan(fakeCreateSession([]), noopBroadcast, {
      findPr: async () => ({ pr: null }),
      findMerged: merged({ url: 'u', number: 5, mergedAt: '2026-08-28T10:00:00Z' }),
    });
    expect(job.state).toBe('done');
  });
});

// --- Finishing a job by hand ---

describe('moving a job to done', () => {
  beforeEach(resetBoard);

  it('stamps doneAt and retires any agent still attached', async () => {
    addJob({ title: 'finish me', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;
    const killed = [];
    await moveJob(job.id, 'done', noopBroadcast, { killSession: async (id) => killed.push(id) });
    expect(job.state).toBe('done');
    expect(Date.parse(job.doneAt)).not.toBeNaN();
    expect(killed).toEqual([sid]);
  });

  it('refuses every move out of done, and touches nothing when it does', async () => {
    // Done is terminal. Letting a card back onto the board carried its spent PR
    // of record into the new attempt, so the sweep re-matched that same old
    // merge on the next scan and filed the card away again — killing any agent
    // re-adopted on the branch, because finishing from in-progress retires one.
    addJob({ title: 'still working', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'u', number: 1 } }),
      killSession: async (id) => sessions.delete(id),
    });
    // A fresh agent is re-adopted onto the shipped branch.
    job.agentSessionId = 'session-readopted';
    sessions.set('session-readopted', { id: 'session-readopted', exited: false, branchName: job.branchName, repoPath: REPO });
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async () => ({ pr: { url: 'u', number: 1, mergedAt: '2026-08-28T10:00:00Z' } }),
    });
    expect(job.state).toBe('done');
    const doneAt = job.doneAt;

    const killed = [];
    for (const state of ['review', 'in-progress', 'todo']) {
      const res = await moveJob(job.id, state, noopBroadcast, { killSession: async (id) => killed.push(id) });
      expect(res.error).toMatch(/finished/);
      expect(job.state).toBe('done');
    }
    // A refused move is a no-op: no agent closed, no stamp disturbed.
    expect(killed).toEqual([]);
    expect(job.doneAt).toBe(doneAt);
    expect(job.prNumber).toBe(1);
    expect(sessions.get('session-readopted').exited).toBe(false);
  });

  it('still retires the agent when an in-progress job is requeued', async () => {
    // Requeueing means start over, so the agent and its worktree do go.
    addJob({ title: 'start over', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;
    const killed = [];
    await moveJob(job.id, 'todo', noopBroadcast, { killSession: async (id) => killed.push(id) });
    expect(killed).toEqual([sid]);
  });

  it('leaves prMergedAt null, so the card says "finished" and not "merged"', async () => {
    // Finishing by hand is not a claim about GitHub, and the archive reads the
    // difference off this field.
    addJob({ title: 'by hand', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'done', noopBroadcast);
    expect(job.prMergedAt).toBeNull();
    expect(Date.parse(job.doneAt)).not.toBeNaN();
  });

  it('clears the "cannot check" note when the user moves the card by hand', async () => {
    // The note ends with "move it by hand" — following it must not leave the
    // card in the archive still carrying the instruction.
    addJob({ title: 'unreachable', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: null, error: 'Could not resolve to a Repository' }),
    });
    expect(job.prCheckError).toBeTruthy();
    await moveJob(job.id, 'done', noopBroadcast);
    expect(job.prCheckError).toBeNull();
    expect(job.prCheckErrorAt).toBeNull();
  });

  it('cannot be requeued — follow-up work is a new job', async () => {
    // The archive is the record of what shipped. Reusing the card would mean
    // either carrying a spent PR into a new attempt or erasing that record.
    addJob({ title: 'redo', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'done', noopBroadcast);
    const doneAt = job.doneAt;
    const { error } = await moveJob(job.id, 'todo', noopBroadcast);
    expect(error).toMatch(/finished/);
    expect(job.state).toBe('done');
    expect(job.doneAt).toBe(doneAt);
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
    const findPr = async () => ({ pr: { url: 'u', number: 1 } });
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

// --- Branch naming through a real dispatch ---

describe('branch naming on dispatch', () => {
  beforeEach(resetBoard);

  it('asks for a branch derived from the job title, with collision fallback', async () => {
    addJob({ title: 'Add rate limiting!', repoPath: REPO }, noopBroadcast);
    const calls = [];
    await dispatchOnce(fakeCreateSession(calls), noopBroadcast);
    // createSession(command, name, repoPath, customBranch, ownerId, meta)
    expect(calls[0].branch).toBe('add-rate-limiting');
    // Two jobs may share a title, so a taken branch must take a suffix rather
    // than failing the dispatch outright.
    expect(calls[0].meta.branchSuffixOnCollision).toBe(true);
  });

  it('runs the agent in auto mode', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    const calls = [];
    await dispatchOnce(fakeCreateSession(calls), noopBroadcast);
    expect(calls[0].command).toContain('--permission-mode auto');
  });
});

// --- Regressions found by /review ---

describe('concurrent scans', () => {
  beforeEach(resetBoard);

  it('never dispatches the same job twice when two scans overlap', async () => {
    // The "Run now" button and the interval timer both scan. dispatchOnce reads
    // job.state to pick candidates, awaits createSession, and only then sets
    // state='in-progress' — so without a guard both scans see the same job as
    // todo and spawn an agent for it: two worktrees, two branches, and one
    // orphaned agent the board never cleans up.
    addJob({ title: 'only once', repoPath: REPO }, noopBroadcast);
    const calls = [];
    const slowCreate = (() => {
      const inner = fakeCreateSession(calls);
      return async (...args) => {
        await new Promise(r => setTimeout(r, 20));   // widen the window
        return inner(...args);
      };
    })();

    const [a, b] = await Promise.all([
      runScan(slowCreate, noopBroadcast),
      runScan(slowCreate, noopBroadcast),
    ]);

    expect(calls).toHaveLength(1);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);   // one bounced
    expect(allJobs().filter(j => j.state === 'in-progress')).toHaveLength(1);
  });

  it('releases the guard so a later scan still runs', async () => {
    addJob({ title: 'first', repoPath: REPO }, noopBroadcast);
    const create = fakeCreateSession([]);
    await runScan(create, noopBroadcast);
    addJob({ title: 'second', repoPath: REPO }, noopBroadcast);
    const r = await runScan(create, noopBroadcast);
    expect(r.skipped).toBe(false);
    expect(allJobs().filter(j => j.state === 'in-progress')).toHaveLength(2);
  });

  it('releases the guard even when a scan throws', async () => {
    addJob({ title: 'boom', repoPath: REPO }, noopBroadcast);
    const exploding = async () => { throw new Error('spawn exploded'); };
    await expect(runScan(exploding, noopBroadcast)).rejects.toThrow('spawn exploded');
    const r = await runScan(fakeCreateSession([]), noopBroadcast);
    expect(r.skipped).toBe(false);
  });
});

describe('requeueing a job retires its agent', () => {
  beforeEach(resetBoard);

  it('closes the running agent so it cannot escape the cap', async () => {
    // Unlinking without killing left a live agent no job pointed at: it stopped
    // counting toward the cap, so the board dispatched a replacement alongside
    // it and repeating the move walked straight past the cap.
    addJob({ title: 'redo me', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;

    const killed = [];
    await moveJob(job.id, 'todo', noopBroadcast, { killSession: async (id) => { killed.push(id); sessions.delete(id); } });

    expect(killed).toEqual([sid]);
    expect(job.state).toBe('todo');
    expect(job.agentSessionId).toBeNull();
  });

  it('keeps the cap honest across repeated requeues', async () => {
    updateSettings({ maxPerRepo: 1 }, noopBroadcast);
    addJob({ title: 'flip flop', repoPath: REPO }, noopBroadcast);
    const create = fakeCreateSession([]);
    const kill = async (id) => { sessions.delete(id); };

    for (let i = 0; i < 4; i++) {
      await dispatchOnce(create, noopBroadcast);
      await moveJob(allJobs()[0].id, 'todo', noopBroadcast, { killSession: kill });
    }
    expect([...sessions.values()].filter(s => !s.exited)).toHaveLength(0);
  });

  it('also retires the agent on a manual move to review', async () => {
    // Same hole as the requeue, via the other button: countInFlightByRepo stops
    // counting a job the moment it leaves in-progress, so an agent left running
    // here keeps a worktree and a PTY while the board dispatches past the cap.
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const sid = allJobs()[0].agentSessionId;
    const killed = [];
    await moveJob(allJobs()[0].id, 'review', noopBroadcast, {
      killSession: async (id) => { killed.push(id); sessions.delete(id); },
    });
    expect(killed).toEqual([sid]);
  });

  it('keeps the cap honest when jobs are shunted to review by hand', async () => {
    updateSettings({ maxPerRepo: 1 }, noopBroadcast);
    for (let i = 0; i < 4; i++) addJob({ title: `J${i}`, repoPath: REPO }, noopBroadcast);
    const create = fakeCreateSession([]);
    const kill = async (id) => { sessions.delete(id); };
    for (let i = 0; i < 4; i++) {
      await dispatchOnce(create, noopBroadcast);
      const running = allJobs().find(j => j.state === 'in-progress');
      if (running) await moveJob(running.id, 'review', noopBroadcast, { killSession: kill });
    }
    expect([...sessions.values()].filter(s => !s.exited)).toHaveLength(0);
  });
});

// --- Regressions found by external review (gemini) ---

describe('the job can change while a dispatch is in flight', () => {
  beforeEach(resetBoard);

  // createSession takes seconds; WebSocket handlers run during it. The scan
  // guard serialises scans against each other, not against the user.
  function createDuring(mutate, calls = []) {
    const inner = fakeCreateSession(calls);
    return async (...args) => {
      const result = await inner(...args);
      mutate();                      // the user acts while the spawn completes
      return result;
    };
  }

  it('does not claim a job that was deleted mid-dispatch, and kills the agent', async () => {
    addJob({ title: 'gone', repoPath: REPO }, noopBroadcast);
    const jobId = allJobs()[0].id;
    const killed = [];
    const create = createDuring(() => { allJobs().length = 0; });

    await dispatchOnce(create, noopBroadcast, {
      killSession: async (id) => { killed.push(id); sessions.delete(id); },
    });

    // Without the re-check the agent runs on with no card pointing at it:
    // invisible to the board, uncounted by the cap, never cleaned up.
    expect(killed).toHaveLength(1);
    expect([...sessions.values()].filter(s => !s.exited)).toHaveLength(0);
    expect(allJobs().find(j => j.id === jobId)).toBeUndefined();
  });

  it('does not overwrite a state the user changed mid-dispatch', async () => {
    addJob({ title: 'requeued', repoPath: REPO }, noopBroadcast);
    const job = allJobs()[0];
    const create = createDuring(() => { job.state = 'review'; });

    await dispatchOnce(create, noopBroadcast, { killSession: async (id) => sessions.delete(id) });
    expect(job.state).toBe('review');       // not clobbered back to in-progress
    expect(job.agentSessionId).toBeNull();
  });

  it('does not apply a PR result to a job that moved on during the lookup', async () => {
    addJob({ title: 'racy', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];

    const killed = [];
    const findPr = async () => {
      // The user requeues while the gh lookup is in flight.
      job.state = 'todo';
      job.branchName = null;
      job.agentSessionId = null;
      return { pr: { url: 'u', number: 1 } };
    };
    await checkPullRequests(noopBroadcast, { findPr, killSession: async (id) => killed.push(id) });

    expect(job.state).toBe('todo');   // the user's action stands
    expect(killed).toEqual([]);       // and no unrelated agent was killed
  });
});

describe('deleting a job', () => {
  beforeEach(resetBoard);

  it('retires its agent instead of leaking it', async () => {
    addJob({ title: 'delete me', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const sid = allJobs()[0].agentSessionId;
    const killed = [];
    await deleteJob(allJobs()[0].id, noopBroadcast, { killSession: async (id) => { killed.push(id); sessions.delete(id); } });
    expect(killed).toEqual([sid]);
    expect(allJobs()).toHaveLength(0);
  });
});

describe('moveJob guards', () => {
  beforeEach(resetBoard);

  it('refuses to strand a never-dispatched job in in-progress', async () => {
    // Nothing could ever move it out again: the dispatcher only looks at todo,
    // the PR watcher only at jobs with a branch.
    addJob({ title: 'never started', repoPath: REPO }, noopBroadcast);
    const r = await moveJob(allJobs()[0].id, 'in-progress', noopBroadcast);
    expect(r.error).toMatch(/never been dispatched/i);
    expect(allJobs()[0].state).toBe('todo');
  });

  it('still allows review -> in-progress for a dispatched job', async () => {
    addJob({ title: 'real', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await moveJob(allJobs()[0].id, 'review', noopBroadcast);
    const r = await moveJob(allJobs()[0].id, 'in-progress', noopBroadcast);
    expect(r.error).toBeUndefined();
    expect(allJobs()[0].state).toBe('in-progress');
  });
});

// --- A PR check that cannot run must say so ---

describe('when the PR check itself fails', () => {
  beforeEach(resetBoard);

  const failing = (msg) => async () => ({ pr: null, error: msg });

  it('records the reason on the card instead of looking like a quiet agent', async () => {
    // Observed live: `gh pr list` returned "Could not resolve to a Repository"
    // because the signed-in account could not see that org. Every job in that
    // repo stalled forever, and the only symptom was a card reading
    // "quiet — may need you", which points at the agent, not the real cause.
    addJob({ title: 'invisible repo', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);

    await checkPullRequests(noopBroadcast, {
      findPr: failing("Could not resolve to a Repository with the name 'org/repo'"),
    });

    const job = allJobs()[0];
    expect(job.state).toBe('in-progress');          // it cannot advance, correctly
    expect(job.prCheckError).toMatch(/Cannot check for a pull request/i);
    expect(job.prCheckError).toMatch(/Could not resolve to a Repository/);
  });

  it('does not rewrite the job while the same failure repeats', async () => {
    // A permanent failure recurs every five minutes; it must not churn config.
    addJob({ title: 'repeat', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const findPr = failing('gh: not authenticated');

    await checkPullRequests(noopBroadcast, { findPr });
    const firstStamp = allJobs()[0].prCheckErrorAt;
    await checkPullRequests(noopBroadcast, { findPr });
    expect(allJobs()[0].prCheckErrorAt).toBe(firstStamp);
  });

  it('clears the note as soon as the check works again, PR or not', async () => {
    // The failure the previous version had: it only cleared on a PR being
    // found, so a repo that regained access kept claiming it was unreachable
    // until a PR happened to appear.
    addJob({ title: 'access restored', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await checkPullRequests(noopBroadcast, { findPr: failing('gh: not authenticated') });
    expect(allJobs()[0].prCheckError).toBeTruthy();

    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr: null }) });
    const job = allJobs()[0];
    expect(job.state).toBe('in-progress');   // still no PR, correctly
    expect(job.prCheckError).toBeNull();     // but no longer claiming it cannot look
  });

  it('leaves a restart note alone when the check works', async () => {
    // A restart note names where the work is. It stays true whether or not the
    // PR check succeeds, so only the PR-check note may be cleared.
    addJob({ title: 'restarted', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    job.lastError = 'Server restarted — agent lost. Work is on bill/x.';

    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr: null }) });
    expect(allJobs()[0].lastError).toMatch(/Server restarted/);
  });

  it('does not write an error onto a job that moved on during the lookup', async () => {
    // findPr is a network call; WebSocket handlers run during it.
    addJob({ title: 'requeued mid-check', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];

    await checkPullRequests(noopBroadcast, {
      findPr: async () => {
        job.state = 'todo';
        job.branchName = null;
        job.agentSessionId = null;
        return { pr: null, error: 'gh: not authenticated' };
      },
    });
    expect(job.state).toBe('todo');
    expect(job.prCheckError).toBeNull();
  });

  it('clears the note once the check succeeds', async () => {
    addJob({ title: 'recovers', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await checkPullRequests(noopBroadcast, { findPr: failing('gh: not authenticated') });
    expect(allJobs()[0].prCheckError).toBeTruthy();

    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'u', number: 4 } }),
      killSession: async (id) => sessions.delete(id),
    });
    const job = allJobs()[0];
    expect(job.state).toBe('review');
    expect(job.prCheckError).toBeNull();
  });

  it('an empty result is still just "no PR yet", not an error', async () => {
    addJob({ title: 'not ready', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr: null }) });
    const job = allJobs()[0];
    expect(job.state).toBe('in-progress');
    expect(job.lastError).toBeNull();
  });
});

// --- Reconnecting a re-adopted agent to its job ---

describe('relinkSessionToJob', () => {
  beforeEach(resetBoard);

  // What a restart leaves behind: the card keeps its branch, the session link is
  // gone, and re-adopting the orphan produces a brand new session.
  async function afterRestart() {
    addJob({ title: 'interrupted', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const branch = job.branchName;
    sessions.clear();
    job.agentSessionId = null;
    job.agentName = null;
    job.lastError = 'Server restarted — agent lost.';
    return { job, branch };
  }

  it('reconnects the agent to its card, matched on the branch', async () => {
    const { job, branch } = await afterRestart();
    const readopted = { id: 'session-99', name: 'Mirage', repoPath: REPO, branchName: branch, exited: false };
    sessions.set(readopted.id, readopted);

    const linked = relinkSessionToJob(readopted, noopBroadcast);
    expect(linked).toBe(job);
    expect(job.agentSessionId).toBe('session-99');
    expect(job.agentName).toBe('Mirage');
    expect(job.lastError).toBeNull();
    // Tagged so the PR path can retire it like any other board agent.
    expect(readopted.jobId).toBe(job.id);
  });

  it('makes the job count toward the cap again', async () => {
    // Until it is relinked the job occupies no slot, so the board would happily
    // dispatch a second agent for the same repo alongside the one that is back.
    const { branch } = await afterRestart();
    updateSettings({ maxPerRepo: 1 }, noopBroadcast);
    addJob({ title: 'next up', repoPath: REPO }, noopBroadcast);

    const readopted = { id: 'session-99', name: 'Mirage', repoPath: REPO, branchName: branch, exited: false };
    sessions.set(readopted.id, readopted);
    relinkSessionToJob(readopted, noopBroadcast);

    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    expect(allJobs()[1].state).toBe('todo');   // capped by the reconnected agent
  });

  it('never steals a job that already has a live agent', async () => {
    addJob({ title: 'busy', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const original = job.agentSessionId;

    const impostor = { id: 'session-99', name: 'Other', repoPath: REPO, branchName: job.branchName, exited: false };
    expect(relinkSessionToJob(impostor, noopBroadcast)).toBeNull();
    expect(job.agentSessionId).toBe(original);
  });

  it('ignores a session whose branch matches no job, or a different repo', async () => {
    const { branch } = await afterRestart();
    expect(relinkSessionToJob({ id: 's', name: 'X', repoPath: REPO, branchName: 'unrelated' }, noopBroadcast)).toBeNull();
    expect(relinkSessionToJob({ id: 's', name: 'X', repoPath: REPO2, branchName: branch }, noopBroadcast)).toBeNull();
    expect(relinkSessionToJob({ id: 's', name: 'X', repoPath: REPO }, noopBroadcast)).toBeNull();
  });
});

describe('a PR-check failure and another note coexist', () => {
  beforeEach(resetBoard);

  it('keeps the restart note AND records why the check cannot run', async () => {
    // Both are true at once: the agent is gone, and the board cannot see this
    // repo's pull requests. Sharing one field meant clobbering one or hiding
    // the other, so they get their own fields.
    addJob({ title: 'restarted', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    job.lastError = 'Server restarted — agent lost. Work is on bill/x.';

    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: null, error: 'gh: not authenticated' }),
    });
    expect(allJobs()[0].lastError).toMatch(/Server restarted/);
    expect(allJobs()[0].prCheckError).toMatch(/Cannot check for a pull request/);
  });

  it('clearing the PR-check note leaves the other one alone', async () => {
    addJob({ title: 'both', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    job.lastError = 'Server restarted — agent lost. Work is on bill/x.';
    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr: null, error: 'gh: boom' }) });

    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr: null }) });
    expect(allJobs()[0].prCheckError).toBeNull();
    expect(allJobs()[0].lastError).toMatch(/Server restarted/);
  });
});

// --- Agents left running after their job already shipped ---

describe('retiring the agent when the link is missing', () => {
  beforeEach(resetBoard);

  // The live shape this fixes: a restart nulls agentSessionId, so the PR is
  // found with nothing recorded to retire. Before, the agent kept running and
  // holding a worktree for work that had already shipped.
  async function unlinkedButRunning() {
    addJob({ title: 'restarted then shipped', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const branch = job.branchName;
    sessions.clear();
    job.agentSessionId = null;
    job.agentName = null;
    const running = { id: 'session-99', name: 'Ghost', repoPath: REPO, branchName: branch, exited: false };
    sessions.set(running.id, running);
    return { job, running };
  }

  it('finds the agent by branch and retires it as the job moves to review', async () => {
    const { job, running } = await unlinkedButRunning();
    const killed = [];
    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'u', number: 42 } }),
      killSession: async (id) => { killed.push(id); sessions.delete(id); },
    });
    expect(killed).toEqual([running.id]);
    expect(job.state).toBe('review');
    expect(job.agentName).toBe('Ghost');      // credit recorded before it went
    expect(job.agentSessionId).toBeNull();
  });

  it('does not touch a session on the same branch in a different repo', async () => {
    const { running } = await unlinkedButRunning();
    running.repoPath = REPO2;
    const killed = [];
    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'u', number: 42 } }),
      killSession: async (id) => killed.push(id),
    });
    expect(killed).toEqual([]);
  });

  it('keeps the link when the kill fails, so the agent stays reachable', async () => {
    addJob({ title: 'stubborn', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;
    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'u', number: 42 } }),
      killSession: async () => { throw new Error('worktree busy'); },
    });
    expect(job.state).toBe('review');          // the PR is open either way
    expect(job.agentSessionId).toBe(sid);      // not nulled into a zombie
  });

  it('never sweeps agents on jobs that are ALREADY in review', async () => {
    // An agent re-adopted on a shipped branch to address review comments is the
    // user's. A recurring sweep would kill it every five minutes.
    const { job, running } = await unlinkedButRunning();
    job.state = 'review';
    job.prNumber = 42;
    const killed = [];
    await runScan(fakeCreateSession([]), noopBroadcast, {
      findPr: async () => ({ pr: { url: 'u', number: 42 } }),
      killSession: async (id) => killed.push(id),
    });
    expect(killed).toEqual([]);
    expect(sessions.has(running.id)).toBe(true);
  });
});

describe('relink covers a job that already reached review', () => {
  beforeEach(resetBoard);

  it('prefers a job still in progress over an older one already in review', async () => {
    addJob({ title: 'old, shipped', repoPath: REPO }, noopBroadcast);
    addJob({ title: 'new, running', repoPath: REPO }, noopBroadcast);
    const [older, newer] = allJobs();
    older.state = 'review';
    older.branchName = 'bill/shared';
    newer.state = 'in-progress';
    newer.branchName = 'bill/shared';

    const readopted = { id: 'session-99', name: 'Ghost', repoPath: REPO, branchName: 'bill/shared', exited: false };
    expect(relinkSessionToJob(readopted, noopBroadcast)).toBe(newer);
    expect(older.agentSessionId).toBeNull();
  });

  it('reconnects an agent whose job moved to review while it was gone', async () => {
    addJob({ title: 'shipped during restart', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const branch = job.branchName;
    sessions.clear();
    job.agentSessionId = null;
    job.agentName = null;
    job.state = 'review';

    const readopted = { id: 'session-99', name: 'Ghost', repoPath: REPO, branchName: branch, exited: false };
    expect(relinkSessionToJob(readopted, noopBroadcast)).toBe(job);
    expect(job.agentSessionId).toBe('session-99');
  });
});

// --- A finished card must say what it produced ---

describe('review cards keep their record', () => {
  beforeEach(resetBoard);

  it('clears the restart note once the PR is found', async () => {
    // The note says the board is still watching for this PR. Finding it makes
    // the note false on its own card.
    addJob({ title: 'restarted then shipped', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    job.lastError = 'Server restarted — agent lost. The board is still watching for its PR.';

    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'u', number: 102 } }),
      killSession: async (id) => sessions.delete(id),
    });
    expect(job.state).toBe('review');
    expect(job.prNumber).toBe(102);
    expect(job.lastError).toBeNull();
  });

  it('a manual move to review picks up the PR that already exists', async () => {
    // Nothing else backfills it: the watcher only examines in-progress jobs, so
    // the card would sit in Review with no link to what it produced.
    addJob({ title: 'shipped elsewhere', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];

    await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async (id) => sessions.delete(id),
      findPr: async () => ({ pr: { url: 'https://gh/o/r/pull/18', number: 18 } }),
    });
    expect(job.state).toBe('review');
    expect(job.prNumber).toBe(18);
    expect(job.prUrl).toBe('https://gh/o/r/pull/18');
  });

  it('a manual move still works when there is no PR to find', async () => {
    addJob({ title: 'no pr', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async (id) => sessions.delete(id),
      findPr: async () => ({ pr: null, error: 'gh: not authenticated' }),
    });
    expect(job.state).toBe('review');
    expect(job.prNumber).toBeNull();
  });

  it('does not re-look-up a PR the card already has', async () => {
    addJob({ title: 'already linked', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    job.prNumber = 7;
    let looked = false;
    await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async (id) => sessions.delete(id),
      findPr: async () => { looked = true; return { pr: null }; },
    });
    expect(looked).toBe(false);
    expect(job.prNumber).toBe(7);
  });
});

describe('a manual move survives a bad PR lookup', () => {
  beforeEach(resetBoard);

  it('still moves and still retires the agent when the lookup throws', async () => {
    // The lookup runs before persist and before the kill; a throw there would
    // leave the job changed in memory, never saved, agent never retired.
    addJob({ title: 'lookup explodes', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;
    const killed = [];

    const result = await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async (id) => { killed.push(id); sessions.delete(id); },
      findPr: async () => { throw new Error('network down'); },
    });
    expect(result.error).toBeUndefined();
    expect(job.state).toBe('review');
    expect(killed).toEqual([sid]);
    expect(job.prNumber).toBeNull();      // no link, as before
  });

  it('clears the agent link once the agent is actually gone', async () => {
    addJob({ title: 'linked then retired', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async (id) => sessions.delete(id),
      findPr: async () => ({ pr: null }),
    });
    expect(job.agentSessionId).toBeNull();
  });

  it('keeps the link when the kill fails, so the agent stays reachable', async () => {
    addJob({ title: 'stubborn agent', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;
    await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async () => { throw new Error('worktree busy'); },
      findPr: async () => ({ pr: null }),
    });
    expect(job.agentSessionId).toBe(sid);
  });
});

describe('moving to review when the agent is already gone', () => {
  beforeEach(resetBoard);

  it('drops the dead link rather than leaving a stale id on the card', async () => {
    // A stale id is how a finished card outlived a restart and then resolved to
    // an unrelated agent in the next process generation.
    addJob({ title: 'agent already exited', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    sessions.get(job.agentSessionId).exited = true;

    const killed = [];
    await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async (id) => killed.push(id),
      findPr: async () => ({ pr: null }),
    });
    expect(killed).toEqual([]);              // nothing to kill
    expect(job.agentSessionId).toBeNull();   // but the link still goes
  });
});

describe('requeueing clears every per-attempt field', () => {
  beforeEach(resetBoard);

  it('drops the PR-check note along with the branch and PR', async () => {
    // The note describes an attempt that no longer exists; carrying it onto a
    // fresh To do card reports a failure against work not yet tried.
    addJob({ title: 'unreachable repo', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: null, error: 'Could not resolve to a Repository' }),
    });
    const job = allJobs()[0];
    expect(job.prCheckError).toBeTruthy();

    await moveJob(job.id, 'todo', noopBroadcast, { killSession: async (id) => sessions.delete(id) });
    expect(job.state).toBe('todo');
    expect(job.prCheckError).toBeNull();
    expect(job.prCheckErrorAt).toBeNull();
    expect(job.branchName).toBeNull();
    expect(job.prNumber).toBeNull();
  });
});

describe('a manual move that races a requeue', () => {
  beforeEach(resetBoard);

  it('does not leave PR links on a card that went back to To do', async () => {
    // findPr is a network call; a requeue during it would otherwise resume and
    // write prUrl/prNumber onto a job that is now todo.
    addJob({ title: 'raced', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];

    await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async (id) => sessions.delete(id),
      findPr: async () => {
        job.state = 'todo';          // the user requeues mid-lookup
        return { pr: { url: 'u', number: 55 } };
      },
    });
    expect(job.state).toBe('todo');
    expect(job.prNumber).toBeNull();
    expect(job.prUrl).toBeNull();
  });

  it('clears a stale PR-check note when the manual move finds the PR', async () => {
    addJob({ title: 'had a failure', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    job.prCheckError = 'Cannot check for a pull request here — gh: not authenticated.';

    await moveJob(job.id, 'review', noopBroadcast, {
      killSession: async (id) => sessions.delete(id),
      findPr: async () => ({ pr: { url: 'u', number: 18 } }),
    });
    expect(job.prNumber).toBe(18);
    expect(job.prCheckError).toBeNull();
  });
});
