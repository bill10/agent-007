import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addRepo, gitExec } from '../server/git.js';
import { cocktailPool, config } from '../server/state.js';
import { COCKTAILS } from '../lib/helpers.js';
import { mkdtempSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The wire, not the ends. cocktail-pool-sync.test.js proves syncCocktailPool reads
// branches, and helpers.test.js proves the pool honours them — but neither proves
// addRepo actually calls the sync before server.js reaches pick(). Deleting that
// one `await` in git.js left the whole suite green, so this test exists to fail.
//
// Hermetic by construction: the repo is pre-registered in config.repos so addRepo
// takes its early-return branch and never calls saveConfig. CONFIG_PATH
// (state.js:70) is the developer's real ~/.agent-007/config.json with no env
// override, so writing it during a test would clobber live server state.
describe('addRepo syncs the cocktail pool on the spawn path', () => {
  let base, repo, resolved;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'a007-addrepo-'));
    repo = join(base, 'repo');
    await gitExec(['init', '-q', repo]);
    await gitExec(['-C', repo, 'config', 'user.name', 'bill-slung']);
    await gitExec(['-C', repo, 'config', 'user.email', 't@t.com']);
    await gitExec(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
    // macOS mkdtemp yields /var/... which realpaths to /private/var/...; addRepo
    // keys the pool by the resolved path, so assertions must use it too.
    resolved = realpathSync(repo);
    config.repos.push({ path: resolved, addedAt: 'test' });
  });

  afterEach(() => {
    config.repos = config.repos.filter(r => r.path !== resolved);
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });

  it('makes a branch-held name unavailable before pick() can return it', async () => {
    await gitExec(['-C', repo, 'branch', 'bill-slung/negroni']);
    const before = cocktailPool.availableCount(resolved);

    const result = await addRepo(repo, null);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(resolved);

    expect(cocktailPool.availableCount(resolved)).toBe(before - 1);
    for (let i = 0; i < COCKTAILS.length * 2; i++) {
      const picked = cocktailPool.pick(resolved);
      expect(picked).not.toBe('negroni');
      cocktailPool.recycle(resolved, picked);
    }
  });
});
