import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDiff } from '../server/git.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// getDiff reads a client-controlled filePath and is open to non-owners (phase 2
// read surface), so it must never escape the worktree.
describe('getDiff worktree containment', () => {
  let base, wt;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'a007-wt-'));
    wt = join(base, 'worktree');
    mkdirSync(wt);
    writeFileSync(join(base, 'SECRET.txt'), 'TOP-SECRET');
    writeFileSync(join(wt, 'inside.txt'), 'hello inside');
  });
  afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  it('reads a file inside the worktree', async () => {
    const out = await getDiff({ worktreePath: wt }, 'inside.txt', '?');
    expect(out).toContain('hello inside');
  });

  it('refuses a ../ traversal out of the worktree', async () => {
    const out = await getDiff({ worktreePath: wt }, '../SECRET.txt', '?');
    expect(out).not.toContain('TOP-SECRET');
    expect(out).toMatch(/escapes worktree|Error reading file/i);
  });

  it('refuses a deep traversal to an absolute host path', async () => {
    const out = await getDiff({ worktreePath: wt }, '../../../../../../etc/hosts', '?');
    expect(out).not.toMatch(/localhost/);
  });
});
