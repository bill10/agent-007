import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeWorktree, createWorktree, discardWorktree, pruneWorktrees, scanForOrphanedWorktrees, commitsNotInBase } from '../server/git.js';
import { orphans } from '../server/state.js';

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

function worktreeOn(repo, root, branch, { commit, push, dirty, from } = {}) {
  const wt = join(root, `wt-${branch.replace(/\//g, '-')}`);
  execFileSync('git', ['-C', repo, 'worktree', 'add', wt, '-b', branch, ...(from ? [from] : [])], { stdio: 'ignore' });
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

// A second clone of the same remote: the person (or GitHub's merge button)
// moving main on while this machine's checkout sits still.
function elsewhere(root) {
  const other = join(root, `other-${readdirSync(root).length}`);
  execFileSync('git', ['clone', '-q', join(root, 'remote.git'), other], { stdio: 'ignore' });
  execFileSync('git', ['-C', other, 'config', 'user.name', 'someone']);
  execFileSync('git', ['-C', other, 'config', 'user.email', 's@s']);
  return other;
}
function commitFile(dir, file, text, message) {
  writeFileSync(join(dir, file), text);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message]);
}
// What a squash-merged PR leaves: the branch's change as one new commit on
// main, and the remote branch deleted (its tracking ref gone with it).
function squashMerge(repo, root, branch) {
  const other = elsewhere(root);
  execFileSync('git', ['-C', other, 'merge', '-q', '--squash', `origin/${branch}`], { stdio: 'ignore' });
  execFileSync('git', ['-C', other, 'commit', '-q', '-m', `squash of ${branch} (#1)`]);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', '--delete', branch]);
  return other;
}

describe('removeWorktree once the work is on main', () => {
  it('releases a squash-merged branch whose remote branch was deleted', async () => {
    // Every finished card ended here: the PR squash-merged, so none of the
    // branch's own commits is on main, and with the remote branch gone nothing
    // matched upstream either. Its content is on main all the same.
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/squashed', { push: true });
    commitFile(wt, 'a.txt', 'one', 'first');
    commitFile(wt, 'b.txt', 'two', 'second');
    execFileSync('git', ['-C', wt, 'push', '-q']);
    squashMerge(repo, root, 'bill10/squashed');

    // This machine has not fetched since: the check fetches origin/main itself.
    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/squashed' });
    expect(result).toEqual({ orphaned: false });
    expect(existsSync(wt)).toBe(false);
    expect(execFileSync('git', ['-C', repo, 'branch', '--list'], { encoding: 'utf8' })).not.toContain('bill10/squashed');
  });

  it('releases a squash-merged branch after main has built on the same file', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/built-on', { push: true });
    commitFile(wt, 'notes.txt', 'line 1\n', 'first');
    commitFile(wt, 'notes.txt', 'line 1\nline 2\n', 'second');
    execFileSync('git', ['-C', wt, 'push', '-q']);
    const other = squashMerge(repo, root, 'bill10/built-on');
    commitFile(other, 'notes.txt', 'line 0\nline 1\nline 2\n', 'later on main');
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/built-on' });
    expect(result).toEqual({ orphaned: false });
    expect(existsSync(wt)).toBe(false);
  });

  it('releases a branch whose commits reached main rebased', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/rebased', { commit: true });
    const other = elsewhere(root);
    commitFile(other, 'unrelated.txt', 'x', 'someone else first');
    const sha = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', other, 'fetch', '-q', repo, 'bill10/rebased']);
    execFileSync('git', ['-C', other, 'cherry-pick', sha], { stdio: 'ignore' });
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/rebased' });
    expect(result).toEqual({ orphaned: false });
    expect(existsSync(wt)).toBe(false);
  });

  it('releases a run with no upstream and nothing beyond origin/main, though local main is behind', async () => {
    // The hourly runs: branched from origin/main, no commits, no PR. Counted
    // against the stale local main, origin's newer commits read as the run's.
    const { root, repo } = repoWithRemote();
    const other = elsewhere(root);
    commitFile(other, 'newer.txt', 'x', 'main moves on');
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
    const wt = worktreeOn(repo, root, 'bill10/hourly', { from: 'origin/main' });
    execFileSync('git', ['-C', repo, 'branch', '--unset-upstream', 'bill10/hourly'], { stdio: 'ignore' });

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/hourly' });
    expect(result).toEqual({ orphaned: false });
    expect(existsSync(wt)).toBe(false);
  });

  it('keeps a commit main does not have, even when local main is behind', async () => {
    const { root, repo } = repoWithRemote();
    const other = elsewhere(root);
    commitFile(other, 'newer.txt', 'x', 'main moves on');
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
    const wt = worktreeOn(repo, root, 'bill10/real-work', { from: 'origin/main', commit: true });

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/real-work' });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a squash-merged branch with uncommitted files', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/merged-dirty', { commit: true, push: true });
    squashMerge(repo, root, 'bill10/merged-dirty');
    writeFileSync(join(wt, 'scratch.txt'), 'not committed');

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/merged-dirty' });
    expect(result).toMatchObject({ orphaned: true, reason: 'uncommitted' });
    expect(existsSync(wt)).toBe(true);
  });
});

