// A finished card's worker stays finished (Oct 9: Shadow-2, Shadow-6, Shadow-12
// and Echo came back as live agents with no card).
//
//  - Filing a card closes its worker even when the worker's CLI has already
//    exited: left as an exited tab, it stayed in activeSessions and the next
//    restart turned it into an orphan of a card that had moved on.
//  - A worker re-adopted after a restart is retired like any other: the
//    restart clears the card's link and the re-adopt sets it to the new id.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions, orphans, adoptingOrphans } from '../server/state.js';
import {
  addJob, allJobs, boardSettings, dispatchOnce, moveJob, checkPullRequests, checkMergedPullRequests,
  relinkSessionToJob, closeJobForAgent,
} from '../server/jobs.js';
import { removeTempDir } from './temp-dir.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-life-repo-'));
const noop = () => {};
const dirs = [];

function resetBoard() {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  config.activeSessions = [];
  boardSettings();
  sessions.clear();
  orphans.clear();
  adoptingOrphans.clear();
}

// server.js's createSession without the PTY.
function fakeCreateSession() {
  let n = 0;
  return async (command, name, repoPath, branch, ownerId, meta) => {
    n++;
    const session = {
      id: `session-${n}`, name: `Worker${n}`, command, repoPath,
      branchName: `mac-mini/card-${n}`, worktreePath: `/wt/${n}`,
      state: 'WORKING', exited: false, lastOutputAt: Date.now(),
      spawnedBy: meta?.spawnedBy, jobId: meta?.jobId,
    };
    sessions.set(session.id, session);
    return { session };
  };
}

// A dispatched card, its worker live and linked.
let createSession;
async function dispatched(fields = {}) {
  const { job } = addJob({ title: 'lifecycle card', repoPath: REPO, postedByBillion: true, ...fields }, noop);
  await dispatchOnce(createSession, noop);
  return allJobs().find(j => j.id === job.id);
}

const killer = (killed) => async (id) => { killed.push(id); sessions.delete(id); };

let log;
beforeEach(() => {
  resetBoard();
  createSession = fakeCreateSession();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  for (const d of dirs.splice(0)) removeTempDir(d);
});
const logged = () => log.mock.calls.map(c => c.join(' ')).join('\n');

describe('filing a card closes its worker', () => {
  it('closes a worker whose CLI already exited when the card is accepted, and logs it', async () => {
    const job = await dispatched({ requiresPr: false });
    const sid = job.agentSessionId;
    job.state = 'review';
    sessions.get(sid).exited = true;   // crashed, updated, /exit
    const killed = [];
    const result = await closeJobForAgent({ session: { isBillion: true }, id: job.id, accept: true }, noop, { killSession: killer(killed) });
    expect(result.accepted).toBe(true);
    // Before: the exited tab was only unlinked, and lived on in activeSessions.
    expect(killed).toEqual([sid]);
    expect(job.agentSessionId).toBeNull();
    expect(logged()).toMatch(/Worker1: closed, its card "lifecycle card" moved to Finished \(its CLI had already exited\)/);
  });

  it('closes a linked worker whose CLI already exited when the PR merges, and drops the link', async () => {
    const job = await dispatched();
    const sid = job.agentSessionId;
    await checkPullRequests(noop, { findPr: async () => ({ pr: { url: 'https://gh/o/r/pull/7', number: 7 } }) });
    expect(job.state).toBe('review');
    sessions.get(sid).exited = true;
    const killed = [];
    await checkMergedPullRequests(noop, {
      findMerged: async () => ({ pr: { url: 'https://gh/o/r/pull/7', number: 7, mergedAt: new Date().toISOString() } }),
      killSession: killer(killed),
    });
    expect(job.state).toBe('done');
    expect(killed).toEqual([sid]);
    expect(job.agentSessionId).toBeNull();
    expect(logged()).toMatch(/Worker1: closed, its card "lifecycle card" moved to Finished/);
  });

  it('never discards the files of a worker whose CLI exited, even for a scratch run', async () => {
    // supersedeRuns files an old run with discardChanges; a run that crashed
    // may hold work its summary does not, so its dirty worktree stays an orphan.
    const job = await dispatched();
    const sid = job.agentSessionId;
    sessions.get(sid).exited = true;
    const calls = [];
    await moveJob(job.id, 'done', noop, { discardChanges: true, killSession: async (id, opts) => { calls.push([id, opts]); sessions.delete(id); } });
    expect(calls).toEqual([[sid, { discardChanges: false }]]);
  });

  it('leaves a filed card no link to a session that is gone', async () => {
    const job = await dispatched();
    await checkPullRequests(noop, { findPr: async () => ({ pr: { url: 'https://gh/o/r/pull/8', number: 8 } }) });
    sessions.delete(job.agentSessionId);
    await checkMergedPullRequests(noop, {
      findMerged: async () => ({ pr: { url: 'https://gh/o/r/pull/8', number: 8, mergedAt: new Date().toISOString() } }),
      killSession: killer([]),
    });
    expect(job.state).toBe('done');
    expect(job.agentSessionId).toBeNull();
  });

  // The card's first hypothesis: a re-adopted worker gets a new session id
  // while the card keeps the old one, so the retire misses it. It does not:
  // the restart clears every link (loadConfig) and the re-adopt sets the new id.
  it('retires a worker re-adopted after a restart, on merge and on accept', async () => {
    const merged = await dispatched();
    await checkPullRequests(noop, { findPr: async () => ({ pr: { url: 'https://gh/o/r/pull/9', number: 9 } }) });
    const accepted = await dispatched({ title: 'no-PR card', requiresPr: false });
    accepted.state = 'review';
    const before = new Map([merged, accepted].map(job => [job, sessions.get(job.agentSessionId)]));
    sessions.clear();                    // the restart: no session survives it
    for (const [job, old] of before) {
      job.agentSessionId = null;         // loadConfig clears every link
      const readopted = { ...old, id: `readopted-${job.id}`, exited: false };
      sessions.set(readopted.id, readopted);
      expect(relinkSessionToJob(readopted, noop)).toBe(job);
      expect(job.agentSessionId).toBe(readopted.id);
    }
    const killed = [];
    await checkMergedPullRequests(noop, {
      findMerged: async (_r, branch) => ({ pr: branch === merged.branchName ? { url: 'https://gh/o/r/pull/9', number: 9, mergedAt: new Date().toISOString() } : null }),
      killSession: killer(killed),
    });
    await closeJobForAgent({ session: { isBillion: true }, id: accepted.id, accept: true }, noop, { killSession: killer(killed) });
    expect(killed).toEqual([`readopted-${merged.id}`, `readopted-${accepted.id}`]);
    expect([merged.state, accepted.state]).toEqual(['done', 'done']);
  });
});

