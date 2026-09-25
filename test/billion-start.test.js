// startBillion (server.js) and the Start button's 'billion-start' message.
// createSessionFromConfig is replaced so no real Claude Code ever starts: what
// is under test is the folder, the command, and which session survives.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parseCommand } from '../lib/helpers.js';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const spawned = [];
let spawnError = null;
vi.mock('../server/pty.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createSessionFromConfig: vi.fn((cfg) => {
    if (spawnError) return { error: spawnError };
    const session = {
      ...cfg, id: cfg.sessionId, state: 'WORKING', exited: false,
      pty: { cols: 80, rows: 24, write: () => {}, kill: () => {} },
      ringBuffer: { getAll: () => [] },
    };
    spawned.push(session);
    return { session };
  }),
}));
// Whether `claude` is on PATH, decided here rather than by the machine: CI has none.
let hasClaude = true;
vi.mock('../server/command-path.js', async (importOriginal) => ({
  ...(await importOriginal()),
  commandExists: vi.fn(() => hasClaude),
}));
let transcript = { agent: null };
vi.mock('../server/agent-transcripts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  hasClaudeTranscript: vi.fn(() => transcript.agent === 'claude'),
}));

const { server, sessions, startBillion } = await import('../server.js');
const { config } = await import('../server/state.js');

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'a007-bstart-')), 'billion');

beforeEach(() => {
  sessions.clear();
  spawned.length = 0;
  spawnError = null;
  hasClaude = true;
  transcript = { agent: null };
  config.repos = [];
  process.env.BILLION_DIR = freshDir();
  delete process.env.BILLION;
});
afterAll(() => { delete process.env.BILLION_DIR; delete process.env.BILLION; });

describe('startBillion', () => {
  it('first run: makes its folder, introduces itself, and holds its mail', () => {
    config.repos = [{ path: '/p/projects/a' }, { path: '/p/projects/b' }];
    const { session, error } = startBillion();
    expect(error).toBeUndefined();
    expect(session.isBillion).toBe(true);
    expect(session.name).toBe('Billion');
    expect(session.cwd).toBe(process.env.BILLION_DIR);
    expect(session.repoPath).toBeNull();
    expect(session.messagesHeld).toBe(true);
    expect(session.command).toMatch(/first run/);
    expect(session.command).not.toMatch(/--continue/);
    // Read back through parseCommand: on Windows the path has a drive and
    // backslashes, which the command string escapes.
    expect(parseCommand(session.command).args.at(-1)).toContain(`Suggest ${resolve('/p/projects')} as the projects folder`);
    expect(sessions.get(session.id)).toBe(session);
  });

  it('returns the running one instead of starting a second', () => {
    const first = startBillion().session;
    expect(startBillion()).toMatchObject({ session: first, existing: true });
    expect(spawned).toHaveLength(1);
  });

  it('replaces a stopped one, continuing its conversation and refreshing an old charter', () => {
    const old = startBillion().session;
    old.exited = true;
    const dir = process.env.BILLION_DIR;
    writeFileSync(join(dir, 'CHARTER.md'), 'an older charter');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'old'], { cwd: dir });
    transcript = { agent: 'claude' };
    const { session } = startBillion();
    expect(session).not.toBe(old);
    expect(sessions.has(old.id)).toBe(false);
    expect([...sessions.values()].filter(s => s.isBillion)).toEqual([session]);
    expect(session.command).toMatch(/--continue/);
    expect(session.command).toMatch(/You were restarted/);
    expect(readFileSync(join(dir, 'CHARTER.md'), 'utf8')).not.toBe('an older charter');
  });

  it('does not continue a Codex transcript', () => {
    startBillion().session.exited = true;
    transcript = { agent: 'codex' };
    expect(startBillion().session.command).not.toMatch(/--continue/);
  });

  it('reports a folder it cannot make, and starts nothing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'a007-bstart-file-')), 'plain');
    writeFileSync(file, 'not a folder');
    process.env.BILLION_DIR = join(file, 'billion');
    const { error } = startBillion();
    expect(error).toMatch(/Could not set up Billion's folder/);
    expect(spawned).toHaveLength(0);
    expect(sessions.size).toBe(0);
  });

  it('without claude, its tab says how to install it or turn Billion off', () => {
    hasClaude = false;
    const { session, notice } = startBillion();
    expect(notice).toMatch(/not installed/);
    expect(session.isBillion).toBe(true);
    const { file, args } = parseCommand(session.command);
    expect(file).toBe(process.execPath);
    const out = execFileSync(file, args, { encoding: 'utf8' });
    expect(out).toMatch(/Install it from https:\/\/docs\.anthropic\.com/);
    expect(out).toMatch(/BILLION=0/);
    // Start checks again: once claude is there, the real Billion starts.
    session.exited = true;
    hasClaude = true;
    expect(startBillion().session.command).toMatch(/^claude /);
  });

  it('passes a spawn failure on, leaving no session behind', () => {
    spawnError = 'claude: command not found';
    expect(startBillion()).toEqual({ error: 'claude: command not found' });
    expect(sessions.size).toBe(0);
  });
});

describe('the Start button (billion-start)', () => {
  let url;
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    url = `ws://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(r => server.close(r)));

  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen = [];
    ws.on('message', (d) => seen.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, seen }));
    ws.on('error', reject);
  });
  const settle = () => new Promise(r => setTimeout(r, 200));

  it('starts Billion and focuses it in the window that asked', async () => {
    const { ws, seen } = await open();
    ws.send(JSON.stringify({ type: 'billion-start' }));
    await vi.waitFor(() => expect(seen.find(m => m.type === 'session-created')).toBeTruthy());
    const created = seen.find(m => m.type === 'session-created');
    expect(created).toMatchObject({ isBillion: true, focus: true, name: 'Billion' });
    ws.close();
  });

  it('shows the error when Billion cannot start', async () => {
    spawnError = 'claude: command not found';
    const { ws, seen } = await open();
    ws.send(JSON.stringify({ type: 'billion-start' }));
    await vi.waitFor(() => expect(seen.find(m => m.type === 'spawn-error')).toBeTruthy());
    expect(seen.find(m => m.type === 'spawn-error').error).toBe('claude: command not found');
    ws.close();
  });

  it('announces Billion once, however often Start is pressed', async () => {
    const { ws, seen } = await open();
    ws.send(JSON.stringify({ type: 'billion-start' }));
    await vi.waitFor(() => expect(seen.find(m => m.type === 'session-created')).toBeTruthy());
    ws.send(JSON.stringify({ type: 'billion-start' }));
    await settle();
    expect(seen.filter(m => m.type === 'session-created' && m.isBillion)).toHaveLength(1);
    ws.close();
  });

  it('says why when Billion is turned off, and starts nothing', async () => {
    process.env.BILLION = '0';
    const { ws, seen } = await open();
    await vi.waitFor(() => expect(seen.find(m => m.type === 'welcome')).toBeTruthy());
    expect(seen.find(m => m.type === 'welcome').billionEnabled).toBe(false);
    ws.send(JSON.stringify({ type: 'billion-start' }));
    await settle();
    expect(spawned).toHaveLength(0);
    expect(seen.some(m => m.type === 'session-created')).toBe(false);
    expect(seen.find(m => m.type === 'spawn-error').error).toMatch(/Billion is off/);
    ws.close();
  });
});
