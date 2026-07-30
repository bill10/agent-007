import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startTreeScanLoop, gitExec, SCAN_INTERVAL_MS } from '../server/git.js';
import { sessions } from '../server/state.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Regression: a `git checkout -b` inside an agent's worktree must be reflected in
// the branch shown in the UI *without* a manual tree refresh. The branch is polled
// on every file-tree scan cycle (DESIGN.md "Branch sync"), so the scan must recur —
// it previously ran only once at spawn, so a new branch was never picked up.
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
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS + 300));
    expect(events.filter(e => e.type === 'branch-changed')).toHaveLength(0);

    // Create a new branch out-of-band, the way an agent would from its terminal.
    await gitExec(['-C', wt, 'checkout', '-q', '-b', 'bill-slung/martini']);

    // A later scan cycle must pick it up — no manual refresh is triggered.
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS + 500));

    const branchEvents = events.filter(e => e.type === 'branch-changed');
    expect(branchEvents.at(-1)).toMatchObject({
      sessionId: session.id, branchName: 'bill-slung/martini',
    });
    expect(session.branchName).toBe('bill-slung/martini');
  }, 15000);
});
