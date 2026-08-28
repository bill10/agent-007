import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorktree, gitExec } from '../server/git.js';
import { COCKTAILS } from '../lib/helpers.js';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

// The whole feature, end to end: ask git for a name instead of tracking which
// names are free. These run against a real repo because git IS the design — a
// test that stubbed it would only be testing the stub.
//
// Hermetic via AGENT007_WORKTREE_DIR (test/setup.js), which keeps worktrees out of
// the developer's live ~/.agent-007/worktrees.
describe('createWorktree finds a free branch by trying', () => {
  let base, repo, agentN;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'a007-retry-'));
    repo = join(base, 'repo');
    agentN = 0;
    await gitExec(['init', '-q', repo]);
    await gitExec(['-C', repo, 'config', 'user.name', 'Bill Slung']);
    await gitExec(['-C', repo, 'config', 'user.email', 't@t.com']);
    await gitExec(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  });
  afterEach(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  // Each call needs its own agent name, since the worktree dir is keyed by it.
  const spawn = (custom) => createWorktree(repo, `agent${++agentN}`, custom);

  it('normalizes the git user into the branch prefix', async () => {
    const r = await spawn();
    expect(r.branchName).toBe(`bill-slung/${r.cocktail}`);   // "Bill Slung" -> bill-slung
    expect(COCKTAILS).toContain(r.cocktail);
    expect(existsSync(r.worktreePath)).toBe(true);
  });

  it('skips a cocktail whose branch already exists', async () => {
    for (const c of COCKTAILS.slice(0, COCKTAILS.length - 1)) {
      await gitExec(['-C', repo, 'branch', `bill-slung/${c}`]);
    }
    const only = COCKTAILS[COCKTAILS.length - 1];
    const r = await spawn();
    expect(r.cocktail).toBe(only);   // the one name left
    expect(r.error).toBeUndefined();
  });

  it('falls back to an ordinal prefix when every cocktail is taken', async () => {
    for (const c of COCKTAILS) await gitExec(['-C', repo, 'branch', `bill-slung/${c}`]);
    const r = await spawn();
    expect(r.error).toBeUndefined();
    expect(r.cocktail).toMatch(/^2nd-/);
    expect(r.branchName).toBe(`bill-slung/${r.cocktail}`);
  });

  it('hands out distinct names across repeated spawns', async () => {
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      const r = await spawn();
      expect(r.error).toBeUndefined();
      expect(seen.has(r.cocktail)).toBe(false);
      seen.add(r.cocktail);
    }
  });

  // Branches made outside the app are exactly what the old bookkeeping missed.
  it('respects a branch created behind the app\'s back', async () => {
    const first = await spawn();
    await gitExec(['-C', repo, 'branch', `bill-slung/${first.cocktail}-decoy`]);
    const second = await spawn();
    expect(second.cocktail).not.toBe(first.cocktail);
  });

  it('leaves no worktree directory behind for a skipped name', async () => {
    for (const c of COCKTAILS.slice(0, 5)) {
      await gitExec(['-C', repo, 'branch', `bill-slung/${c}`]);
    }
    const r = await spawn();
    expect(r.error).toBeUndefined();
    // This repo's worktree root, not whichever dir happens to sort first — the
    // temp WORKTREE_DIR is shared by every test in this file.
    expect(readdirSync(dirname(r.worktreePath))).toEqual(['agent1']);  // one dir, not one per attempt
  });

  // --- custom branch: report the collision, never silently rename ---

  it('uses a custom name verbatim', async () => {
    const r = await spawn('my-feature');
    expect(r.branchName).toBe('bill-slung/my-feature');
    expect(r.cocktail).toBe('my-feature');
  });

  it('errors instead of retrying when a custom name is taken', async () => {
    await gitExec(['-C', repo, 'branch', 'bill-slung/my-feature']);
    const r = await spawn('my-feature');
    expect(r.error).toMatch(/already in use/);
    expect(r.cocktail).toBeUndefined();
  });

  // Concurrent spawns are the case the retry design is supposed to settle for
  // free. Losers must each land on their own name, not error out.
  it('gives concurrent spawns into one repo distinct names', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => spawn()),
    );
    for (const r of results) expect(r.error).toBeUndefined();
    expect(new Set(results.map(r => r.cocktail)).size).toBe(6);
    expect(new Set(results.map(r => r.branchName)).size).toBe(6);
  });

  // A worktree-path collision says "already exists" too, but no other cocktail
  // can fix it — retrying would walk the whole pool for nothing.
  it('does not retry a worktree-path collision', async () => {
    const first = await spawn();
    expect(first.error).toBeUndefined();
    const again = await createWorktree(repo, 'agent1', undefined);  // same agent name
    expect(again.error).toMatch(/Failed to create worktree/);
    expect(again.error).not.toMatch(/already in use/);
  });
});

describe('branch prefix fallback', () => {
  it('falls back to "agent" when user.name is set to the empty string', async () => {
    // `git config user.name` exits 0 with empty output in that case, so it
    // never reaches branchPrefix's catch. An empty prefix makes every branch
    // `/<name>`, which git rejects outright.
    const repo = mkdtempSync(join(tmpdir(), 'a007-emptyuser-'));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@x']);
    // Commit under a real name first — git refuses to commit with an empty
    // ident — then blank it, which is the state that reaches branchPrefix.
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'temp']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', '']);

    const result = await createWorktree(repo, 'Viper');
    expect(result.error).toBeUndefined();
    expect(result.branchName.startsWith('agent/')).toBe(true);
  });
});
