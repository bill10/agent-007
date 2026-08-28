import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktree, resolveBaseBranch } from '../server/git.js';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

// A clone whose local base branch is one commit BEHIND the remote, which is the
// normal state of a checkout you have not pulled today.
function staleClone() {
  const root = mkdtempSync(join(tmpdir(), 'a007-sp-'));
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const repo = join(root, 'repo');
  execFileSync('git', ['clone', '-q', bare, repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.name', 'bill10');
  git(repo, 'config', 'user.email', 'b@b');
  writeFileSync(join(repo, 'f.txt'), 'v1');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'commit A');
  // Explicit, so the test does not inherit init.defaultBranch (master on CI).
  git(repo, 'branch', '-M', 'main');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  // Point the bare repo's HEAD at main. `git init --bare` sets it from
  // init.defaultBranch, which is still master on CI runners, so without this a
  // fresh clone lands on an unborn master instead of main. A real remote's HEAD
  // tracks its default branch, so this also makes the fixture realistic — and
  // it is what resolveBaseBranch reads first.
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  // Someone else lands a commit on the remote.
  const other = join(root, 'other');
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'ignore' });
  git(other, 'config', 'user.name', 'other');
  git(other, 'config', 'user.email', 'o@o');
  writeFileSync(join(other, 'f.txt'), 'v2');
  git(other, 'commit', '-q', '-am', 'commit B');
  git(other, 'push', '-q', 'origin', 'main');

  return { root, repo, bare };
}

describe('what a new agent branch starts from', () => {
  it('branches from the remote base, not from a stale local base', async () => {
    // `worktree add -b` with no start-point uses HEAD, so an un-pulled checkout
    // silently started every agent on superseded code.
    const { repo, bare } = staleClone();
    // Precondition: local main is behind what is actually on the remote. Note
    // the local `origin/main` ref is ALSO stale here — nothing has fetched yet,
    // which is exactly the situation the fetch inside createWorktree exists for.
    const remoteHead = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    expect(git(repo, 'rev-parse', 'main').trim()).not.toBe(remoteHead);

    const result = await createWorktree(repo, 'Viper');
    expect(result.error).toBeUndefined();
    expect(readFileSync(join(result.worktreePath, 'f.txt'), 'utf8')).toBe('v2');
    expect(result.startPoint).toBe('origin/main');
  });

  it('does not inherit an unrelated branch the user happens to have checked out', async () => {
    // The worse case: the agent's PR would carry the user's half-finished work.
    const { repo } = staleClone();
    git(repo, 'checkout', '-q', '-b', 'wip/experiment');
    writeFileSync(join(repo, 'scratch.txt'), 'half-finished');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'unrelated experiment');

    const result = await createWorktree(repo, 'Apex');
    expect(existsSync(join(result.worktreePath, 'scratch.txt'))).toBe(false);
    expect(readFileSync(join(result.worktreePath, 'f.txt'), 'utf8')).toBe('v2');
  });

  it('honours an explicit start-point without second-guessing it', async () => {
    // The escape hatch: "branch off what I am working on".
    const { repo } = staleClone();
    git(repo, 'checkout', '-q', '-b', 'wip/experiment');
    writeFileSync(join(repo, 'scratch.txt'), 'half-finished');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'unrelated experiment');

    const result = await createWorktree(repo, 'Onyx', null, { startPoint: 'wip/experiment' });
    expect(result.startPoint).toBe('wip/experiment');
    expect(existsSync(join(result.worktreePath, 'scratch.txt'))).toBe(true);
  });

  it('falls back to the local base branch when there is no remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a007-sp-local-'));
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'config', 'user.name', 'bill10');
    git(repo, 'config', 'user.email', 'b@b');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'branch', '-M', 'main');

    const result = await createWorktree(repo, 'Ghost');
    expect(result.error).toBeUndefined();
    expect(result.startPoint).toBe('main');
  });

  it('still works in a repo whose only branch is neither main nor master', async () => {
    // No base branch resolvable at all -> null start-point -> HEAD, the old
    // behaviour, which is right for a repo like this.
    const root = mkdtempSync(join(tmpdir(), 'a007-sp-odd-'));
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'config', 'user.name', 'bill10');
    git(repo, 'config', 'user.email', 'b@b');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'branch', '-M', 'trunk-of-our-own');

    const result = await createWorktree(repo, 'Ember');
    expect(result.error).toBeUndefined();
    expect(result.startPoint).toBeNull();
    expect(existsSync(result.worktreePath)).toBe(true);
  });
});

describe('resolveBaseBranch', () => {
  it('prefers the remote HEAD, so a develop/trunk default is handled', async () => {
    const { repo } = staleClone();
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await resolveBaseBranch(repo)).toBe('main');
  });

  it('falls back to a local main or master', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a007-base-'));
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'config', 'user.name', 'x');
    git(repo, 'config', 'user.email', 'x@x');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'i');
    git(repo, 'branch', '-M', 'master');
    expect(await resolveBaseBranch(repo)).toBe('master');
  });

  it('returns null when there is no recognisable base branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a007-base-none-'));
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'config', 'user.name', 'x');
    git(repo, 'config', 'user.email', 'x@x');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'i');
    git(repo, 'branch', '-M', 'somethingelse');
    expect(await resolveBaseBranch(repo)).toBeNull();
  });
});
