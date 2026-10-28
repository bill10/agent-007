import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions, orphans } from '../server/state.js';
import { dispatchOnce, addJob, updateSettings, boardSettings, allJobs, jobsPayload, postJobForAgent, boardGate, stopDispatcher } from '../server/jobs.js';
import { selectDispatchableJobs, compareDispatchOrder, dispatchPriority, countInFlight, createJob } from '../lib/jobs.js';
import {
  classifyMemory, workerCap, dispatchGate, maxWorkersSetting, freshGuard,
  DEFAULT_MAX_WORKERS, GUARD_STALE_MS,
} from '../lib/memory.js';
import { parseSwapUsage, parseMeminfo, readMemory, memoryStatus, resetMemoryCache, backPressureOn } from '../server/memory.js';
import { checkMemory } from '../server/doctor.js';

// The board-wide worker limit and memory back-pressure: the limit across all
// repos on top of the per-repo one, the order a full board lets cards out in,
// and the memory thresholds that lower the limit, all on mocked readings.

const REPOS = [0, 1, 2].map(i => mkdtempSync(join(tmpdir(), `a007-cap${i}-`)));
const noop = () => {};
const OK = { level: 'ok', reasons: [] };
const PRESSURE = { level: 'pressure', reasons: ['swap 80% full'] };
const CRITICAL = { level: 'critical', reasons: ['6.0 GB disk free'] };
const reading = (r) => () => Promise.resolve(r);

function resetBoard() {
  config.repos = REPOS.map(path => ({ path }));
  config.jobs = [];
  config.jobBoard = null;
  boardSettings().maxPerRepo = 10;
  sessions.clear();
  orphans.clear();
}

function fakeCreateSession(calls = []) {
  let n = 0;
  return async (command, name, repoPath, branch, ownerId, meta) => {
    calls.push(meta.jobId);
    n++;
    const session = { id: `s${n}-${meta.jobId}`, name: `Agent${n}`, repoPath, branchName: `b${n}`, worktreePath: `/wt/${n}`, state: 'WORKING', exited: false, jobId: meta.jobId };
    sessions.set(session.id, session);
    return { session };
  };
}

const post = (title, repo = REPOS[0], extra = {}) => {
  const { job } = addJob({ title, repoPath: repo }, noop);
  Object.assign(job, extra);
  return job;
};
const inProgress = () => allJobs().filter(j => j.state === 'in-progress');

