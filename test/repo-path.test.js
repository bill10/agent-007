import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateRepoPath } from '../server/git.js';
import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { join, isAbsolute } from 'path';
import { tmpdir } from 'os';

// validateRepoPath used to test `repoPath.startsWith('/')`, which no absolute
// Windows path satisfies — so "Add repo" answered "Path must be absolute" for
// every path a Windows user could possibly type.
describe('validateRepoPath accepts this platform\'s absolute paths', () => {
  let repo;
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'a007-repopath-')));
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: repo });
  });
  afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch {} });

  it('accepts a real absolute path on whichever platform is running', async () => {
    // The fixture path is `/tmp/...` on POSIX and `C:\Users\...\Temp\...` on
    // Windows; only the second one exercises the bug, and it is the one that
    // used to fail.
    expect(isAbsolute(repo)).toBe(true);
    const result = await validateRepoPath(repo);
    expect(result).toEqual({ valid: true, resolvedPath: repo });
  });

  it('still rejects a relative path, which would resolve against the server cwd', async () => {
    expect(await validateRepoPath('some/relative/repo')).toEqual({
      valid: false, error: 'Path must be absolute',
    });
    expect(await validateRepoPath('./repo')).toEqual({
      valid: false, error: 'Path must be absolute',
    });
  });

  it('rejects empty and non-string input before touching the disk', async () => {
    expect(await validateRepoPath('')).toEqual({ valid: false, error: 'Path is required' });
    expect(await validateRepoPath(null)).toEqual({ valid: false, error: 'Path is required' });
    expect(await validateRepoPath(42)).toEqual({ valid: false, error: 'Path is required' });
  });

  it('rejects an absolute path that is not there', async () => {
    const missing = join(repo, 'no', 'such', 'dir');
    expect(await validateRepoPath(missing)).toEqual({
      valid: false, error: 'Directory does not exist',
    });
  });
});
