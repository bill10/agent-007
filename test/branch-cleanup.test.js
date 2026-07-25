import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deleteBranch, gitExec } from '../server/git.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Regression: an agent's branch must be deletable even when its worktree dir was
// removed out-of-band but git still registers it ("prunable"). Without pruning
// first, `git branch -D` refuses ("checked out at <gone path>") and the branch
// leaks until every cocktail name is taken.
describe('deleteBranch prunes stale worktrees before deleting', () => {
  let repo, base;
  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'a007-branch-'));
    repo = join(base, 'repo');
    await gitExec(['init', '-q', repo]);
    await gitExec(['-C', repo, 'config', 'user.name', 'bill-slung']);
    await gitExec(['-C', repo, 'config', 'user.email', 't@t.com']);
    await gitExec(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
    await gitExec(['-C', repo, 'branch', '-M', 'main']);
  });
  afterEach(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const branches = async () =>
    (await gitExec(['-C', repo, 'branch', '--list', 'bill-slung/*'])).trim();

  it('deletes a branch whose worktree dir was removed out-of-band', async () => {
    const wt = join(base, 'wt');
    await gitExec(['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'bill-slung/negroni']);
    await gitExec(['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'work']);
    rmSync(wt, { recursive: true, force: true }); // dir gone, git still registers it

    await deleteBranch(repo, 'bill-slung/negroni');
    expect(await branches()).toBe(''); // gone, not leaked
  });

  it('deletes a normal branch after its worktree was removed', async () => {
    const wt = join(base, 'wt2');
    await gitExec(['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'bill-slung/martini']);
    await gitExec(['-C', repo, 'worktree', 'remove', wt]);
    await deleteBranch(repo, 'bill-slung/martini');
    expect(await branches()).toBe('');
  });

  it('is a no-op for a missing repo or branch (no throw)', async () => {
    await expect(deleteBranch(null, 'x')).resolves.toBeUndefined();
    await expect(deleteBranch(repo, null)).resolves.toBeUndefined();
  });
});