describe('removeWorktree never mistakes different work for merged work', () => {
  it('keeps a branch whose edit differs from main\'s only in whitespace', async () => {
    // A patch-id ignores whitespace, so "hello world" and "helloworld" made
    // from the same line match by patch-id. The files are not the same.
    const { root, repo } = repoWithRemote();
    commitFile(repo, 'msg.txt', 'message = "old"\n', 'msg');
    execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main']);
    const wt = worktreeOn(repo, root, 'bill10/spaced', {});
    commitFile(wt, 'msg.txt', 'message = "hello world"\n', 'branch edit');
    const other = elsewhere(root);
    commitFile(other, 'msg.txt', 'message = "helloworld"\n', 'main edit');
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/spaced' });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a branch even when a repo merge driver would drop its change', async () => {
    // A trial merge runs the repo's merge drivers; `merge=ours` keeps main's
    // side and would make the merge look like main. No merge is tried.
    const { root, repo } = repoWithRemote();
    commitFile(repo, '.gitattributes', 'config.json merge=ours\n', 'attrs');
    commitFile(repo, 'config.json', '{"a":1}\n', 'config');
    execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main']);
    execFileSync('git', ['-C', repo, 'config', 'merge.ours.driver', 'true']);
    const wt = worktreeOn(repo, root, 'bill10/driver', {});
    commitFile(wt, 'config.json', '{"a":2}\n', 'branch edit');
    const other = elsewhere(root);
    commitFile(other, 'config.json', '{"a":3}\n', 'main edit');
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/driver' });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
  });

  it('keeps a squash-merged branch once the remote main no longer has the squash', async () => {
    // This machine fetched the squash, then main was force-reset past it. The
    // cached origin/main must not clear the branch: it is fetched first.
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/reset', { commit: true, push: true });
    const other = squashMerge(repo, root, 'bill10/reset');
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
    execFileSync('git', ['-C', other, 'push', '-q', '-f', 'origin', 'HEAD~1:main']);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/reset' });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
  });

  it('keeps commits made on a detached HEAD in the worktree', async () => {
    // The branch is still at main, but the worktree's HEAD, the thing removal
    // throws away, holds a commit nothing else reaches.
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/detached', { from: 'origin/main' });
    execFileSync('git', ['-C', wt, 'checkout', '-q', '--detach']);
    commitFile(wt, 'precious.txt', 'only here', 'detached work');

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/detached' });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a squash-merged branch when origin cannot be fetched', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/offline', { commit: true, push: true });
    squashMerge(repo, root, 'bill10/offline');
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', join(root, 'gone.git')]);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/offline' });
    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    // The doctor reads local refs only, and there the work is on main.
    expect(await commitsNotInBase({ repoPath: repo, branchName: 'bill10/offline' }, { fetch: false })).toBe(0);
  });
});

describe('commitsNotInBase edges', () => {
  it('cannot decide without a usable branch name or branch ref', async () => {
    const { repo } = repoWithRemote();
    expect(await commitsNotInBase({ repoPath: repo, branchName: '' })).toBe(-1);
    // A name git would read as an option never reaches argv.
    expect(await commitsNotInBase({ repoPath: repo, branchName: '--all' })).toBe(-1);
    expect(await commitsNotInBase({ repoPath: repo, branchName: 'bill10/never-made' })).toBe(-1);
  });

  it('without fetch, a squash merge since the last fetch still counts as ahead', async () => {
    // The doctor's path: local refs only, so the merge shows once something fetches.
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/stale-view', { commit: true, push: true });
    squashMerge(repo, root, 'bill10/stale-view');
    const session = { repoPath: repo, branchName: 'bill10/stale-view' };
    expect(await commitsNotInBase(session, { fetch: false })).toBe(1);
    expect(await commitsNotInBase(session)).toBe(0);
    expect(existsSync(wt)).toBe(true);
  });

  it('counts a branch whose change conflicts with main as not there', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/conflict', {});
    commitFile(wt, 'README.md', 'branch version', 'branch edit');
    const other = elsewhere(root);
    commitFile(other, 'README.md', 'main version', 'main edit');
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
    expect(await commitsNotInBase({ repoPath: repo, branchName: 'bill10/conflict' })).toBe(1);
  });

  it('falls back to the local base branch when the repo has no origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a007-cleanup-'));
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'bill10']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    commitFile(repo, 'README.md', 'base', 'base');
    execFileSync('git', ['-C', repo, 'branch', '-M', 'main']);
    execFileSync('git', ['-C', repo, 'branch', 'bill10/empty']);
    expect(await commitsNotInBase({ repoPath: repo, branchName: 'bill10/empty' })).toBe(0);
    const wt = worktreeOn(repo, root, 'bill10/local-work', { commit: true });
    expect(existsSync(wt)).toBe(true);
    expect(await commitsNotInBase({ repoPath: repo, branchName: 'bill10/local-work' })).toBe(1);
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
    expect(result.branchName).toMatch(/^bill10\/fix-flaky-test-[a-f0-9-]{36}$/);
  });

  it('still uses the plain name when the remote is clear', async () => {
    const { repo } = repoWithRemote();
    const result = await createWorktree(repo, 'Apex', 'brand-new-job', { suffixOnCollision: true });
    expect(result.branchName).toBe('bill10/brand-new-job');
  });
});

