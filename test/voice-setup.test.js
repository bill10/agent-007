import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { setupVoice, setEnvLine } from '../server/voice-setup.js';
import { runCommand } from '../server/service.js';
import { removeTempDir } from './temp-dir.js';

const BODY = Buffer.from('fake ggml model bytes');
const SHA = createHash('sha256').update(BODY).digest('hex');

// Never real brew, whisper or network, and a temp HOME.
function fakeCtx(over = {}) {
  const home = mkdtempSync(join(tmpdir(), 'a007-voice-'));
  const out = [], calls = [], asked = [];
  const present = new Set(over.present || []);
  const cfg = join(home, '.agent-007');
  const ctx = {
    home, out, calls, asked, cfg,
    platform: 'darwin', tty: true, yes: false,
    env: { HOME: home, PATH: '/usr/bin', AGENT007_CONFIG_DIR: cfg },
    cwd: home,
    has: (n) => present.has(n),
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'brew') { present.add('whisper-cli'); present.add('ffmpeg'); }
      return { code: 0, stdout: cmd === 'whisper-cli' ? ' [BLANK_AUDIO] hello there\n' : '', stderr: '', ...(await over.answer?.(cmd, args)) };
    },
    fetch: async (url) => String(url).includes('/api/') ? Response.json([{ path: 'ggml-base.en.bin', lfs: { size: BODY.length, oid: SHA } }]) : new Response(BODY),
    ask: async (q) => { asked.push(q); return (over.answers || []).shift() ?? ''; },
    log: (s) => out.push(s), err: (s) => out.push(`ERR ${s}`), write: () => {},
    cmd: (s) => `agent007 ${s}`,
    ...over,
  };
  delete ctx.present; delete ctx.answers; delete ctx.answer;
  return ctx;
}
const text = (c) => c.out.join('\n');
const models = (c) => existsSync(join(c.cfg, 'whisper')) ? readdirSync(join(c.cfg, 'whisper')) : [];

describe('setupVoice', () => {
  it('macOS: brew, download after confirming, .env line, verify', async () => {
    const c = fakeCtx({ present: ['brew', 'say'], answers: ['', ''] });
    expect(await setupVoice(c)).toBe(0);
    expect(c.calls[0]).toBe('brew install whisper-cpp ffmpeg');
    expect(c.asked[1]).toMatch(/~150 MB.*huggingface\.co\/ggerganov\/whisper\.cpp/);
    expect(models(c)).toEqual(['ggml-base.en.bin']);
    expect(readFileSync(join(c.cfg, '.env'), 'utf8')).toContain(`\nWHISPER_MODEL=${join(c.cfg, 'whisper', 'ggml-base.en.bin')}\n`);
    expect(c.calls.some(x => x.startsWith('say '))).toBe(true);
    expect(text(c)).toMatch(/heard: "hello there"/);
    removeTempDir(c.home);
  });

  it('skips what is already done and asks nothing', async () => {
    const c = fakeCtx({ present: ['brew', 'whisper-cli', 'ffmpeg'] });
    mkdirSync(join(c.cfg, 'whisper'), { recursive: true });
    writeFileSync(join(c.cfg, 'whisper', 'ggml-base.en.bin'), BODY);
    writeFileSync(join(c.cfg, '.env'), `WHISPER_MODEL=${join(c.cfg, 'whisper', 'ggml-base.en.bin')}\n`);
    expect(await setupVoice(c)).toBe(0);
    expect(c.asked).toEqual([]);
    expect(c.calls.some(x => x.startsWith('brew'))).toBe(false);
    expect(text(c)).toMatch(/are installed[\s\S]*already there[\s\S]*already set/);
    removeTempDir(c.home);
  });

  it('declining the download keeps nothing; no TTY without --yes does not download', async () => {
    const no = fakeCtx({ present: ['whisper-cli', 'ffmpeg'], answers: ['', 'n'] });
    expect(await setupVoice(no)).toBe(1);
    expect(models(no)).toEqual([]);
    const quiet = fakeCtx({ present: ['whisper-cli', 'ffmpeg'], tty: false });
    expect(await setupVoice(quiet)).toBe(1);
    expect(quiet.asked).toEqual([]);
    expect(models(quiet)).toEqual([]);
    removeTempDir(no.home); removeTempDir(quiet.home);
  });

  it('--yes takes the default model without asking', async () => {
    const c = fakeCtx({ present: ['whisper-cli', 'ffmpeg'], yes: true });
    expect(await setupVoice(c)).toBe(0);
    expect(c.asked).toEqual([]);
    expect(models(c)).toEqual(['ggml-base.en.bin']);
    removeTempDir(c.home);
  });

  it('a failed or corrupt download leaves no partial file', async () => {
    for (const fetch of [
      async (u) => String(u).includes('/api/') ? Response.json([]) : new Response('x', { status: 503 }),
      async (u) => String(u).includes('/api/') ? Response.json([{ path: 'ggml-base.en.bin', lfs: { size: 3, oid: 'bad' } }]) : new Response('abc'),
      async (u) => String(u).includes('/api/') ? Response.json([{ path: 'ggml-base.en.bin', lfs: { size: 99, oid: SHA } }]) : new Response(BODY),
    ]) {
      const c = fakeCtx({ present: ['whisper-cli', 'ffmpeg'], yes: true, fetch });
      expect(await setupVoice(c)).toBe(1);
      expect(text(c)).toMatch(/✗ Download failed/);
      expect(models(c)).toEqual([]);
      expect(existsSync(join(c.cfg, '.env'))).toBe(false);
      removeTempDir(c.home);
    }
  });

  it('macOS without Homebrew prints the link and installs nothing', async () => {
    const c = fakeCtx({ yes: true });
    await setupVoice(c);
    expect(text(c)).toContain('https://brew.sh');
    expect(c.calls.some(x => x.startsWith('brew'))).toBe(false);
    removeTempDir(c.home);
  });

  it('Linux and Windows print instructions and install nothing', async () => {
    const lin = fakeCtx({ platform: 'linux', yes: true });
    expect(await setupVoice(lin)).toBe(1);
    expect(text(lin)).toMatch(/git clone[\s\S]*cmake[\s\S]*apt install ffmpeg[\s\S]*dnf install ffmpeg/);
    const win = fakeCtx({ platform: 'win32', yes: true });
    await setupVoice(win);
    expect(text(win)).toMatch(/releases[\s\S]*winget install ffmpeg/);
    expect(lin.calls.concat(win.calls)).toEqual([]);
    removeTempDir(lin.home); removeTempDir(win.home);
  });

  it('offers a restart when the server runs', async () => {
    let restarted = 0;
    const c = fakeCtx({ present: ['whisper-cli', 'ffmpeg'], answers: ['', '', 'y'] });
    await setupVoice(c, { running: async () => true, restart: async () => { restarted++; } });
    expect(c.asked.at(-1)).toMatch(/restart it now/);
    expect(restarted).toBe(1);
    const n = fakeCtx({ present: ['whisper-cli', 'ffmpeg'], answers: ['', '', 'n'] });
    await setupVoice(n, { running: async () => true, restart: async () => { restarted++; } });
    expect(restarted).toBe(1);
    expect(text(n)).toContain('agent007 restart');
    removeTempDir(c.home); removeTempDir(n.home);
  });
});