describe('memory thresholds (lib/memory.js)', () => {
  it('swap: over 75% is pressure, over 90% critical', () => {
    expect(classifyMemory({ swapPct: 75 }).level).toBe('ok');
    expect(classifyMemory({ swapPct: 76 }).level).toBe('pressure');
    expect(classifyMemory({ swapPct: 90 }).level).toBe('pressure');
    expect(classifyMemory({ swapPct: 91 })).toEqual({ level: 'critical', reasons: ['swap 91% full'] });
  });

  it('disk: under 15 GB is pressure, under 8 GB critical', () => {
    expect(classifyMemory({ diskFreeGb: 15 }).level).toBe('ok');
    expect(classifyMemory({ diskFreeGb: 14.9 }).level).toBe('pressure');
    expect(classifyMemory({ diskFreeGb: 8 }).level).toBe('pressure');
    expect(classifyMemory({ diskFreeGb: 7.94 })).toEqual({ level: 'critical', reasons: ['7.9 GB disk free'] });
  });

  it("macOS's own pressure level: 2 is pressure, 4 critical", () => {
    expect(classifyMemory({ kernelLevel: 1 }).level).toBe('ok');
    expect(classifyMemory({ kernelLevel: 2 }).level).toBe('pressure');
    expect(classifyMemory({ kernelLevel: 4 }).level).toBe('critical');
  });

  it('the worst reading wins, and every reason is kept', () => {
    expect(classifyMemory({ swapPct: 80, diskFreeGb: 5 })).toEqual({ level: 'critical', reasons: ['swap 80% full', '5 GB disk free'] });
  });

  it('a missing reading counts as fine, so a broken probe never stops the board', () => {
    expect(classifyMemory({})).toEqual(OK);
    expect(classifyMemory({ swapPct: null, diskFreeGb: null, kernelLevel: null })).toEqual(OK);
  });

  it("the guard's level counts while its file is fresh, and not once it is stale", () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const guard = { ts: '2026-10-28T11:58:00Z', level: 'critical', reasons: ['swap 92% > 90%'] };
    expect(classifyMemory({ guard }, now)).toEqual({ level: 'critical', reasons: ['mac-mini-guard: swap 92% > 90%'] });
    expect(freshGuard({ ...guard, ts: new Date(now - GUARD_STALE_MS - 1).toISOString() }, now)).toBeNull();
    expect(classifyMemory({ guard: { ...guard, ts: '2026-10-28T10:00:00Z' } }, now).level).toBe('ok');
    expect(freshGuard({ ...guard, level: 'weird' }, now)).toBeNull();
    // Our own reading already said it: the guard's words are not repeated.
    expect(classifyMemory({ swapPct: 80, guard: { ...guard, level: 'pressure' } }, now).reasons).toEqual(['swap 80% full']);
  });

  it('the limit: maxWorkers when ok, two fewer under pressure (never below one), none when critical', () => {
    expect(workerCap(5, 'ok')).toBe(5);
    expect(workerCap(5, 'pressure')).toBe(3);
    expect(workerCap(2, 'pressure')).toBe(1);
    expect(workerCap(5, 'critical')).toBe(0);
  });

  it('maxWorkers defaults to 5 and a hand-edited value is clamped', () => {
    expect(maxWorkersSetting({})).toBe(DEFAULT_MAX_WORKERS);
    expect(DEFAULT_MAX_WORKERS).toBe(5);
    expect(maxWorkersSetting({ maxWorkers: null })).toBe(5);
    expect(maxWorkersSetting({ maxWorkers: 'lots' })).toBe(5);
    expect(maxWorkersSetting({ maxWorkers: 0 })).toBe(1);
    expect(maxWorkersSetting({ maxWorkers: 99 })).toBe(20);
    expect(maxWorkersSetting({ maxWorkers: 3.7 })).toBe(3);
  });

  it('says why nothing starts: memory low, memory pressure, or the limit', () => {
    expect(dispatchGate({ maxWorkers: 5, running: 2, memory: OK })).toMatchObject({ cap: 5, room: 3, reason: null, memoryHeld: false });
    const critical = dispatchGate({ maxWorkers: 5, running: 1, memory: CRITICAL });
    expect(critical).toMatchObject({ cap: 0, room: 0, memoryHeld: true });
    expect(critical.reason).toMatch(/^Waiting: Mac memory is low \(6\.0 GB disk free\)\. .*running ones continue/);
    const pressure = dispatchGate({ maxWorkers: 5, running: 3, memory: PRESSURE });
    expect(pressure).toMatchObject({ cap: 3, room: 0, memoryHeld: true });
    expect(pressure.reason).toMatch(/memory is under pressure \(swap 80% full\), so the board runs at most 3 of its 5/);
    expect(dispatchGate({ maxWorkers: 5, running: 2, memory: PRESSURE })).toMatchObject({ room: 1, reason: null });
    const full = dispatchGate({ maxWorkers: 5, running: 5, memory: OK });
    expect(full).toMatchObject({ room: 0, memoryHeld: false });
    expect(full.reason).toBe("Waiting: 5 of 5 workers running, the board's limit across all repos.");
  });
});

