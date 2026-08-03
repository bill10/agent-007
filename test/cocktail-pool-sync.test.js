import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncCocktailPool, gitExec } from '../server/git.js';
import { cocktailPool } from '../server/state.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Regression: the pool only knew about names handed out since process start, so a
// branch left over from an earlier run stayed "available". pick() would return it,
// `worktree add -b` would fail with "already exists", and the retry drew from the
// same unshrunk pool — spawning felt like it took many tries.
describe('syncCocktailPool reads names already held by branches', () => {
  let base, repo, other;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'a007-pool-'));
    repo = join(base, 'repo');
    other = join(base, 'other');
    for (const r of [repo, other]) {
      await gitExec(['init', '-q', r]);
      await gitExec(['-C', r, 'config', 'user.name', 'bill-slung']);
      await gitExec(['-C', r, 'config', 'user.email', 't@t.com']);
      await gitExec(['-C', r, 'commit', '-q', '--allow-empty', '-m', 'init']);
      await gitExec(['-C', r, 'branch', '-M', 'main']);
    }
  });
  afterEach(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  it('marks a cocktail unavailable once its branch exists', async () => {
    await syncCocktailPool(repo);
    const before = cocktailPool.availableCount(repo);

    await gitExec(['-C', repo, 'branch', 'bill-slung/negroni']);
    await syncCocktailPool(repo);

    expect(cocktailPool.availableCount(repo)).toBe(before - 1);
    // 200 draws never collide with the branch that already exists
    for (let i = 0; i < 200; i++) {
      const picked = cocktailPool.pick(repo);
      expect(picked).not.toBe('negroni');
      cocktailPool.recycle(repo, picked);
    }
  });

  it('does not let one repo\'s branches shrink another repo\'s pool', async () => {
    await gitExec(['-C', repo, 'branch', 'bill-slung/negroni']);
    await syncCocktailPool(repo);
    await syncCocktailPool(other);

    expect(cocktailPool.availableCount(other)).toBeGreaterThan(cocktailPool.availableCount(repo));
    // 'negroni' is free in `other` — proven by exhausting everything else
    const drawn = new Set();
    for (let i = 0; i < 400; i++) drawn.add(cocktailPool.pick(other));
    expect(drawn.has('negroni')).toBe(true);
  });

  it('leaves the pool intact for branches that are not cocktails', async () => {
    const full = cocktailPool.availableCount(repo);   // fresh repo: only `main`
    await gitExec(['-C', repo, 'branch', 'bill-slung/some-feature']);
    await gitExec(['-C', repo, 'branch', 'release-2024']);
    await syncCocktailPool(repo);
    expect(cocktailPool.availableCount(repo)).toBe(full);
  });

  it('is idempotent across repeated syncs', async () => {
    await gitExec(['-C', repo, 'branch', 'bill-slung/negroni']);
    await syncCocktailPool(repo);
    const count = cocktailPool.availableCount(repo);
    await syncCocktailPool(repo);
    await syncCocktailPool(repo);
    expect(cocktailPool.availableCount(repo)).toBe(count);
  });

  it('frees the name again after the branch is deleted', async () => {
    await gitExec(['-C', repo, 'branch', 'bill-slung/negroni']);
    await syncCocktailPool(repo);
    const shrunk = cocktailPool.availableCount(repo);

    await gitExec(['-C', repo, 'branch', '-D', 'bill-slung/negroni']);
    await syncCocktailPool(repo);

    expect(cocktailPool.availableCount(repo)).toBe(shrunk + 1);
  });

  it('does not throw on a path that is not a repo', async () => {
    await syncCocktailPool(join(base, 'nope'));
  });
});
