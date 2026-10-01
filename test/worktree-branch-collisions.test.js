import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const stub = vi.hoisted(() => ({ exec: vi.fn(), uuid: vi.fn() }));
vi.mock('child_process', async importOriginal => ({ ...await importOriginal(), execFile: stub.exec }));
vi.mock('crypto', async importOriginal => ({ ...await importOriginal(), randomUUID: stub.uuid }));
import { createWorktree } from '../server/git.js';

const repo = mkdtempSync(join(tmpdir(), 'a007-branch-collision-'));
const uuid = '12345678-1234-4234-8234-123456789abc';
let attempts, remoteError, remoteNames, collision;
beforeEach(() => {
  attempts = []; remoteError = false; remoteNames = []; collision = false;
  stub.uuid.mockReset().mockReturnValue(uuid);
  stub.exec.mockImplementation((file, args, options, callback) => {
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
    if (args.includes('config')) return callback(null, 'owner\n', '');
    if (args.includes('ls-remote')) {
      if (remoteError) return callback(new Error('offline'), '', 'offline');
      return callback(null, remoteNames.map(n => `abc\trefs/heads/owner/${n}`).join('\n'), '');
    }
    if (args.includes('worktree')) {
      const branch = args[args.indexOf('-b') + 1];
      attempts.push(branch);
      if (collision) return callback(new Error('collision'), '', `fatal: a branch named '${branch}' already exists`);
    }
    callback(null, '', '');
  });
});

describe('bounded board branch allocation', () => {
  it('uses fresh entropy if remote discovery fails instead of reusing a possibly remote-only base', async () => {
    remoteError = true;
    const result = await createWorktree(repo, 'offline', 'job', { suffixOnCollision: true, startPoint: 'HEAD' });
    expect(result.branchName).toBe(`owner/job-${uuid}`);
    expect(attempts).toEqual([result.branchName]);
  });

  it('bounds atomic local collision retries even when every random name collides', async () => {
    collision = true;
    const result = await createWorktree(repo, 'collisions', 'job', { suffixOnCollision: true, startPoint: 'HEAD' });
    expect(result.error).toMatch(/Could not find a free branch name/);
    expect(attempts).toHaveLength(10);
    expect(attempts[0]).toBe('owner/job');
    expect(stub.uuid).toHaveBeenCalledTimes(9);
  });

  it('retries an atomic local base collision with a fresh name when discovery succeeds', async () => {
    const exec = stub.exec.getMockImplementation();
    stub.exec.mockImplementation((file, args, options, callback) => {
      collision = args.includes('worktree') && attempts.length === 0;
      exec(file, args, options, callback);
    });
    const result = await createWorktree(repo, 'local', 'job', { suffixOnCollision: true, startPoint: 'HEAD' });
    expect(result.error).toBeUndefined();
    expect(result.branchName).toBe(`owner/job-${uuid}`);
    expect(attempts).toEqual(['owner/job', `owner/job-${uuid}`]);
    expect(stub.uuid).toHaveBeenCalledTimes(1);
  });

  it('bounds remote-only collisions without attempting or deleting those branches', async () => {
    remoteNames = ['job', `job-${uuid}`];
    const result = await createWorktree(repo, 'remote', 'job', { suffixOnCollision: true, startPoint: 'HEAD' });
    expect(result.error).toMatch(/Could not find a free branch name/);
    expect(attempts).toEqual([]);
    expect(stub.uuid).toHaveBeenCalledTimes(9);
    expect(stub.exec.mock.calls.every(([, args]) => !args.includes('-D') && !args.includes('delete'))).toBe(true);
  });
});
