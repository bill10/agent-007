import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startTreeScanLoop, gitExec, SCAN_INTERVAL_MS } from '../server/git.js';
import { sessions } from '../server/state.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Regression: a `git checkout -b` inside an agent's worktree must be reflected in
// the branch shown in the UI *without* a manual tree refresh. The branch is polled
// on every file-tree scan cycle (DESIGN.md "Branch sync"), so the scan must recur —
// it previously ran only once at spawn, so a new branch was never picked up.
//
// The scan loop has an idle gate: it only scans on cycles where the PTY produced
// new output (session.lastOutputAt advanced) since the last scan, so idle sessions
// cost zero git calls. Terminal activity is simulated here by bumping lastOutputAt.
//
// Waits are on observed events, not fixed sleeps: git is slow on Windows runners,
// and the next tick is only scheduled SCAN_INTERVAL_MS after the previous scan
// *finishes*, so a fixed sleep can end before the scan it was waiting for.
const WAIT = { timeout: 10000, interval: 50 };
// The first scan always ends by broadcasting conflicts-update (lastTreeHash starts null).
const firstScanDone = (events) => vi.waitFor(() => {
  if (!events.some(e => e.type === 'conflicts-update')) throw new Error('first scan still running');
}, WAIT);
describe('branch sync polls on the recurring scan loop', () => {
  let base, repo, wt, session;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'a007-bsync-'));
    repo = join(base, 'repo');
    await gitExec(['init', '-q', repo]);
    await gitExec(['-C', repo, 'config', 'user.name', 'bill-slung']);
    await gitExec(['-C', repo, 'config', 'user.email', 't@t.com']);
    await gitExec(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
    await gitExec(['-C', repo, 'branch', '-M', 'main']);
    wt = join(base, 'wt');
    await gitExec(['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'bill-slung/negroni']);

    session = {
      id: 'sess-bsync', repoPath: repo, worktreePath: wt,
      branchName: 'bill-slung/negroni', lastTreeHash: null, exited: false, scanTimer: null,
      lastOutputAt: 0, scannedOnce: false, lastScanOutputAt: null,
    };
    sessions.set(session.id, session);
  });

  afterEach(() => {
    session.exited = true;
    clearTimeout(session.scanTimer);
    sessions.delete(session.id);
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });

  it('emits branch-changed and updates session.branchName after a checkout -b', async () => {
    const events = [];
    startTreeScanLoop(session, (msg) => events.push(msg));

    // Let the first scan cycle run *before* the branch changes, so only a
    // *recurring* loop can catch what follows — a one-shot scan would have
    // already fired against the original branch and never run again.
    await firstScanDone(events);
    expect(events.filter(e => e.type === 'branch-changed')).toHaveLength(0);

    // Create a new branch the way an agent would from its terminal — the command
    // prints to the PTY, so simulate that output bump so the idle gate opens.
    await gitExec(['-C', wt, 'checkout', '-q', '-b', 'bill-slung/martini']);
    session.lastOutputAt = Date.now();

    // A later scan cycle must pick it up — no manual refresh is triggered.
    await vi.waitFor(() => {
      expect(events.filter(e => e.type === 'branch-changed').at(-1)).toMatchObject({
        sessionId: session.id, branchName: 'bill-slung/martini',
      });
    }, WAIT);
    expect(session.branchName).toBe('bill-slung/martini');
  }, 20000);

  it('idle gate: skips the git scan while the terminal is idle, resumes on activity', async () => {
    const events = [];
    startTreeScanLoop(session, (msg) => events.push(msg));

    // First cycle scans unconditionally (sees negroni, no change event).
    await firstScanDone(events);
    expect(events.filter(e => e.type === 'branch-changed')).toHaveLength(0);

    // Change the branch WITHOUT any terminal output (lastOutputAt stays put).
    // The gate must skip these cycles, so the change is NOT observed yet.
    await gitExec(['-C', wt, 'checkout', '-q', '-b', 'bill-slung/martini']);
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS * 2 + 300));
    expect(events.filter(e => e.type === 'branch-changed')).toHaveLength(0);
    expect(session.branchName).toBe('bill-slung/negroni');

    // Now simulate terminal activity — the very next cycle scans and catches up.
    session.lastOutputAt = Date.now();
    await vi.waitFor(() => {
      expect(events.filter(e => e.type === 'branch-changed').at(-1)).toMatchObject({
        branchName: 'bill-slung/martini',
      });
    }, WAIT);
    expect(session.branchName).toBe('bill-slung/martini');
  }, 25000);
});
