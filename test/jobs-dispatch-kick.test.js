import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { addJob, moveJob, boardSettings, allJobs, startDispatcher, stopDispatcher, DISPATCH_DEBOUNCE_MS } from '../server/jobs.js';

// A card posted, requeued or let through by a freed slot goes out within the
// debounce window, not on the next 5-minute scan.
const REPO = mkdtempSync(join(tmpdir(), 'a007-kickrepo-'));
const noop = () => {};

function fakeCreateSession(calls, { gate } = {}) {
  let n = 0;
  return async (command, name, repoPath, branch, ownerId, meta) => {
    calls.push(meta.jobId);
    if (gate) await gate;
    n++;
    const session = { id: `s${n}`, name: `Agent${n}`, branchName: `b${n}`, worktreePath: `/wt/${n}`, state: 'WORKING', exited: false, jobId: meta.jobId };
    sessions.set(session.id, session);
    return { session };
  };
}

const post = (title) => addJob({ title, repoPath: REPO }, noop).job;

async function start(createSession, { running = true, maxPerRepo = 3 } = {}) {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  sessions.clear();
  boardSettings().maxPerRepo = maxPerRepo;
  startDispatcher(createSession, noop);
  // Let the start-up tick go by on a stopped board, so the scan (and its
  // GitHub sweeps) stays out of these tests for the next interval.
  await vi.advanceTimersByTimeAsync(2500);
  boardSettings().running = running;
}

describe('dispatch on events', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { stopDispatcher(); vi.useRealTimers(); });

  it('dispatches a card posted with room within the debounce window', async () => {
    const calls = [];
    await start(fakeCreateSession(calls));
    const job = post('Now please');
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS - 100);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([job.id]);
    expect(job.state).toBe('in-progress');
  });

  it('leaves a card queued when its repo is at the cap, and sends it when a slot frees', async () => {
    const calls = [];
    await start(fakeCreateSession(calls), { maxPerRepo: 1 });
    const first = post('First');
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS + 100);
    const second = post('Second');
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS + 100);
    expect(calls).toEqual([first.id]);
    expect(second.state).toBe('todo');

    await moveJob(first.id, 'review', noop, { findPr: async () => ({ pr: null }) });
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS + 100);
    expect(calls).toEqual([first.id, second.id]);
    expect(second.state).toBe('in-progress');
  });

  it('dispatches a card moved back to To do', async () => {
    const calls = [];
    await start(fakeCreateSession(calls));
    const job = post('Again');
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS + 100);
    await moveJob(job.id, 'todo', noop);
    expect(job.state).toBe('todo');
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS + 100);
    expect(calls).toEqual([job.id, job.id]);
    expect(job.state).toBe('in-progress');
  });

  it('coalesces a burst of posts into one pass', async () => {
    const calls = [];
    await start(fakeCreateSession(calls));
    const a = post('A');
    await vi.advanceTimersByTimeAsync(800);
    const b = post('B');
    await vi.advanceTimersByTimeAsync(800);
    const c = post('C');
    // One timer, armed by the first post: all three go on it.
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS - 1600 + 50);
    expect(calls).toEqual([a.id, b.id, c.id]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
  });

  it('does nothing while the board is stopped', async () => {
    const calls = [];
    await start(fakeCreateSession(calls), { running: false });
    const job = post('Held');
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS * 3);
    expect(calls).toEqual([]);
    expect(job.state).toBe('todo');
  });

  it('never runs two passes at once, and retries once the first is done', async () => {
    const calls = [];
    let release;
    const gate = new Promise(r => { release = r; });
    await start(fakeCreateSession(calls, { gate }));
    const a = post('A');
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS + 100);
    expect(calls).toEqual([a.id]);   // held inside createSession
    const b = post('B');
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS * 3);
    expect(calls).toEqual([a.id]);   // no second pass while the first runs
    release();
    await vi.advanceTimersByTimeAsync(DISPATCH_DEBOUNCE_MS + 100);
    expect(calls).toEqual([a.id, b.id]);
    expect(allJobs().map(j => j.state)).toEqual(['in-progress', 'in-progress']);
  });
});
