import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeWorktree, createWorktree } from '../server/git.js';

// Real git against a real bare remote: this logic is entirely about what git
// reports, so a stubbed test would only be testing the stub. These are the
// paths that DELETE things, so the guards matter more than the happy path.
function repoWithRemote() {
  const root = mkdtempSync(join(tmpdir(), 'a007-cleanup-'));
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const repo = join(root, 'repo');
  execFileSync('git', ['clone', '-q', bare, repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'bill10']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  writeFileSync(join(repo, 'README.md'), 'base');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'base']);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main']);
  return { root, repo };
}

function worktreeOn(repo, root, branch, { commit, push, dirty } = {}) {
  const wt = join(root, `wt-${branch.replace(/\//g, '-')}`);
  execFileSync('git', ['-C', repo, 'worktree', 'add', wt, '-b', branch], { stdio: 'ignore' });
  if (commit) {
    writeFileSync(join(wt, 'work.txt'), 'the job output');
    execFileSync('git', ['-C', wt, 'add', '-A']);
    execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'job work']);
  }
  if (push) execFileSync('git', ['-C', wt, 'push', '-q', '-u', 'origin', branch]);
  if (dirty) writeFileSync(join(wt, 'scratch.txt'), 'uncommitted');
  return wt;
}

describe('removeWorktree after a job opens its PR', () => {
  it('releases a clean, fully pushed branch — and leaves the PR alone', async () => {
    // This is the state right after `/ship` opens the PR. Before the upstream
    // check existed, `git log main..branch` reported these commits as
    // "unpushed" (they are simply not MERGED), so every finished job left an
    // orphan behind — the exact worktree the board is trying to release.
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/add-a-thing', { commit: true, push: true });

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/add-a-thing' });

    expect(result.orphaned).toBe(false);
    expect(existsSync(wt)).toBe(false);
    const locals = execFileSync('git', ['-C', repo, 'branch', '--list'], { encoding: 'utf8' });
    expect(locals).not.toContain('bill10/add-a-thing');
    // The pull request lives on the remote branch. Deleting it would close the
    // PR and throw away the work.
    const remotes = execFileSync('git', ['-C', repo, 'ls-remote', '--heads', 'origin'], { encoding: 'utf8' });
    expect(remotes).toContain('refs/heads/bill10/add-a-thing');
  });

  it('keeps a worktree with uncommitted changes', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/dirty', { commit: true, push: true, dirty: true });
    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/dirty' });
    expect(result).toMatchObject({ orphaned: true, reason: 'uncommitted' });
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a branch whose commits never reached the remote', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/local-only', { commit: true, push: false });
    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/local-only' });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a branch that is pushed but has drifted ahead of its upstream', async () => {
    // Fully-pushed means HEAD === @{u}. One extra local commit must not read as
    // "safe to delete" just because an upstream exists.
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/ahead', { commit: true, push: true });
    writeFileSync(join(wt, 'more.txt'), 'later work');
    execFileSync('git', ['-C', wt, 'add', '-A']);
    execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'not pushed yet']);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/ahead' });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt)).toBe(true);
  });

  it('releases a worktree that produced nothing', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/no-op', {});
    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/no-op' });
    expect(result.orphaned).toBe(false);
    expect(existsSync(wt)).toBe(false);
  });
});

describe('branch naming against an open PR', () => {
  it('skips a name whose remote branch still exists', async () => {
    // A finished job deletes its LOCAL branch but leaves the remote one — that
    // IS the open PR. Checking only local refs hands the name straight back
    // out, and the next agent fails non-fast-forward on its first push.
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/fix-flaky-test', { commit: true, push: true });
    await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/fix-flaky-test' });

    const result = await createWorktree(repo, 'Viper', 'fix-flaky-test', { suffixOnCollision: true });
    expect(result.error).toBeUndefined();
    expect(result.branchName).toBe('bill10/fix-flaky-test-2');
  });

  it('still uses the plain name when the remote is clear', async () => {
    const { repo } = repoWithRemote();
    const result = await createWorktree(repo, 'Apex', 'brand-new-job', { suffixOnCollision: true });
    expect(result.branchName).toBe('bill10/brand-new-job');
  });
});
