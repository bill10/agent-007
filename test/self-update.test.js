import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { updateInfo, startUpdate, resetSelfUpdate, updateLogPath } from '../server/self-update.js';
import { removeTempDir } from './temp-dir.js';

// A fake spawn: records the call, hands back a child the test ends by hand.
function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, unref() { child.unrefed = true; } });
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawn, calls };
}

let dir, env;
beforeEach(() => { resetSelfUpdate(); dir = mkdtempSync(join(tmpdir(), 'a007-selfupdate-')); env = { AGENT007_CONFIG_DIR: dir }; });
afterEach(() => removeTempDir(dir));

describe('updateInfo', () => {
  it('names a newer npm version in VERSION form, and none when current', async () => {
    expect(await updateInfo({ kind: 'npm', version: '0.53.5.0', fetchLatest: async () => '0.54.0', env })).toEqual({ version: '0.53.5.0', kind: 'npm', latest: '0.54.0.0' });
    resetSelfUpdate();
    expect((await updateInfo({ kind: 'npm', version: '0.53.5.0', fetchLatest: async () => '0.53.5000', env })).latest).toBeUndefined();
    resetSelfUpdate();
    expect((await updateInfo({ kind: 'npm', version: '0.53.5.0', fetchLatest: async () => null, env })).latest).toBeUndefined();
  });

  it('fresh skips the cache, at most every 10 s, and keeps the cache when the registry fails', async () => {
    let asked = 0, answer = '9.0.0';
    const fetchLatest = async () => { asked++; return answer; };
    await updateInfo({ kind: 'npm', version: '1.0.0.0', fetchLatest, env });
    expect(asked).toBe(1);
    expect((await updateInfo({ kind: 'npm', version: '1.0.0.0', fetchLatest, env, fresh: true })).latest).toBe('9.0.0.0');
    expect(asked).toBe(2);
    answer = '10.0.0';
    expect((await updateInfo({ kind: 'npm', version: '1.0.0.0', fetchLatest, env, fresh: true })).latest).toBe('9.0.0.0');
    expect(asked).toBe(2);
    resetSelfUpdate();
    await updateInfo({ kind: 'npm', version: '1.0.0.0', fetchLatest, env });
    answer = null;
    const failed = await updateInfo({ kind: 'npm', version: '1.0.0.0', fetchLatest, env, fresh: true });
    expect(failed.checkFailed).toBe(true);
    expect(failed.latest).toBe('10.0.0.0');
  });

  it('asks the registry once per 10 minutes', async () => {
    let asked = 0;
    const fetchLatest = async () => { asked++; return '9.0.0'; };
    await updateInfo({ kind: 'npm', fetchLatest, env });
    await updateInfo({ kind: 'checkout', fetchLatest, env });
    expect(asked).toBe(1);
  });

  it('never asks for an npx copy', async () => {
    let asked = 0;
    const info = await updateInfo({ kind: 'npx', version: '1.0.0.0', fetchLatest: async () => { asked++; return '9.0.0'; }, env });
    expect(info).toEqual({ version: '1.0.0.0', kind: 'npx' });
    expect(asked).toBe(0);
  });
});

describe('startUpdate', () => {
  it('runs `agent007 update` detached with its output in update.log, and returns at once', () => {
    const { spawn, calls } = fakeSpawn();
    expect(startUpdate({ kind: 'npm', spawn, env, execPath: '/node', bin: '/app/bin/agent-007.js' })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const [{ cmd, args, opts, child }] = calls;
    expect([cmd, ...args]).toEqual(['/node', '/app/bin/agent-007.js', 'update']);
    expect(opts.detached).toBe(true);
    expect(typeof opts.stdio[1]).toBe('number');
    expect(child.unrefed).toBe(true);
    expect(existsSync(updateLogPath(env))).toBe(true);
  });

  it('starts one update at a time, and another once it has ended', async () => {
    const { spawn, calls } = fakeSpawn();
    startUpdate({ kind: 'checkout', spawn, env });
    expect(startUpdate({ kind: 'checkout', spawn, env })).toEqual({ error: 'An update is already running.' });
    expect(calls).toHaveLength(1);
    expect((await updateInfo({ kind: 'checkout', fetchLatest: async () => null, env })).updating).toEqual({});
    calls[0].child.emit('exit', 0);
    expect(startUpdate({ kind: 'checkout', spawn, env })).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('says how many busy workers it waits for, and reads a failure back from the log', async () => {
    const { spawn, calls } = fakeSpawn();
    startUpdate({ kind: 'npm', spawn, env });
    writeFileSync(updateLogPath(env), 'Updated 1 → 2.\n2 workers are mid-run. Waiting for the board to go idle...\n');
    expect((await updateInfo({ kind: 'npm', fetchLatest: async () => null, env, workers: 2 })).updating).toEqual({ waiting: 2 });
    writeFileSync(updateLogPath(env), 'npm install -g failed: EACCES: permission denied\n');
    calls[0].child.emit('exit', 1);
    expect((await updateInfo({ kind: 'npm', fetchLatest: async () => null, env })).finished).toEqual({ code: 1, log: 'npm install -g failed: EACCES: permission denied' });
  });

  it('refuses an npx copy and spawns nothing', () => {
    const { spawn, calls } = fakeSpawn();
    expect(startUpdate({ kind: 'npx', spawn, env }).error).toMatch(/npx runs the latest/);
    expect(calls).toHaveLength(0);
  });
});
