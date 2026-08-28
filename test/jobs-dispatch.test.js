import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { dispatchOnce, addJob, moveJob, deleteJob, updateSettings, boardSettings, allJobs, jobsPayload, checkPullRequests, runScan, relinkSessionToJob } from '../server/jobs.js';
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
    expect((await moveJob(allJobs()[0].id, 'done', noopBroadcast)).error).toMatch(/Unknown state/);
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
    expect(job.lastError).toMatch(/Cannot check for a pull request/i);
    expect(job.lastError).toMatch(/Could not resolve to a Repository/);
  });

  it('does not rewrite the job while the same failure repeats', async () => {
    // A permanent failure recurs every five minutes; it must not churn config.
    addJob({ title: 'repeat', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const findPr = failing('gh: not authenticated');

    await checkPullRequests(noopBroadcast, { findPr });
    const firstStamp = allJobs()[0].lastErrorAt;
    await checkPullRequests(noopBroadcast, { findPr });
    expect(allJobs()[0].lastErrorAt).toBe(firstStamp);
  });

  it('clears the note once the check succeeds', async () => {
    addJob({ title: 'recovers', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await checkPullRequests(noopBroadcast, { findPr: failing('gh: not authenticated') });
    expect(allJobs()[0].lastError).toBeTruthy();

    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'u', number: 4 } }),
      killSession: async (id) => sessions.delete(id),
    });
    const job = allJobs()[0];
    expect(job.state).toBe('review');
    expect(job.lastError).toBeNull();
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
