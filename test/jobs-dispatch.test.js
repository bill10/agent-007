import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions, orphans, adoptingOrphans } from '../server/state.js';
import { dispatchOnce, addJob, updateJob, moveJob, deleteJob, updateSettings, boardSettings, allJobs, jobsPayload, checkPullRequests, checkMergedPullRequests, runScan, relinkSessionToJob, attachmentPath, finishJobForAgent, postJobForAgent, editJobForAgent } from '../server/jobs.js';
import { parseCommand } from '../lib/helpers.js';
import { buildJobCommand as buildCommand, buildJobPrompt, jobRequiresPr, DEFAULT_PERMISSION_MODE } from '../lib/jobs.js';

// A real directory, because dispatchOnce filters to repos that exist on disk.
const REPO = mkdtempSync(join(tmpdir(), 'a007-jobrepo-'));
const REPO2 = mkdtempSync(join(tmpdir(), 'a007-jobrepo2-'));

// Swallow config writes: saveConfig targets the developer's real ~/.agent-007.
const noopBroadcast = () => {};

// A worktree path guaranteed not to exist, for orphans whose directory is gone.
const GONE_WORKTREE = join(mkdtempSync(join(tmpdir(), 'a007-gone-')), 'worktree');

function resetBoard() {
  config.repos = [{ path: REPO }, { path: REPO2 }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
  orphans.clear();
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

describe('attachments', () => {
  beforeEach(resetBoard);

  const png = Buffer.from('not really a png').toString('base64');

  it('writes posted files under the config dir, keeps or drops them on edit, and removes them with the card', async () => {
    const { job } = addJob({
      title: 'Fix the header', repoPath: REPO,
      attachments: [{ name: 'shot.png', data: png }, { name: '../evil/../../x.txt', data: png }],
    }, noopBroadcast);
    expect(job.attachments.map(a => a.name)).toEqual(['shot.png', '.._evil_.._.._x.txt']);
    const shot = job.attachments[0].path;
    expect(shot).toBe(join(process.env.AGENT007_CONFIG_DIR, 'attachments', job.id, 'shot.png'));
    expect(readFileSync(shot, 'utf8')).toBe('not really a png');
    expect(attachmentPath(job.id, 'shot.png')).toBe(shot);
    expect(attachmentPath(job.id, 'nope.png')).toBeNull();
    expect(parseCommand(job && buildCommand(job)).args[2]).toContain(shot);

    // An edit that names only one file keeps that one and deletes the other;
    // an edit that says nothing about attachments leaves them alone.
    updateJob(job.id, { title: 'Fix the header (v2)' }, noopBroadcast);
    expect(allJobs()[0].attachments).toHaveLength(2);
    updateJob(job.id, { attachments: [{ name: 'shot.png' }] }, noopBroadcast);
    expect(allJobs()[0].attachments.map(a => a.name)).toEqual(['shot.png']);
    expect(existsSync(join(process.env.AGENT007_CONFIG_DIR, 'attachments', job.id, '.._evil_.._.._x.txt'))).toBe(false);
    expect(existsSync(shot)).toBe(true);

    expect(addJob({ title: 'Big', repoPath: REPO, attachments: [{ name: 'big.bin', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }] }, noopBroadcast).error).toMatch(/too large/);

    await deleteJob(job.id, noopBroadcast);
    expect(existsSync(shot)).toBe(false);
  });

  it('refuses rather than silently drops, leaves a half-edit unapplied, and never deletes outside its dir', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.txt`, data: png }));
    expect(addJob({ title: 'Many', repoPath: REPO, attachments: many }, noopBroadcast).error).toMatch(/at most 20/i);
    expect(addJob({ title: 'Dots', repoPath: REPO, attachments: [{ name: '...', data: png }] }, noopBroadcast).error).toMatch(/unusable/i);
    expect(addJob({ title: 'Case', repoPath: REPO, attachments: [{ name: 'A.png', data: png }, { name: 'a.png', data: png }] }, noopBroadcast).error).toMatch(/stored as/i);
    expect(addJob({ title: 'Dev', repoPath: REPO, attachments: [{ name: 'CON.png', data: png }] }, noopBroadcast).job.attachments[0].name).toBe('_CON.png');
    expect(allJobs()).toHaveLength(1);

    // A kept entry with no file behind it is dropped from a new card.
    const { job } = addJob({ title: 'Ghost', repoPath: REPO, attachments: [{ name: 'ghost.png' }, { name: 'real.png', data: png }] }, noopBroadcast);
    expect(job.attachments.map(a => a.name)).toEqual(['real.png']);

    // A refused save changes nothing, not even the title.
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    expect(updateJob(job.id, { title: 'Renamed', attachments: [{ name: 'real.png' }, { name: 'big.bin', data: big }] }, noopBroadcast).error).toMatch(/too large/);
    const stored = () => allJobs().find(j => j.id === job.id);
    expect(stored().title).toBe('Ghost');
    expect(existsSync(join(process.env.AGENT007_CONFIG_DIR, 'attachments', job.id, 'big.bin'))).toBe(false);

    // A hand-edited path outside the job's dir is left alone when dropped,
    // and is never served.
    const outside = join(REPO, 'keep-me.txt');
    writeFileSync(outside, 'x');
    job.attachments.push({ name: 'keep-me.txt', path: outside });
    expect(attachmentPath(job.id, 'keep-me.txt')).toBeNull();
    updateJob(job.id, { attachments: [{ name: 'real.png' }] }, noopBroadcast);
    expect(existsSync(outside)).toBe(true);
    expect(stored().attachments.map(a => a.name)).toEqual(['real.png']);

    // Resending the same list is not an attachment change, so an ordinary
    // retitle goes through untouched.
    expect(updateJob(job.id, { title: 'Still fine', attachments: [{ name: 'real.png' }] }, noopBroadcast).error).toBeUndefined();
    expect(stored().attachments).toHaveLength(1);
    // A file that vanished from disk stays on the record rather than being
    // dropped from the card by an edit that never mentioned it.
    rmSync(stored().attachments[0].path);
    expect(updateJob(job.id, { title: 'Still fine 2', attachments: [{ name: 'real.png' }] }, noopBroadcast).error).toBeUndefined();
    expect(stored().attachments.map(a => a.name)).toEqual(['real.png']);
    expect(stored().title).toBe('Still fine 2');

    // Once dispatched the card is closed to edits of every kind: the agent
    // holds these paths, and the title and detail it was handed. The board's
    // own form is the caller here (ws.js job-update), not an agent.
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    expect(stored().state).toBe('in-progress');
    expect(updateJob(job.id, { attachments: [] }, noopBroadcast).error).toMatch(/To do/);
    expect(updateJob(job.id, { title: 'Too late' }, noopBroadcast).error).toMatch(/To do/);
    // Before this gate, a repoPath sent post-dispatch was silently dropped
    // rather than refused (only applied `state === 'todo'`); it now refuses
    // like every other field.
    expect(updateJob(job.id, { repoPath: REPO2 }, noopBroadcast).error).toMatch(/To do/);
    expect(stored().repoPath).toBe(REPO);
    expect(stored().title).toBe('Still fine 2');
  });

  it('refuses a board-form save in every column past To do, not just in progress', () => {
    // The gate is one function for the form and for an agent, but only the
    // form can reach a card sitting in Review or in the finished archive.
    for (const state of ['in-progress', 'review', 'done']) {
      const { job } = addJob({ title: `Sitting in ${state}`, repoPath: REPO }, noopBroadcast);
      job.state = state;
      expect(updateJob(job.id, { title: 'Rewritten' }, noopBroadcast).error, state).toMatch(/To do/);
      expect(job.title, state).toBe(`Sitting in ${state}`);
    }
  });

  it('replaces a file in place and leaves no staging file behind', () => {
    const { job } = addJob({ title: 'Swap', repoPath: REPO, attachments: [{ name: 'a.txt', data: Buffer.from('one').toString('base64') }] }, noopBroadcast);
    updateJob(job.id, { attachments: [{ name: 'a.txt', data: Buffer.from('two').toString('base64') }] }, noopBroadcast);
    expect(readFileSync(job.attachments[0].path, 'utf8')).toBe('two');
    expect(existsSync(job.attachments[0].path + '~part')).toBe(false);
  });

  it('frees the files, records and all, the moment the card reaches done', async () => {
    const { job } = addJob({ title: 'Ship it', repoPath: REPO, attachments: [{ name: 'shot.png', data: png }] }, noopBroadcast);
    const dir = join(process.env.AGENT007_CONFIG_DIR, 'attachments', job.id);
    await moveJob(job.id, 'done', noopBroadcast);
    expect(allJobs()[0].attachments).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});

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

  // Review is finished work with its agent kept on hand; Done retires it.
  it('keeps the agent when the card moves to review', async () => {
    const job = await dispatched();
    const sid = job.agentSessionId;
    const findPr = withPr({ url: 'u', number: 1 });
    const killed = [];
    await checkPullRequests(noopBroadcast, { findPr });
    expect(job.state).toBe('review');
    expect(job.agentSessionId).toBe(sid);
    expect(sessions.has(sid)).toBe(true);
  });

  it('leaves a card that needs no PR to its agent, even when a PR exists', async () => {
    addJob({ title: 'research', repoPath: REPO, requiresPr: false }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await checkPullRequests(noopBroadcast, { findPr: withPr({ url: 'u', number: 1 }) });
    expect(job.state).toBe('in-progress');
  });

  it('keeps the credit on the card after the agent is gone', async () => {
    // Requirement 3: who worked on it, and since when — a review card must
    // still answer that once its agent has been retired.
    const job = await dispatched();
    const agentName = job.agentName, branch = job.branchName, started = job.startedAt;
    const findPr = withPr({ url: 'u', number: 3 });
    await checkPullRequests(noopBroadcast, { findPr });
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
    addJob({ title: 'landed', repoPath: REPO, attachments: [{ name: 'shot.png', data: Buffer.from('png').toString('base64') }] }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    await checkPullRequests(noopBroadcast, {
      findPr: async () => ({ pr: { url: 'https://gh/o/r/pull/5', number: 5 } }),
      killSession: async (id) => sessions.delete(id),
    });
    return allJobs()[0];
  }

  it('takes a merged job off the board and records when it merged', async () => {
    const job = await inReview();
    const sid = job.agentSessionId;
    const killed = [];
    const finished = await checkMergedPullRequests(noopBroadcast, {
      findMerged: merged({ url: 'https://gh/o/r/pull/5', number: 5, mergedAt: '2026-08-28T10:00:00Z' }),
      killSession: async (id) => { killed.push(id); sessions.delete(id); },
    });
    // Merged means finished: the agent kept through Review goes now.
    expect(killed).toEqual([sid]);
    expect(finished).toHaveLength(1);
    expect(job.state).toBe('done');
    expect(job.prMergedAt).toBe('2026-08-28T10:00:00Z');
    expect(Date.parse(job.doneAt)).not.toBeNaN();
    // The record survives: the card is the only place the PR link lives.
    expect(job.prUrl).toBe('https://gh/o/r/pull/5');
    expect(job.prNumber).toBe(5);
    // The files do not: the run they were input to is over.
    expect(job.attachments).toEqual([]);
    expect(existsSync(join(process.env.AGENT007_CONFIG_DIR, 'attachments', job.id))).toBe(false);
  });

  it('keeps the files while a re-adopted agent is live, frees them on a later sweep once it exits', async () => {
    const job = await inReview();
    // A live agent re-adopted onto the Review card: the sweep deliberately
    // does not retire it, so its prompt's file paths must stay readable.
    sessions.set('s-live', { id: 's-live', exited: false, branchName: job.branchName, repoPath: REPO });
    job.agentSessionId = 's-live';
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: merged({ url: 'https://gh/o/r/pull/5', number: 5, mergedAt: '2026-08-28T10:00:00Z' }),
    });
    expect(job.state).toBe('done');
    expect(job.attachments).toHaveLength(1);
    const dir = join(process.env.AGENT007_CONFIG_DIR, 'attachments', job.id);
    expect(existsSync(dir)).toBe(true);
    // Once the session ends, the next sweep's retry pass reclaims the disk —
    // even though the done card is no longer a merge candidate.
    sessions.get('s-live').exited = true;
    await checkMergedPullRequests(noopBroadcast, { findMerged: merged(null) });
    expect(job.attachments).toEqual([]);
    expect(existsSync(dir)).toBe(false);
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

// --- Kept Review agents do not hold cap slots ---

describe('agents do not pile up across many jobs', () => {
  beforeEach(resetBoard);

  it('never runs more agents than the cap, and drains the whole queue', async () => {
    // The cap counts in-progress jobs. Agents kept with their cards in Review
    // are idle and do not count, so this measures the agents on In progress
    // cards: if the cap ever counted wrong, more than two would be working.
    updateSettings({ maxPerRepo: 2 }, noopBroadcast);
    for (let i = 0; i < 8; i++) addJob({ title: `J${i}`, repoPath: REPO }, noopBroadcast);

    const create = fakeCreateSession([]);
    const findPr = async () => ({ pr: { url: 'u', number: 1 } });
    const kill = async (id) => { sessions.delete(id); };

    let peak = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      await dispatchOnce(create, noopBroadcast);
      peak = Math.max(peak, allJobs().filter(j => j.state === 'in-progress' && sessions.has(j.agentSessionId)).length);
      await checkPullRequests(noopBroadcast, { findPr });
    }

    expect(peak).toBeLessThanOrEqual(2);
    expect(allJobs().filter(j => j.state === 'review')).toHaveLength(8);
    // Done is what retires them.
    for (const job of allJobs()) await moveJob(job.id, 'done', noopBroadcast, { killSession: kill });
    expect([...sessions.values()].filter(s => !s.exited)).toHaveLength(0);
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

  it('runs the agent in the board default permission mode', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    const calls = [];
    await dispatchOnce(fakeCreateSession(calls), noopBroadcast);
    expect(calls[0].command).toContain(`--permission-mode ${DEFAULT_PERMISSION_MODE}`);
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

  it('keeps the agent on a manual move to review, and retires it on done', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;
    const killed = [];
    const killSession = async (id) => { killed.push(id); sessions.delete(id); };
    await moveJob(job.id, 'review', noopBroadcast, { killSession, findPr: async () => ({ pr: null }) });
    expect(killed).toEqual([]);
    expect(job.agentSessionId).toBe(sid);
    await moveJob(job.id, 'done', noopBroadcast, { killSession });
    expect(killed).toEqual([sid]);
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
    expect(relinkSessionToJob(null, noopBroadcast)).toBeNull();
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

  it('finds the agent by branch and retires it as the merged job moves to done', async () => {
    const { job, running } = await unlinkedButRunning();
    const killed = [];
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async () => ({ pr: { url: 'u', number: 42, mergedAt: '2026-08-28T10:00:00Z' } }),
      killSession: async (id) => { killed.push(id); sessions.delete(id); },
    });
    expect(killed).toEqual([running.id]);
    expect(job.state).toBe('done');
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

  it('still moves, keeping the agent, when the lookup throws', async () => {
    // The lookup runs before persist; a throw there would leave the job
    // changed in memory and never saved.
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
    expect(killed).toEqual([]);           // Review keeps its agent
    expect(job.agentSessionId).toBe(sid);
    expect(job.prNumber).toBeNull();      // no link, as before
  });

  it('clears the agent link once the agent is actually gone', async () => {
    addJob({ title: 'linked then retired', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'done', noopBroadcast, {
      killSession: async (id) => sessions.delete(id),
    });
    expect(job.agentSessionId).toBeNull();
  });

  it('keeps the link when the kill fails, so the agent stays reachable', async () => {
    addJob({ title: 'stubborn agent', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const sid = job.agentSessionId;
    await moveJob(job.id, 'done', noopBroadcast, {
      killSession: async () => { throw new Error('worktree busy'); },
    });
    expect(job.agentSessionId).toBe(sid);
  });
});

describe('moving to done when the agent is already gone', () => {
  beforeEach(resetBoard);

  it('drops the dead link rather than leaving a stale id on the card', async () => {
    // A stale id is how a finished card outlived a restart and then resolved to
    // an unrelated agent in the next process generation.
    addJob({ title: 'agent already exited', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    sessions.get(job.agentSessionId).exited = true;

    const killed = [];
    await moveJob(job.id, 'done', noopBroadcast, {
      killSession: async (id) => killed.push(id),
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

// --- finish_job: the agent reports its own finish ---

describe('finishJobForAgent', () => {
  beforeEach(resetBoard);

  async function running(fields = {}) {
    addJob({ title: 'work', repoPath: REPO, ...fields }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    return { job, session: sessions.get(job.agentSessionId) };
  }
  const openPr = (pr) => async () => ({ pr });

  it('moves a PR job to review with the PR it names, keeping the agent', async () => {
    const { job, session } = await running();
    const result = await finishJobForAgent({ session, prUrl: 'https://github.com/o/r/pull/5/' }, noopBroadcast,
      { findPr: openPr({ url: 'https://github.com/o/r/pull/5', number: 5 }) });
    expect(result.error).toBeUndefined();
    expect(job.state).toBe('review');
    expect(job.prNumber).toBe(5);
    expect(job.agentSessionId).toBe(session.id);
  });

  it('refuses a PR job with no PR url, or one that is not the branch PR', async () => {
    const { job, session } = await running();
    const findPr = openPr({ url: 'https://github.com/o/r/pull/5', number: 5 });
    expect((await finishJobForAgent({ session }, noopBroadcast, { findPr })).error).toMatch(/\/ship/);
    expect((await finishJobForAgent({ session, prUrl: 'https://github.com/o/r/pull/6' }, noopBroadcast, { findPr })).error)
      .toMatch(/pull\/5/);
    expect((await finishJobForAgent({ session, prUrl: 'https://github.com/o/r/pull/5' }, noopBroadcast,
      { findPr: openPr(null) })).error).toMatch(/no open pull request/);
    expect(job.state).toBe('in-progress');
  });

  it('moves a no-PR job to review with its summary, and needs one', async () => {
    const { job, session } = await running({ requiresPr: false });
    expect((await finishJobForAgent({ session }, noopBroadcast)).error).toMatch(/summary/);
    const result = await finishJobForAgent({ session, summary: 'Found the leak in pty.js.' }, noopBroadcast);
    expect(result.error).toBeUndefined();
    expect(job.state).toBe('review');
    expect(job.resultSummary).toBe('Found the leak in pty.js.');
    expect(job.agentSessionId).toBe(session.id);
  });

  it('only lets the linked agent finish its own card', async () => {
    const { job } = await running({ requiresPr: false });
    const stranger = { id: 'session-other', name: 'Stranger' };
    expect((await finishJobForAgent({ session: stranger, summary: 'x' }, noopBroadcast)).error).toMatch(/not working a job/);
    expect(job.state).toBe('in-progress');
  });
});

describe('the one-time prompt', () => {
  it('asks for /ship then finish_job with the PR on a PR job, and no /ship otherwise', () => {
    const pr = buildJobPrompt({ title: 't', requiresPr: true });
    expect(pr).toContain('/ship');
    expect(pr).toMatch(/finish_job[\s\S]*pr_url/);
    const noPr = buildJobPrompt({ title: 't', requiresPr: false });
    expect(noPr).not.toContain('ship');
    expect(noPr).toMatch(/finish_job[\s\S]*summary/);
  });
});

describe('done after a restart', () => {
  beforeEach(resetBoard);

  // A restart leaves a kept Review agent's worktree as an orphan record, not a
  // session. Done must still release it.
  // Done's release is covered below; To do clears the branch off the card
  // first, so the release has to work from what the card held before.
  it('releases the orphaned worktree of a review card moved back to To do', async () => {
    addJob({ title: 'kept then restarted', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'review', noopBroadcast, { findPr: async () => ({ pr: null }) });
    sessions.clear();
    job.agentSessionId = null;
    job.worktreePath = GONE_WORKTREE;
    orphans.set('orphan-1', { id: 'orphan-1', name: 'Viper', repoPath: REPO, branchName: job.branchName,
      worktreePath: GONE_WORKTREE });   // already gone from disk
    await moveJob(job.id, 'todo', noopBroadcast);
    expect(orphans.has('orphan-1')).toBe(false);
    expect(job.branchName).toBeNull();
  });
});

// --- finish_job refusals, and the no-PR / orphan edges of Review and Done ---

describe('finishJobForAgent refusals', () => {
  beforeEach(resetBoard);

  async function running(fields = {}) {
    addJob({ title: 'work', repoPath: REPO, ...fields }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    return { job, session: sessions.get(job.agentSessionId) };
  }

  it('refuses with no session at all', async () => {
    expect((await finishJobForAgent({}, noopBroadcast)).error).toMatch(/not working a job/);
  });

  // The poller can find the PR /ship opened before the agent calls in.
  it('succeeds when the card is already in Review, keeping a new summary', async () => {
    const { job, session } = await running();
    const pr = { url: 'https://github.com/o/r/pull/5', number: 5 };
    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr }) });
    const result = await finishJobForAgent({ session, prUrl: pr.url, summary: 'shipped' }, noopBroadcast,
      { findPr: async () => ({ pr }) });
    expect(result.error).toBeUndefined();
    expect(job.state).toBe('review');
    expect(job.resultSummary).toBe('shipped');
  });

  it('refuses a card that has already been filed away as done', async () => {
    const { job, session } = await running({ requiresPr: false });
    job.state = 'done';
    expect((await finishJobForAgent({ session, summary: 'x' }, noopBroadcast)).error).toMatch(/Finished already/);
  });

  it('refuses when the card is deleted or re-branched during the PR lookup', async () => {
    const { job, session } = await running();
    const pr = { url: 'https://github.com/o/r/pull/5', number: 5 };
    const rebranch = async () => { job.branchName = 'bill/other'; return { pr }; };
    expect((await finishJobForAgent({ session, prUrl: pr.url }, noopBroadcast, { findPr: rebranch })).error).toMatch(/moved/);
    expect(job.prNumber).toBeNull();
    const vanish = async () => { config.jobs = []; return { pr }; };
    expect((await finishJobForAgent({ session, prUrl: pr.url }, noopBroadcast, { findPr: vanish })).error).toMatch(/moved/);
    expect(job.prNumber).toBeNull();
  });

  it('sets requiresPr through updateJob, ignoring a non-boolean', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    const job = allJobs()[0];
    updateJob(job.id, { requiresPr: 'no' }, noopBroadcast);
    expect(job.requiresPr).toBe(true);
    updateJob(job.id, { requiresPr: false }, noopBroadcast);
    expect(job.requiresPr).toBe(false);
  });

  it('refuses a non-string summary or pr_url off the wire', async () => {
    const { job, session } = await running({ requiresPr: false });
    expect((await finishJobForAgent({ session, summary: 42 }, noopBroadcast)).error).toMatch(/summary must be a string/);
    expect((await finishJobForAgent({ session, summary: 'x', prUrl: {} }, noopBroadcast)).error).toMatch(/pr_url must be a string/);
    expect(job.state).toBe('in-progress');
  });

  it('refuses a blank pr_url, and a blank summary on a no-PR card', async () => {
    const { session } = await running();
    expect((await finishJobForAgent({ session, prUrl: '   ' }, noopBroadcast, { findPr: async () => { throw new Error('not called'); } })).error)
      .toMatch(/requires a pull request/);
    resetBoard();
    const noPr = await running({ requiresPr: false });
    expect((await finishJobForAgent({ session: noPr.session, summary: '  \n ' }, noopBroadcast)).error).toMatch(/summary/);
  });

  it('passes a PR lookup failure back, leaving the card alone', async () => {
    const { job, session } = await running();
    const result = await finishJobForAgent({ session, prUrl: 'https://github.com/o/r/pull/5' }, noopBroadcast,
      { findPr: async () => ({ error: 'gh is not installed' }) });
    expect(result.error).toMatch(/Could not check the pull request — gh is not installed/);
    expect(job.state).toBe('in-progress');
  });

  it('leaves a card that moved while its PR was being looked up', async () => {
    const { job, session } = await running();
    const result = await finishJobForAgent({ session, prUrl: 'https://github.com/o/r/pull/5' }, noopBroadcast, {
      findPr: async () => { job.state = 'todo'; return { pr: { url: 'https://github.com/o/r/pull/5', number: 5 } }; },
    });
    expect(result.error).toMatch(/moved while its pull request was being checked/);
    expect(job.state).toBe('todo');
    expect(job.prNumber).toBeNull();
  });

  it('keeps an optional summary on a PR job, and clears its old errors', async () => {
    const { job, session } = await running();
    job.lastError = 'stale';
    const notes = [];
    await finishJobForAgent({ session, prUrl: 'https://github.com/O/R/pull/5', summary: 'Assumed UTC.' }, (m) => notes.push(m),
      { findPr: async () => ({ pr: { url: 'https://github.com/o/r/pull/5', number: 5 } }) });
    expect(job.state).toBe('review');
    expect(job.resultSummary).toBe('Assumed UTC.');
    expect(job.lastError).toBeNull();
    expect(notes.some(m => m.type === 'notification' && /PR #5/.test(m.message))).toBe(true);
  });
});

describe('cards that need no pull request', () => {
  beforeEach(resetBoard);

  it('defaults to requiring one on a one-time card and not on a schedule', () => {
    expect(addJob({ title: 'a', repoPath: REPO }, noopBroadcast).job.requiresPr).toBe(true);
    expect(addJob({ title: 'b', repoPath: REPO, requiresPr: false }, noopBroadcast).job.requiresPr).toBe(false);
    expect(jobRequiresPr({ title: 'old' })).toBe(true);
    expect(jobRequiresPr({ requiresPr: false })).toBe(false);
    expect(jobRequiresPr({ type: 'scheduled', schedule: '@daily' })).toBe(false);
    expect(jobRequiresPr({ type: 'scheduled', schedule: '@daily', requiresPr: true })).toBe(true);
  });

  it('skips the PR lookup on a manual move to review', async () => {
    addJob({ title: 'research', repoPath: REPO, requiresPr: false }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    let looked = false;
    await moveJob(job.id, 'review', noopBroadcast, { findPr: async () => { looked = true; return { pr: { url: 'u', number: 1 } }; } });
    expect(looked).toBe(false);
    expect(job.state).toBe('review');
    expect(job.prNumber).toBeNull();
  });

  it('is left alone by the merge sweep, even when its branch merged', async () => {
    addJob({ title: 'research', repoPath: REPO, requiresPr: false }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'review', noopBroadcast);
    const finished = await checkMergedPullRequests(noopBroadcast, {
      findMerged: async () => ({ pr: { url: 'u', number: 1, mergedAt: '2026-08-28T10:00:00Z' } }),
    });
    expect(finished).toEqual([]);
    expect(job.state).toBe('review');
  });

  it('is validated and toggled through the agent door', () => {
    expect(postJobForAgent({ title: 'x', repo: REPO, requiresPr: 'no' }, noopBroadcast).error).toMatch(/requires_pr must be true or false/);
    expect(allJobs()).toHaveLength(0);
    const { job } = postJobForAgent({ title: 'x', repo: REPO, requiresPr: false }, noopBroadcast);
    expect(job.requiresPr).toBe(false);
    expect(editJobForAgent({ id: job.id, requiresPr: 'yes' }, noopBroadcast).error).toMatch(/requires_pr must be true or false/);
    expect(editJobForAgent({ id: job.id, requiresPr: false }, noopBroadcast).error).toMatch(/Nothing to change/);
    expect(editJobForAgent({ id: job.id, requiresPr: true }, noopBroadcast).changed).toEqual(['requires_pr']);
    expect(allJobs()[0].requiresPr).toBe(true);
  });
});

describe('releasing an orphaned worktree on done', () => {
  beforeEach(() => { resetBoard(); orphans.clear(); adoptingOrphans.clear(); });

  async function restartedReviewCard() {
    addJob({ title: 'kept then restarted', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await moveJob(job.id, 'review', noopBroadcast, { findPr: async () => ({ pr: null }) });
    sessions.clear();
    job.agentSessionId = null;
    return job;
  }
  const orphanFor = (job, worktreePath) => ({ id: 'orphan-1', name: 'Viper', repoPath: REPO, branchName: job.branchName, worktreePath });

  it('leaves an orphan that is being re-adopted', async () => {
    const job = await restartedReviewCard();
    job.worktreePath = GONE_WORKTREE;   // the card recorded the worktree the orphan holds
    orphans.set('orphan-1', orphanFor(job, GONE_WORKTREE));
    adoptingOrphans.add('orphan-1');
    await moveJob(job.id, 'done', noopBroadcast);
    expect(job.state).toBe('done');
    expect(orphans.has('orphan-1')).toBe(true);
  });

  it('keeps the orphan when its worktree still holds something', async () => {
    const job = await restartedReviewCard();
    // A directory with no .git is a broken worktree: removeWorktree keeps it.
    const kept = mkdtempSync(join(tmpdir(), 'a007-broken-wt-'));
    orphans.set('orphan-1', orphanFor(job, kept));
    await moveJob(job.id, 'done', noopBroadcast);
    expect(orphans.has('orphan-1')).toBe(true);
    expect(existsSync(kept)).toBe(true);
    rmSync(kept, { recursive: true, force: true });
  });

  it('leaves an orphan on another repo with the same branch name alone', async () => {
    const job = await restartedReviewCard();
    job.worktreePath = GONE_WORKTREE;   // the card recorded the worktree the orphan holds
    orphans.set('orphan-1', { ...orphanFor(job, GONE_WORKTREE), repoPath: REPO2 });
    await moveJob(job.id, 'done', noopBroadcast);
    expect(orphans.has('orphan-1')).toBe(true);
  });

  it('is what the merge sweep falls back to when no agent is left to retire', async () => {
    const job = await restartedReviewCard();
    job.worktreePath = GONE_WORKTREE;   // the card recorded the worktree the orphan holds
    orphans.set('orphan-1', orphanFor(job, GONE_WORKTREE));
    const finished = await checkMergedPullRequests(noopBroadcast, {
      findMerged: async () => ({ pr: { url: 'u', number: 42, mergedAt: '2026-08-28T10:00:00Z' } }),
      killSession: async () => { throw new Error('nothing to kill'); },
    });
    expect(finished).toHaveLength(1);
    expect(job.state).toBe('done');
    expect(orphans.has('orphan-1')).toBe(false);
  });
});

describe('adversarial review regressions', () => {
  beforeEach(resetBoard);

  it('clears the last attempt\'s summary when a card goes back to To do', async () => {
    addJob({ title: 'x', repoPath: REPO, requiresPr: false }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await finishJobForAgent({ session: sessions.get(job.agentSessionId), summary: 'old result' }, noopBroadcast);
    await moveJob(job.id, 'todo', noopBroadcast, { killSession: async (id) => sessions.delete(id) });
    expect(job.resultSummary).toBeNull();
  });

  it('relinks a re-adopted agent over a link to a session that has exited', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    sessions.get(job.agentSessionId).exited = true;   // closed by hand, no restart
    const adopted = { id: 'session-77', name: 'Viper', repoPath: REPO, branchName: job.branchName, exited: false };
    sessions.set(adopted.id, adopted);
    expect(relinkSessionToJob(adopted, noopBroadcast)).toBe(job);
    expect(job.agentSessionId).toBe('session-77');
  });

  it('defaults a schedule to no-PR runs, and keeps an explicit choice', () => {
    expect(addJob({ title: 's', repoPath: REPO, schedule: '@daily' }, noopBroadcast).job.requiresPr).toBe(false);
    expect(addJob({ title: 't', repoPath: REPO, schedule: '@daily', requiresPr: true }, noopBroadcast).job.requiresPr).toBe(true);
  });

  it('holds the orphan against re-adoption only while its worktree is removed', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    sessions.clear();
    job.agentSessionId = null;
    job.worktreePath = GONE_WORKTREE;   // the card recorded the worktree the orphan holds
    orphans.set('orphan-9', { id: 'orphan-9', name: 'Viper', repoPath: REPO, branchName: job.branchName, worktreePath: GONE_WORKTREE });
    await moveJob(job.id, 'done', noopBroadcast);
    expect(orphans.has('orphan-9')).toBe(false);
    expect(adoptingOrphans.has('orphan-9')).toBe(false);
  });
});

describe('red team regressions', () => {
  beforeEach(resetBoard);

  it('treats the PR poll moving the card during finish_job\'s lookup as a success', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    const pr = { url: 'https://github.com/o/r/pull/5', number: 5 };
    const pollerWins = async () => { job.state = 'review'; return { pr }; };
    const result = await finishJobForAgent({ session: sessions.get(job.agentSessionId), prUrl: pr.url, summary: 'done' },
      noopBroadcast, { findPr: pollerWins });
    expect(result.error).toBeUndefined();
    expect(job.resultSummary).toBe('done');
  });

  it('leaves an unlinked session on a Review card\'s branch alone when the PR merges', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr: { url: 'u', number: 5 } }) });
    sessions.clear();
    job.agentSessionId = null;
    sessions.set('mine', { id: 'mine', repoPath: REPO, branchName: job.branchName, exited: false });
    const killed = [];
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async () => ({ pr: { url: 'u', number: 5, mergedAt: '2026-09-24T00:00:00Z' } }),
      killSession: async (id) => killed.push(id),
    });
    expect(job.state).toBe('done');
    expect(killed).toEqual([]);
  });
});

describe('pass 3 regressions', () => {
  beforeEach(resetBoard);

  it('resets requiresPr to the new type\'s default on a type change with no choice made', () => {
    addJob({ title: 'x', repoPath: REPO, schedule: '@daily' }, noopBroadcast);
    const job = allJobs()[0];
    expect(job.requiresPr).toBe(false);
    updateJob(job.id, { type: 'one-time', schedule: '' }, noopBroadcast);
    expect(job.requiresPr).toBe(true);
    updateJob(job.id, { type: 'scheduled', schedule: '@daily', requiresPr: true }, noopBroadcast);
    expect(job.requiresPr).toBe(true);
  });

  it('keeps requiresPr when a save resends the same type, and defaults a card turned schedule to no PR', () => {
    addJob({ title: 'y', repoPath: REPO, schedule: '@daily', requiresPr: true }, noopBroadcast);
    const job = allJobs()[0];
    updateJob(job.id, { title: 'y2', type: 'scheduled', schedule: '@daily' }, noopBroadcast);
    expect(job.requiresPr).toBe(true);
    addJob({ title: 'z', repoPath: REPO }, noopBroadcast);
    const plain = allJobs()[1];
    updateJob(plain.id, { type: 'scheduled', schedule: '@daily' }, noopBroadcast);
    expect(plain.requiresPr).toBe(false);
  });
});

describe('outside review regressions', () => {
  beforeEach(resetBoard);

  it('retires an agent re-adopted during the merge lookup, not the stale one', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    await checkPullRequests(noopBroadcast, { findPr: async () => ({ pr: { url: 'u', number: 5 } }) });
    const killed = [];
    await checkMergedPullRequests(noopBroadcast, {
      findMerged: async () => {
        sessions.set('readopted', { id: 'readopted', repoPath: REPO, branchName: job.branchName, exited: false });
        job.agentSessionId = 'readopted';
        return { pr: { url: 'u', number: 5, mergedAt: '2026-09-24T00:00:00Z' } };
      },
      killSession: async (id) => { killed.push(id); sessions.delete(id); },
    });
    expect(killed).toEqual(['readopted']);
  });
});

describe('red team regressions', () => {
  beforeEach(resetBoard);

  it('leaves another run\'s orphan alone when it merely shares the branch name', async () => {
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    await dispatchOnce(fakeCreateSession([]), noopBroadcast);
    const job = allJobs()[0];
    sessions.clear();
    job.agentSessionId = null;
    orphans.set('theirs', { id: 'theirs', name: 'Other', repoPath: REPO, branchName: job.branchName, worktreePath: GONE_WORKTREE + '-other' });
    await moveJob(job.id, 'done', noopBroadcast);
    expect(orphans.has('theirs')).toBe(true);
  });

  it('restamps reviewAt on a no-PR card returned from In progress, not on a PR card', async () => {
    for (const requiresPr of [false, true]) {
      resetBoard();
      addJob({ title: 'x', repoPath: REPO, requiresPr }, noopBroadcast);
      await dispatchOnce(fakeCreateSession([]), noopBroadcast);
      const job = allJobs()[0];
      await moveJob(job.id, 'review', noopBroadcast, { findPr: async () => ({ pr: null }) });
      job.reviewAt = '2026-01-01T00:00:00.000Z';
      await moveJob(job.id, 'in-progress', noopBroadcast);
      await moveJob(job.id, 'review', noopBroadcast, { findPr: async () => ({ pr: null }) });
      expect(job.reviewAt === '2026-01-01T00:00:00.000Z').toBe(requiresPr);
    }
  });
});