describe('reading the machine (server/memory.js), with mocked probes', () => {
  beforeEach(() => resetMemoryCache());

  it("parses macOS's vm.swapusage and Linux's /proc/meminfo", () => {
    expect(parseSwapUsage('total = 6144.00M  used = 5734.40M  free = 409.60M  (encrypted)'))
      .toEqual({ swapTotalMb: 6144, swapUsedMb: 5734, swapPct: expect.closeTo(93.3, 1) });
    expect(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M').swapPct).toBe(0);
    expect(parseSwapUsage('garbage')).toBeNull();
    expect(parseMeminfo('MemTotal: 1 kB\nSwapTotal:  2097152 kB\nSwapFree:   524288 kB\n'))
      .toEqual({ swapTotalMb: 2048, swapUsedMb: 1536, swapPct: 75 });
  });

  const now = Date.parse('2026-10-28T18:30:00Z');
  const mac = (over = {}) => ({
    platform: 'darwin',
    sysctl: async () => 'total = 8192.00M  used = 7700.00M  free = 492.00M  (encrypted)\n1\n',
    meminfo: () => null,
    diskFreeGb: () => 20,
    guard: () => null,
    ...over,
  });

  it('reads swap, the kernel level and disk, and classifies them', async () => {
    const m = await readMemory(mac(), now);
    expect(m).toMatchObject({ swapUsedMb: 7700, swapTotalMb: 8192, kernelLevel: 1, diskFreeGb: 20, level: 'critical' });
    expect(m.reasons).toEqual(['swap 94% full']);
  });

  it("takes the guard's disk figure over statfs while the guard is fresh", async () => {
    const guard = { ts: '2026-10-28T11:28:00-07:00', level: 'pressure', reasons: ['disk 11.2 GB < 15 GB'], after: { disk_free_gb: 11.2 } };
    const m = await readMemory(mac({ sysctl: async () => 'total = 6144.00M  used = 4000.00M\n1', diskFreeGb: () => 7.7, guard: () => guard }), now);
    expect(m.diskFreeGb).toBe(11.2);
    expect(m.level).toBe('pressure');
    expect(m.guard).toMatchObject({ level: 'pressure' });
  });

  it('a probe that throws or a platform with none leaves its reading null, and the level ok', async () => {
    const m = await readMemory(mac({ sysctl: async () => { throw new Error('no sysctl'); }, diskFreeGb: () => { throw new Error('x'); } }), now);
    expect(m).toMatchObject({ swapPct: null, diskFreeGb: null, level: 'ok' });
    expect((await readMemory({ ...mac(), platform: 'win32', diskFreeGb: () => null }, now)).level).toBe('ok');
  });

  it('caches a reading for a while, and MEMORY_BACK_PRESSURE=0 turns it off', async () => {
    let reads = 0;
    const probes = mac({ sysctl: async () => { reads++; return 'total = 100.00M  used = 10.00M\n1'; } });
    await memoryStatus({ env: {}, probes, now });
    await memoryStatus({ env: {}, probes, now: now + 1000 });
    expect(reads).toBe(1);
    await memoryStatus({ env: {}, probes, now: now + 60_000 });
    expect(reads).toBe(2);
    expect(await memoryStatus({ env: { MEMORY_BACK_PRESSURE: '0' }, probes, now: now + 120_000 })).toMatchObject({ level: 'ok', off: true });
    expect(reads).toBe(2);
    expect(backPressureOn({})).toBe(true);
    expect(backPressureOn({ MEMORY_BACK_PRESSURE: 'off' })).toBe(false);
  });
});

describe('queue order', () => {
  const card = (id, postedAt, extra = {}) => ({ id, postedAt, state: 'todo', repoPath: '/r', ...extra });

  it("Billion's urgent cards and schedule runs first, then oldest first", () => {
    const jobs = [
      card('old', '2026-10-28T08:00:00Z'),
      card('newer', '2026-10-28T09:00:00Z'),
      card('run', '2026-10-28T10:00:00Z', { scheduleId: 'sched' }),
      card('urgent', '2026-10-28T11:00:00Z', { urgent: true, postedByBillion: true }),
      // Only Billion's cards may jump the queue.
      card('loud', '2026-10-28T07:00:00Z', { urgent: true, postedByBillion: false }),
    ];
    expect([...jobs].sort(compareDispatchOrder).map(j => j.id)).toEqual(['run', 'urgent', 'loud', 'old', 'newer']);
    expect(dispatchPriority(jobs[2])).toBe(0);
    expect(dispatchPriority(jobs[4])).toBe(1);
  });

  it('a full board lets only the front of the queue out, across repos', () => {
    const jobs = [
      card('a', '1', { repoPath: '/a' }), card('b', '2', { repoPath: '/b' }),
      card('run', '3', { repoPath: '/c', scheduleId: 's' }), card('c', '4', { repoPath: '/c' }),
    ];
    expect(selectDispatchableJobs(jobs, { maxPerRepo: 2, maxWorkers: 2 }).map(j => j.id)).toEqual(['run', 'a']);
    // Running workers count against it, whichever repo they are in.
    const running = [...jobs, { id: 'x', state: 'in-progress', repoPath: '/z', agentSessionId: 'live' }];
    expect(countInFlight(running, new Set(['live']))).toBe(1);
    expect(selectDispatchableJobs(running, { maxPerRepo: 2, maxWorkers: 2, liveSessionIds: new Set(['live']) }).map(j => j.id)).toEqual(['run']);
  });

  it('urgent is stored only on a card Billion posts', () => {
    expect(createJob({ title: 't', repoPath: '/r', urgent: true, postedByBillion: true }).job.urgent).toBe(true);
    expect(createJob({ title: 't', repoPath: '/r', urgent: true }).job.urgent).toBe(false);
  });
});

describe('dispatch with the board-wide limit and memory back-pressure', () => {
  beforeEach(resetBoard);
  afterEach(() => stopDispatcher());

  it('starts at most maxWorkers across all repos (5 by default)', async () => {
    for (const repo of REPOS) for (let i = 0; i < 3; i++) post(`${repo}-${i}`, repo);
    await dispatchOnce(fakeCreateSession(), noop, { memory: reading(OK) });
    expect(inProgress()).toHaveLength(5);
    // A second pass with no room starts nothing.
    await dispatchOnce(fakeCreateSession(), noop, { memory: reading(OK) });
    expect(inProgress()).toHaveLength(5);
    expect(boardGate(OK)).toMatchObject({ running: 5, cap: 5, room: 0 });
    expect(boardGate(OK).reason).toMatch(/5 of 5 workers running/);
  });

  it('keeps the per-repo limit on top of it', async () => {
    updateSettings({ maxPerRepo: 1, maxWorkers: 5 }, noop);
    for (const repo of REPOS) for (let i = 0; i < 3; i++) post(`${repo}-${i}`, repo);
    await dispatchOnce(fakeCreateSession(), noop, { memory: reading(OK) });
    expect(inProgress()).toHaveLength(3);
  });

  it("does not count Billion's own session", async () => {
    sessions.set('billion', { id: 'billion', name: 'Billion', isBillion: true, exited: false, state: 'WORKING' });
    updateSettings({ maxWorkers: 2 }, noop);
    post('one'); post('two'); post('three');
    await dispatchOnce(fakeCreateSession(), noop, { memory: reading(OK) });
    expect(inProgress()).toHaveLength(2);
  });

  it('under pressure runs maxWorkers - 2', async () => {
    for (let i = 0; i < 6; i++) post(`J${i}`, REPOS[i % 3]);
    await dispatchOnce(fakeCreateSession(), noop, { memory: reading(PRESSURE) });
    expect(inProgress()).toHaveLength(3);
    const waiting = allJobs().filter(j => j.state === 'todo');
    expect(waiting.every(j => j.delayedByMemoryAt)).toBe(true);
    expect(jobsPayload().settings.gate).toBeTruthy();
  });

  it('when critical starts nothing, marks the cards, and the running ones continue', async () => {
    updateSettings({ maxWorkers: 5 }, noop);
    const running = post('already running');
    await dispatchOnce(fakeCreateSession(), noop, { memory: reading(OK) });
    expect(running.state).toBe('in-progress');
    const run = post('nightly run', REPOS[1], { scheduleId: 'sched-1' });
    const plain = post('plain card', REPOS[2]);
    const calls = [];
    await dispatchOnce(fakeCreateSession(calls), noop, { memory: reading(CRITICAL) });
    expect(calls).toEqual([]);
    expect(running.state).toBe('in-progress');
    expect(sessions.get(running.agentSessionId).exited).toBe(false);
    // Delayed, not skipped: still in To do, marked, and in its place.
    expect(run.state).toBe('todo');
    expect(run.delayedByMemoryAt).toEqual(expect.any(String));
    expect(plain.delayedByMemoryAt).toEqual(expect.any(String));
    expect(boardGate(CRITICAL).reason).toMatch(/^Waiting: Mac memory is low/);

    // Memory recovers: the delayed schedule run goes first, and the mark is cleared.
    updateSettings({ maxWorkers: 2 }, noop);
    await dispatchOnce(fakeCreateSession(calls), noop, { memory: reading(OK) });
    expect(calls).toEqual([run.id]);
    expect(run.state).toBe('in-progress');
    expect(run.delayedByMemoryAt).toBeNull();
    expect(plain.state).toBe('todo');
    expect(plain.delayedByMemoryAt).toBeNull();
  });

  it('a held pass looks again after a minute instead of waiting for the next scan', async () => {
    vi.useFakeTimers();
    try {
      post('waits');
      await dispatchOnce(fakeCreateSession(), noop, { memory: reading(CRITICAL) });
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    } finally {
      stopDispatcher();
      vi.useRealTimers();
    }
  });

  it("puts Billion's urgent card ahead of older ones when the board is nearly full", async () => {
    updateSettings({ maxWorkers: 1 }, noop);
    post('older');
    const urgent = postJobForAgent({ title: 'urgent', repo: REPOS[1], urgent: true, session: { name: 'Billion', isBillion: true, command: 'claude' } }, noop).job;
    await dispatchOnce(fakeCreateSession(), noop, { memory: reading(OK) });
    expect(inProgress().map(j => j.id)).toEqual([urgent.id]);
    expect(postJobForAgent({ title: 'x', repo: REPOS[0], urgent: 'yes' }, noop).error).toMatch(/urgent must be true or false/);
  });

  it('updateSettings clamps maxWorkers, and the payload carries the gate', () => {
    expect(updateSettings({ maxWorkers: 50 }, noop).settings.maxWorkers).toBe(20);
    expect(updateSettings({ maxWorkers: 0 }, noop).settings.maxWorkers).toBe(1);
    updateSettings({ maxWorkers: 5 }, noop);
    expect(jobsPayload().settings.gate).toMatchObject({ maxWorkers: 5, cap: 5, running: 0 });
  });
});

describe('agent007 doctor: memory and the worker limit', () => {
  const probes = (memory, serverStatus = async () => null, env = {}) => ({ env, memory: async () => memory, serverStatus });

  it("shows the running server's limit, running count and reason", async () => {
    const lines = await checkMemory(probes(
      { level: 'pressure', reasons: ['swap 80% full'], swapPct: 80, swapTotalMb: 6144, diskFreeGb: 20 },
      async () => ({ dispatch: { maxWorkers: 5, cap: 3, running: 3, maxPerRepo: 2, boardRunning: true, reason: 'Waiting: Mac memory is under pressure' } }),
    ), { jobBoard: {} });
    expect(lines.map(l => l.status)).toEqual(['ok', 'ok', 'na']);
    expect(lines[0].text).toMatch(/memory under pressure \(swap 80% full\)/);
    expect(lines[1].text).toBe('board workers: 3 running, limit 3 (lowered from 5 for memory) across all repos, 2 per repo');
    expect(lines[2].text).toMatch(/^Waiting: Mac memory/);
  });

  it('fails when memory is critical, and reads the limit from config.json without a server', async () => {
    const lines = await checkMemory(probes({ level: 'critical', reasons: ['6.0 GB disk free'], diskFreeGb: 6 }), { jobBoard: { maxWorkers: 4 } });
    expect(lines[0].status).toBe('fail');
    expect(lines[0].text).toMatch(/memory critical: 6\.0 GB disk free; the board starts no new workers/);
    expect(lines[1].text).toBe('board worker limit: 4 across all repos (0 at this memory level); Agent 007 is not running');
    const older = await checkMemory(probes({ level: 'ok', reasons: [] }, async () => ({ pid: 1 })), { jobBoard: {} });
    expect(older[1].text).toMatch(/older than this check; restart it/);
  });

  it('says ok with the readings when memory is fine, and nothing without a probe', async () => {
    const [line] = await checkMemory(probes({ level: 'ok', reasons: [], swapPct: 20, swapTotalMb: 2048, diskFreeGb: 100 }), { jobBoard: {} });
    expect(line.text).toBe('memory ok: swap 20% of 2.0 GB, 100.0 GB disk free');
    expect(await checkMemory({}, {})).toEqual([]);
  });
});