describe('removeWorktree when the remote-tracking ref is stale', () => {
  // A worker that pushes again (a rebase fix, a force-with-lease) can leave the
  // shared repo's refs/remotes/origin/<branch> on an old SHA, so @{u} resolves
  // but is not HEAD. The remote itself is the authority.
  function staleTracking(branch) {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, branch, { commit: true, push: true });
    const old = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(join(wt, 'fix.txt'), 'review fix');
    execFileSync('git', ['-C', wt, 'add', '-A']);
    execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'review fix']);
    execFileSync('git', ['-C', wt, 'push', '-q', 'origin', 'HEAD']);
    execFileSync('git', ['-C', repo, 'update-ref', `refs/remotes/origin/${branch}`, old]);
    return { repo, wt, old };
  }

  it('releases it when HEAD matches the branch on the remote', async () => {
    const { repo, wt, old } = staleTracking('bill10/stale-ref');
    expect(execFileSync('git', ['-C', wt, 'rev-parse', '@{u}'], { encoding: 'utf8' }).trim()).toBe(old);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/stale-ref' });

    expect(result).toEqual({ orphaned: false });
    expect(existsSync(wt)).toBe(false);
  });

  it('keeps it when the remote holds a different SHA', async () => {
    const { repo, wt } = staleTracking('bill10/stale-diverged');
    execFileSync('git', ['-C', wt, 'commit', '-q', '--amend', '-m', 'amended, never pushed']);

    const result = await removeWorktree({ worktreePath: wt, repoPath: repo, branchName: 'bill10/stale-diverged' });

    expect(result).toMatchObject({ orphaned: true, reason: 'unpushed' });
    expect(existsSync(wt)).toBe(true);
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

describe('discardWorktree', () => {
  it('never deletes a folder that is neither a worktree nor under WORKTREE_DIR', async () => {
    const { root, repo } = repoWithRemote();
    const stray = join(root, 'not-a-worktree');
    mkdirSync(stray);
    expect(await discardWorktree(repo, stray)).toBe(false);
    expect(await discardWorktree(repo, repo)).toBe(false);
    expect(existsSync(stray)).toBe(true);
    expect(existsSync(join(repo, 'README.md'))).toBe(true);
  });

  it('deletes in place when the folder cannot be moved to the trash', async () => {
    const { root, repo } = repoWithRemote();
    const wt = worktreeOn(repo, root, 'bill10/no-trash');
    // A file where the trash folder should be makes the move impossible, as a
    // worktree on another disk (EXDEV) would.
    const trash = join(process.env.AGENT007_WORKTREE_DIR, '.trash');
    // Earlier tests' trash is still being emptied in the background.
    await vi.waitFor(() => expect(existsSync(trash) && readdirSync(trash).length).toBeFalsy());
    rmSync(trash, { recursive: true, force: true });
    writeFileSync(trash, '');
    try {
      expect(await discardWorktree(repo, wt)).toBe(true);
    } finally { rmSync(trash); }
    expect(existsSync(wt)).toBe(false);
    expect(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' })).not.toContain('no-trash');
  });

  it('keeps the trash out of the orphan scan and empties it at startup', async () => {
    // Still a valid worktree, as a trashed one is until the prune runs.
    const { repo } = repoWithRemote();
    const leftover = join(process.env.AGENT007_WORKTREE_DIR, '.trash', 'Old-123');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', leftover, '-b', 'old']);
    await scanForOrphanedWorktrees(() => {});
    expect([...orphans.values()].some(o => o.worktreePath.includes('.trash'))).toBe(false);
    await pruneWorktrees();
    await vi.waitFor(() => expect(existsSync(leftover)).toBe(false));
  });
});
