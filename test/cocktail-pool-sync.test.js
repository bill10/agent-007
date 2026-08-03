import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncCocktailPool, gitExec } from '../server/git.js';
import { cocktailPool } from '../server/state.js';
import { COCKTAILS } from '../lib/helpers.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Regression: the pool only knew about names handed out since process start, so a
// branch left over from an earlier run stayed "available". pick() would return it,
// `worktree add -b` would fail with "already exists", the spawn errored, and the
// user's next attempt drew from the same unshrunk pool — so spawning felt like it
// took many tries.
//
// These tests drive the process-wide `cocktailPool` singleton, which has no reset.
// Isolation comes from each beforeEach mkdtemp'ing a fresh repo path: the pool is
// keyed by repoPath, so a new path is a clean slate. Do NOT reuse a fixed path
// here or tests will inherit each other's reservations.
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
    // Draw the whole pool over and never collide with the existing branch
    for (let i = 0; i < COCKTAILS.length * 2; i++) {
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
    // 'negroni' is free in `other` — proven by draining every base name. Bound is
    // COCKTAILS.length so this stays exact if the list grows.
    const drawn = new Set();
    for (let i = 0; i < COCKTAILS.length; i++) drawn.add(cocktailPool.pick(other));
    expect(drawn.has('negroni')).toBe(true);
  });

  // Taken from real branches found in a live repo: `branch/julep` (an incidental
  // feature branch) and `lawson-wong/rickey` (a teammate's). Neither collides with
  // the `bill-slung/<cocktail>` this app would create, so neither may block a name.
  it('leaves cocktails free when the holder is not one of our branches', async () => {
    await gitExec(['-C', repo, 'branch', 'branch/julep']);
    await gitExec(['-C', repo, 'branch', 'lawson-wong/rickey']);
    await gitExec(['-C', repo, 'branch', 'bill-slung/negroni']);
    await syncCocktailPool(repo);

    // Only negroni is genuinely held
    expect(cocktailPool.availableCount(repo)).toBe(COCKTAILS.length - 1);
    const drawn = new Set();
    for (let i = 0; i < COCKTAILS.length; i++) drawn.add(cocktailPool.pick(repo));
    expect(drawn.has('julep')).toBe(true);
    expect(drawn.has('rickey')).toBe(true);
    expect(drawn.has('negroni')).toBe(false);
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

  // The "best-effort" contract: a git failure must cost a collision, not a claim.
  // Asserting only "does not throw" would still pass if the catch block wiped the
  // claimed names — and this path runs on every spawn, so a transient git timeout
  // (GIT_AUTO_TIMEOUT, 5s) reaches it in production.
  it('leaves already-claimed names claimed when the git call fails', async () => {
    await gitExec(['-C', repo, 'branch', 'bill-slung/negroni']);
    await syncCocktailPool(repo);
    const claimed = cocktailPool.availableCount(repo);

    rmSync(repo, { recursive: true, force: true }); // git call now fails
    await syncCocktailPool(repo);

    expect(cocktailPool.availableCount(repo)).toBe(claimed);
  });

  it('does not throw on a path that is not a repo', async () => {
    await syncCocktailPool(join(base, 'nope'));
    expect(cocktailPool.availableCount(join(base, 'nope'))).toBe(COCKTAILS.length);
  });
});