describe('setEnvLine', () => {
  it('edits only the WHISPER_MODEL line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a007-env-'));
    const f = join(dir, '.env');
    writeFileSync(f, 'PORT=8000\n# WHISPER_MODEL=/old\nHOST=0.0.0.0\n');
    expect(setEnvLine(f, '/m.bin')).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('PORT=8000\nWHISPER_MODEL=/m.bin\nHOST=0.0.0.0\n');
    writeFileSync(f, 'A=1\nWHISPER_MODEL=/old\nB=2');
    setEnvLine(f, '/m.bin');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nWHISPER_MODEL=/m.bin\nB=2');
    writeFileSync(f, 'A=1');
    setEnvLine(f, '/m.bin');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nWHISPER_MODEL=/m.bin\n');
    removeTempDir(dir);
  });

  it('creates the file from the template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a007-env-'));
    const f = join(dir, 'sub', '.env');
    setEnvLine(f, '/m.bin');
    const t = readFileSync(f, 'utf8');
    expect(t).toContain('\nWHISPER_MODEL=/m.bin\n');
    expect(t).toContain('# WHISPER_CPP_BIN=');
    removeTempDir(dir);
  });
});

describe('install modes', () => {
  const base = (over) => fakeCtx({ present: ['whisper-cli', 'ffmpeg'], root: '/opt/app', bin: '/opt/app/bin/agent-007.js', execPath: '/opt/node', port: 7007, host: '127.0.0.1',
    uid: 501, user: 'ada', portState: async () => 'free', readServer: () => null, readLastServer: () => null, procCwd: async () => null, remoteCheck: async () => [], callServer: async () => null, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000); })(), version: () => '1', ...over });

  it('--voice never touches the service', async () => {
    const c = base({ yes: false });
    const code = await runCommand('install', { voice: true, yes: true }, c);
    expect(code).toBe(0);
    expect(c.calls.filter(x => /launchctl|systemctl|loginctl/.test(x))).toEqual([]);
    expect(existsSync(join(c.home, 'Library', 'LaunchAgents'))).toBe(false);
    expect(existsSync(join(c.home, '.config', 'systemd'))).toBe(false);
    removeTempDir(c.home);
  });

  it('--voice and --all together are refused', async () => {
    const c = base();
    expect(await runCommand('install', { voice: true, all: true }, c)).toBe(2);
    removeTempDir(c.home);
  });

  it('plain install asks only with a TTY; "n" or no TTY installs no voice', async () => {
    const quiet = base({ platform: 'linux', tty: false, run: async (cmd, args) => { quiet.calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; } });
    await runCommand('install', {}, quiet);
    expect(quiet.asked).toEqual([]);
    const no = base({ platform: 'linux', answers: ['n'] });
    await runCommand('install', {}, no);
    expect(no.asked).toHaveLength(1);
    expect(no.asked[0]).toBe('Set up voice too? Downloads whisper.cpp and a ~150 MB speech model. [y/N] ');
    expect(models(no)).toEqual([]);
    removeTempDir(quiet.home); removeTempDir(no.home);
  });

  it('plain install: "y" sets voice up; --all does both without the question', async () => {
    const y = base({ platform: 'linux', answers: ['y', '', ''] });
    await runCommand('install', {}, y);
    expect(models(y)).toEqual(['ggml-base.en.bin']);
    const all = base({ platform: 'linux' });
    await runCommand('install', { all: true, yes: true }, all);
    expect(all.asked).toEqual([]);
    expect(models(all)).toEqual(['ggml-base.en.bin']);
    expect(all.calls.some(x => x.startsWith('systemctl'))).toBe(true);
    removeTempDir(y.home); removeTempDir(all.home);
  });
});