describe('closing an exited worker: the edges', () => {
  const failing = async () => { throw new Error('worktree busy'); };

  it('closes an exited worker when its card goes back to To do', async () => {
    const job = await dispatched();
    const sid = job.agentSessionId;
    sessions.get(sid).exited = true;
    const killed = [];
    await moveJob(job.id, 'todo', noop, { killSession: killer(killed) });
    expect(job.state).toBe('todo');
    expect(killed).toEqual([sid]);
    expect(job.agentSessionId).toBeNull();
    expect(logged()).toMatch(/Worker1: closed, its card "lifecycle card" moved to .*\(its CLI had already exited\)/);
  });

  it('keeps the link when closing an exited worker fails on a manual move', async () => {
    const job = await dispatched();
    const sid = job.agentSessionId;
    sessions.get(sid).exited = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await moveJob(job.id, 'done', noop, { killSession: failing });
    err.mockRestore();
    expect(job.state).toBe('done');
    expect(job.agentSessionId).toBe(sid);
  });

  it('keeps the link when closing an exited linked worker fails on merge', async () => {
    const job = await dispatched();
    const sid = job.agentSessionId;
    await checkPullRequests(noop, { findPr: async () => ({ pr: { url: 'https://gh/o/r/pull/11', number: 11 } }) });
    sessions.get(sid).exited = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkMergedPullRequests(noop, {
      findMerged: async () => ({ pr: { url: 'https://gh/o/r/pull/11', number: 11, mergedAt: new Date().toISOString() } }),
      killSession: failing,
    });
    err.mockRestore();
    expect(job.state).toBe('done');
    expect(job.agentSessionId).toBe(sid);
  });

  it('does not close an unlinked exited session found by branch, but drops a dead link', async () => {
    // In progress when it merges, so the sweep also looks by branch; an exited
    // session there is not the card's (only a live one is matched by branch).
    const job = await dispatched();
    const old = sessions.get(job.agentSessionId);
    sessions.delete(old.id);   // the linked id is gone
    const stray = { ...old, id: 'stray-exited', exited: true };
    sessions.set(stray.id, stray);
    const killed = [];
    await checkMergedPullRequests(noop, {
      findMerged: async () => ({ pr: { url: 'https://gh/o/r/pull/12', number: 12, mergedAt: new Date().toISOString() } }),
      killSession: killer(killed),
    });
    expect(job.state).toBe('done');
    expect(killed).toEqual([]);
    expect(job.agentSessionId).toBeNull();
    expect(sessions.has(stray.id)).toBe(true);
  });
});
