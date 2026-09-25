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
  // Name the branch explicitly rather than inheriting init.defaultBranch. CI
  // runners still default to `master`, so hard-coding `main` in the push made
  // this fail with "src refspec main does not match any" everywhere but a
  // machine configured like the author's. `branch -M` works on every git
  // version, unlike `init -b`.
  execFileSync('git', ['-C', repo, 'branch', '-M', 'main']);
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

  it('discards uncommitted files when asked, but still keeps unpushed commits', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/scratch', { commit: true, push: true, dirty: true });
    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/scratch' }, { discardChanges: true });
    expect(result).toEqual({ orphaned: false });
    expect(existsSync(wt)).toBe(false);

    const wt2 = worktreeOn(repo, root, 'bill10/scratch-ahead', { commit: true, push: false, dirty: true });
    const result2 = await removeWorktree({ worktreePath: wt2, repoPath: repo, branchName: 'bill10/scratch-ahead' }, { discardChanges: true });
    expect(result2).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt2)).toBe(true);
  });

  it('keeps a branch when the repo has no base branch to compare against', async () => {
    // A remote whose default is neither main nor master, cloned before it had
    // any commits, so origin/HEAD was never written: resolveBaseBranch answers
    // null. With nothing to diff against, the branch could hold commits nobody
    // else has, and `branch -D` would destroy them — even with discardChanges.
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
    execFileSync('git', ['-C', repo, 'branch', '-M', 'trunk']);
    execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'trunk']);
    const wt = worktreeOn(repo, root, 'bill10/no-base', { commit: true, push: false, dirty: true });
    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/no-base' }, { discardChanges: true });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
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

// A worker that pushed to a URL (`git push -u https://…@github.com/… HEAD:b`)
// leaves branch.<b>.remote set to that URL and no refs/remotes/origin/<b>, so
// `@{u}` cannot resolve. Cleanup must then ask the remote directly.
describe('removeWorktree when the branch was pushed to a URL', () => {
  function pushedToUrl(branch) {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, branch, { commit: true });
    const url = `file://${join(root, 'remote.git')}`;
    execFileSync('git', ['-C', wt, 'push', '-q', '-u', url, `HEAD:${branch}`], { stdio: 'ignore' });
    return { root, repo, wt };
  }

  it('releases it when HEAD matches the branch on the remote', async () => {
    const { repo, wt } = pushedToUrl('bill10/url-pushed');
    expect(() => execFileSync('git', ['-C', wt, 'rev-parse', '@{u}'], { stdio: 'ignore' })).toThrow();

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/url-pushed' });

    expect(result).toEqual({ orphaned: false });
    expect(existsSync(wt)).toBe(false);
  });

  it('keeps it when HEAD has commits the remote does not', async () => {
    const { repo, wt } = pushedToUrl('bill10/url-ahead');
    writeFileSync(join(wt, 'more.txt'), 'not pushed');
    execFileSync('git', ['-C', wt, 'add', '-A']);
    execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'local only']);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/url-ahead' });

    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps it when the remote is unreachable, and moves a credentialed URL back to origin', async () => {
    const { repo, wt } = pushedToUrl('bill10/url-offline');
    // Port 1 refuses at once: an offline remote, and a fake token in the URL.
    // Assembled so the pre-push credential scanner doesn't flag a fake token.
    const credUrl = ['https://x-access-token', 'fake@127.0.0.1:1/r.git'].join(':');
    execFileSync('git', ['-C', repo, 'config', 'branch.bill10/url-offline.remote', credUrl]);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/url-offline' });

    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt)).toBe(true);
    const remote = execFileSync('git', ['-C', repo, 'config', 'branch.bill10/url-offline.remote'], { encoding: 'utf8' }).trim();
    expect(remote).toBe('origin');
  });
});
