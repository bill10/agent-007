import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { updateInfo, startUpdate, resetSelfUpdate, updateLogPath, updateNotes, changelogBetween, CHANGELOG_URL } from '../server/self-update.js';
import { removeTempDir } from './temp-dir.js';
import { changelogWith } from '../scripts/release.js';

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

const LOG = `# Changelog

## [2.1.0.0] - 2026-10-09

- unreleased

## [2.0.0.0] - 2026-10-08

### Added

- **Two.**

## [1.1.0.0] - 2026-10-07

- One one.

## [1.0.0.0] - 2026-10-06

- One.
`;

describe('updateNotes', () => {
  it('keeps only the sections newer than this version, up to the latest, newest first', () => {
    const notes = changelogBetween(LOG, '1.0.0.0', '2.0.0.0');
    expect(notes.match(/^## \[[\d.]+\]/gm)).toEqual(['## [2.0.0.0]', '## [1.1.0.0]']);
    expect(notes).toContain('- **Two.**');
    expect(changelogBetween(LOG, '2.0.0.0', '2.0.0.0')).toBe('');
  });

  it('reads the CHANGELOG at the latest release once, and slices it', async () => {
    const asked = [];
    const fetchText = async (v) => { asked.push(v); return LOG; };
    const r = await updateNotes({ kind: 'npm', version: '1.0.0.0', fetchLatest: async () => '2.0.0', fetchText });
    expect(r).toMatchObject({ version: '1.0.0.0', latest: '2.0.0.0' });
    expect(r.notes).toContain('## [1.1.0.0]');
    expect(r.notes).not.toContain('## [1.0.0.0]');
    expect(r.notes).not.toContain('unreleased');
    await updateNotes({ kind: 'npm', version: '1.0.0.0', fetchLatest: async () => '2.0.0', fetchText });
    expect(asked).toEqual(['2.0.0.0']);
  });

  it('says so, with the GitHub link, when the fetch fails, and tries again next time', async () => {
    let text = null;
    const fetchText = async () => text;
    const r = await updateNotes({ kind: 'npm', version: '1.0.0.0', fetchLatest: async () => '2.0.0', fetchText });
    expect(r.error).toMatch(/Could not load/);
    expect(r.url).toBe(CHANGELOG_URL);
    expect(r.notes).toBeUndefined();
    text = LOG;
    expect((await updateNotes({ kind: 'npm', version: '1.0.0.0', fetchLatest: async () => '2.0.0', fetchText })).notes).toContain('## [2.0.0.0]');
  });

  // Value: protects=a newer release's notes after Check for updates moves the latest on; fails_when=notesCache is reused without comparing its latest (stale notes until restart); why_new=the cache test above keeps one latest throughout; seam=none
  it('reads the CHANGELOG again once a check finds a newer latest', async () => {
    const asked = [];
    const fetchText = async (v) => { asked.push(v); return LOG; };
    await updateNotes({ kind: 'npm', version: '1.0.0.0', fetchLatest: async () => '2.0.0', fetchText });
    await updateInfo({ kind: 'npm', version: '1.0.0.0', fetchLatest: async () => '2.1.0', env, fresh: true });
    const r = await updateNotes({ kind: 'npm', version: '1.0.0.0', fetchLatest: async () => '2.1.0', fetchText });
    expect(asked).toEqual(['2.0.0.0', '2.1.0.0']);
    expect(r.notes).toContain('## [2.1.0.0]');
  });

  // Value: protects=the release script's section headings staying sliceable; fails_when=scripts/release.js changelogWith or changelogBetween's heading regex changes and they drift apart (empty What's new); why_new=other tests use a hand-written LOG, never the generator's output; seam=none
  it('slices sections the release script writes', () => {
    let log = '# Changelog\n';
    for (const v of ['1.0.0.0', '1.1.0.0', '2.0.0.0']) log = changelogWith(log, v, '2026-10-08', [`### Added\n\n- In ${v}.`]);
    const notes = changelogBetween(log, '1.0.0.0', '2.0.0.0');
    expect(notes).toContain('- In 2.0.0.0.');
    expect(notes).toContain('- In 1.1.0.0.');
    expect(notes).not.toContain('- In 1.0.0.0.');
    expect(notes.indexOf('2.0.0.0')).toBeLessThan(notes.indexOf('1.1.0.0'));
  });

  // Value: protects=windows opened together share one GitHub fetch, and npx never asks; fails_when=the in-flight promise is not cached or the npx guard goes; why_new=the other cases await one call at a time; seam=none
  it('shares one fetch between windows opened together, and asks nothing under npx', async () => {
    let asked = 0;
    const fetchText = async () => { asked++; return LOG; };
    const opts = { kind: 'npm', version: '1.0.0.0', fetchLatest: async () => '2.0.0', fetchText };
    const [a, b] = await Promise.all([updateNotes(opts), updateNotes(opts)]);
    expect(asked).toBe(1);
    expect(a.notes).toBe(b.notes);
    expect(await updateNotes({ ...opts, kind: 'npx', fetchLatest: async () => { throw new Error('not asked'); } })).toEqual({ version: '1.0.0.0', notes: '' });
  });

  it('has nothing to say when up to date', async () => {
    const fetchText = async () => { throw new Error('not asked'); };
    expect(await updateNotes({ kind: 'npm', version: '2.0.0.0', fetchLatest: async () => '2.0.0', fetchText })).toEqual({ version: '2.0.0.0', notes: '' });
  });
});
