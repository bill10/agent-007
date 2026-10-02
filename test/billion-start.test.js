// startBillion (server.js) and the Start button's 'billion-start' message.
// createSessionFromConfig is replaced so no real Claude Code ever starts: what
// is under test is the folder, the command, and which session survives.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
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
    const exits = [];
    const session = {
      ...cfg, id: cfg.sessionId, state: 'WORKING', exited: false,
      agent: cfg.command.startsWith('codex') ? 'codex' : cfg.command.startsWith('claude') ? 'claude' : null,
      pty: { cols: 80, rows: 24, write: () => {}, onExit: (cb) => exits.push(cb), kill: () => { session.exited = true; exits.forEach(cb => cb({ exitCode: 0 })); } },
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
// Whether the CLI says it is logged in, decided here too: never a real `claude auth status`.
let loggedIn = true;   // true, false, or null for a check that did not answer
vi.mock('../server/billion-limit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  cliReady: vi.fn(async () => { await new Promise(r => setTimeout(r, 0)); return loggedIn; }),
}));
// Discovery decided here too: never a real `codex debug models`.
let modelsIn = true;
vi.mock('../server/models.js', async (importOriginal) => ({
  ...(await importOriginal()),
  modelsReady: vi.fn(async () => modelsIn),
  availableModels: vi.fn(() => ({ claude: ['opus', 'haiku'], codex: ['gpt-x'] })),
  startModelRefresh: vi.fn(),
}));
let transcript = { agent: null };
vi.mock('../server/agent-transcripts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  hasClaudeTranscript: vi.fn(() => transcript.agent === 'claude'),
  codexSessionIdFor: vi.fn(() => (transcript.agent === 'codex' ? transcript.id : null)),
}));
// The handover reads transcripts under these homes, never the developer's own.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'a007-bstart-claude-'));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'a007-bstart-codex-'));

const { server, sessions, startBillion, switchBillion } = await import('../server.js');
const { config } = await import('../server/state.js');
const { billionAgentFile } = await import('../server/billion.js');
const { sendText, pendingMessages } = await import('../server/messages.js');

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'a007-bstart-')), 'billion');

beforeEach(() => {
  sessions.clear();
  spawned.length = 0;
  spawnError = null;
  hasClaude = true;
  loggedIn = true;
  modelsIn = true;
  transcript = { agent: null };
  config.repos = [];
  process.env.BILLION_DIR = freshDir();
  delete process.env.BILLION;
  delete process.env.BILLION_AGENT;
  rmSync(billionAgentFile(), { force: true });
});
afterAll(() => { delete process.env.BILLION_DIR; delete process.env.BILLION; delete process.env.BILLION_AGENT; });

describe('startBillion', () => {
  it('first run: makes its folder, introduces itself, and holds its mail', async () => {
    config.repos = [{ path: '/p/projects/a' }, { path: '/p/projects/b' }];
    const { session, error } = (await startBillion());
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

  it('returns the running one instead of starting a second', async () => {
    const first = (await startBillion()).session;
    expect((await startBillion())).toMatchObject({ session: first, existing: true });
    expect(spawned).toHaveLength(1);
  });

  it('replaces a stopped one, continuing its conversation and refreshing an old charter', async () => {
    const old = (await startBillion()).session;
    old.exited = true;
    const dir = process.env.BILLION_DIR;
    writeFileSync(join(dir, 'CHARTER.md'), 'an older charter');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'old'], { cwd: dir });
    transcript = { agent: 'claude' };
    const { session } = (await startBillion());
    expect(session).not.toBe(old);
    expect(sessions.has(old.id)).toBe(false);
    expect([...sessions.values()].filter(s => s.isBillion)).toEqual([session]);
    expect(session.command).toMatch(/--continue/);
    expect(session.command).toMatch(/You were restarted/);
    expect(readFileSync(join(dir, 'CHARTER.md'), 'utf8')).not.toBe('an older charter');
  });

  it('names its CLI and the models in the prompt, or where to read them when discovery is late', async () => {
    const prompt = parseCommand((await startBillion()).session.command).args.at(-1);
    expect(prompt).toContain('You run on Claude Code; a card you post without `agent` goes to the same CLI.');
    expect(prompt).toContain('Models available now: claude: opus, haiku; codex: gpt-x.');
    (await startBillion()).session.exited = true;
    modelsIn = false;
    const late = parseCommand((await startBillion()).session.command).args.at(-1);
    expect(late).toMatch(/model list is not ready yet; read it in .*billion-tools\.json/);
    // The file it points to carries the lists, and says which CLI Billion is.
    const saved = JSON.parse(readFileSync(late.match(/read it in (\S+billion-tools\.json)/)[1], 'utf8'));
    const post = saved.find(t => t.name === 'post_job').inputSchema.properties;
    expect(post.model.description).toContain('codex: gpt-x');
    expect(post.agent.description).toContain('You are running as claude.');
  });

  it('does not continue a Codex transcript', async () => {
    (await startBillion()).session.exited = true;
    transcript = { agent: 'codex' };
    expect((await startBillion()).session.command).not.toMatch(/--continue/);
  });

  it('reports a folder it cannot make, and starts nothing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'a007-bstart-file-')), 'plain');
    writeFileSync(file, 'not a folder');
    process.env.BILLION_DIR = join(file, 'billion');
    const { error } = (await startBillion());
    expect(error).toMatch(/Could not set up Billion's folder/);
    expect(spawned).toHaveLength(0);
    expect(sessions.size).toBe(0);
  });

  it('without claude, its tab says how to install it or turn Billion off', async () => {
    hasClaude = false;
    const { session, notice } = (await startBillion());
    expect(notice).toMatch(/not installed/);
    expect(session.isBillion).toBe(true);
    const { file, args } = parseCommand(session.command);
    expect(file).toBe(process.execPath);
    const out = execFileSync(file, args, { encoding: 'utf8' });
    expect(out).toMatch(/Install it from https:\/\/docs\.anthropic\.com/);
    expect(out).toMatch(/BILLION=0/);
    // Its chat tab says so too: the terminal is gone a second later.
    expect(session.notice).toMatch(/Billion runs on Claude Code, which is not installed/);
    // Start checks again: once claude is there, the real Billion starts.
    session.exited = true;
    hasClaude = true;
    expect((await startBillion()).session.command).toMatch(/^claude /);
  });

  it('passes a spawn failure on, leaving no session behind', async () => {
    spawnError = 'claude: command not found';
    expect((await startBillion())).toEqual({ error: 'claude: command not found' });
    expect(sessions.size).toBe(0);
  });
});

describe('Billion on Codex', () => {
  it('starts codex with its instructions in AGENTS.md, which git ignores', async () => {
    process.env.BILLION_AGENT = 'codex';
    const { session } = (await startBillion());
    expect(session.command).toMatch(/^codex --dangerously-bypass-approvals-and-sandbox /);
    expect(session.command).toMatch(/first run/);
    const dir = process.env.BILLION_DIR;
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain("# Billion's charter");
    expect(agents).toContain("## Owner's rules");
    expect(agents).not.toMatch(/^@CHARTER\.md/m);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe('');
  });

  it('resumes its own Codex session in the folder by id after a restart', async () => {
    process.env.BILLION_AGENT = 'codex';
    (await startBillion()).session.exited = true;
    transcript = { agent: 'codex', id: '019a0000-0000-7000-8000-000000000001' };
    expect((await startBillion()).session.command).toMatch(/^codex resume 019a0000-0000-7000-8000-000000000001 --dangerously-bypass-approvals-and-sandbox "You were restarted/);
  });

  it('without codex, its tab says how to install it', async () => {
    process.env.BILLION_AGENT = 'codex';
    hasClaude = false;
    const { session, notice } = (await startBillion());
    expect(notice).toMatch(/Codex \(codex\) is not installed/);
    const { file, args } = parseCommand(session.command);
    expect(execFileSync(file, args, { encoding: 'utf8' })).toMatch(/Billion runs on Codex/);
  });
});

describe('a logged-out CLI', () => {
  it('puts a notice on Billion saying to sign in in its terminal; clearing it tells the browsers once', async () => {
    loggedIn = false;
    const { session, notice } = (await startBillion());
    expect(notice).toBeUndefined();
    await vi.waitFor(() => expect(session.notice).toMatch(/Claude Code says it is not logged in.*Open Billion's terminal/));
    const { setBillionNotice } = await import('../server/billion.js');
    const sent = [];
    setBillionNotice(session, null, (m) => sent.push(m));
    expect(session.notice).toBeNull();
    expect(sent).toEqual([{ type: 'billion-notice', sessionId: session.id, notice: null }]);
    // Unchanged: nothing sent.
    setBillionNotice(session, null, (m) => sent.push(m));
    expect(sent).toHaveLength(1);
  });

  it('leaves a logged-in one alone, and one whose check did not answer', async () => {
    for (const answer of [true, null]) {
      loggedIn = answer;
      sessions.clear();
      const { session } = (await startBillion());
      await new Promise(r => setTimeout(r, 10));
      expect(session.notice).toBeUndefined();
    }
  });

  it('says nothing when the answer comes after Billion is ready or gone', async () => {
    loggedIn = false;
    const ready = (await startBillion()).session;
    ready.messagesHeld = false;
    sessions.clear();
    const gone = (await startBillion()).session;
    gone.exited = true;
    await new Promise(r => setTimeout(r, 10));
    expect(ready.notice).toBeUndefined();
    expect(gone.notice).toBeUndefined();
  });

  it('drops the sign-in notice when that Billion exits', async () => {
    loggedIn = false;
    const { session } = (await startBillion());
    await vi.waitFor(() => expect(session.notice).toMatch(/not logged in/));
    session.pty.kill();
    expect(session.notice).toBeNull();
  });
});

describe('switchBillion', () => {
  it('writes the handover, stops the old one, saves the choice and starts the other fresh, mail and all', async () => {
    const old = (await startBillion()).session;
    old.messagesHeld = false;
    old.state = 'WORKING';   // so the notice waits in its queue
    sendText(old, '[Job board] a notice');
    transcript = { agent: 'claude' };
    const { session, error } = await switchBillion();
    expect(error).toBeUndefined();
    expect(old.exited).toBe(true);
    expect(session.command).toMatch(/^codex --dangerously-bypass-approvals-and-sandbox /);
    expect(session.command).toMatch(/HANDOVER\.md/);
    expect(session.command).not.toMatch(/ resume /);
    expect(existsSync(join(process.env.BILLION_DIR, 'HANDOVER.md'))).toBe(true);
    expect(JSON.parse(readFileSync(billionAgentFile(), 'utf8')).agent).toBe('codex');
    expect([...sessions.values()].filter(s => s.isBillion && !s.exited)).toEqual([session]);
    expect(pendingMessages(session.id)).toBe(1);
    expect(session.messagesHeld).toBe(true);
    // The saved choice outlives a restart; back again starts claude fresh.
    session.exited = true;
    expect((await startBillion()).session.command).toMatch(/^codex /);
    const back = await switchBillion('claude');
    expect(back.session.command).toMatch(/^claude --dangerously-skip-permissions "You now run on Claude Code/);
    expect(back.session.command).not.toMatch(/--continue/);
  });

  it('refuses a switch to the CLI it already runs on, and an unknown one', async () => {
    (await startBillion());
    expect((await switchBillion('claude')).error).toMatch(/already runs on Claude Code/);
    expect((await switchBillion('gemini')).error).toMatch(/not gemini/);
    expect(spawned).toHaveLength(1);
  });
});

describe('the Start button (billion-start)', () => {
  let url;
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    url = `ws://127.0.0.1:${server.address().port}`;
  });
  // A socket a failed test left open would hold server.close for the whole
  // hook timeout, so every socket goes here and is cut after each test.
  const sockets = [];
  afterEach(() => { sockets.splice(0).forEach(ws => ws.terminate()); });
  afterAll(() => new Promise(r => server.close(r)));

  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const seen = [];
    ws.on('message', (d) => seen.push(JSON.parse(d)));
    // The first message of that type, however long it takes: startBillion runs
    // git synchronously, over vi.waitFor's 1 s on a slow Windows runner.
    const next = (type) => new Promise(r => {
      const check = () => { const m = seen.find(m => m.type === type); if (m) { ws.off('message', check); r(m); } };
      ws.on('message', check);
      check();
    });
    ws.on('open', () => resolve({ ws, seen, next }));
    ws.on('error', reject);
  });
  const settle = () => new Promise(r => setTimeout(r, 200));

  it('starts Billion and focuses it in the window that asked', async () => {
    const { ws, next } = await open();
    ws.send(JSON.stringify({ type: 'billion-start' }));
    expect(await next('session-created')).toMatchObject({ isBillion: true, focus: true, name: 'Billion' });
  });

  it('shows the error when Billion cannot start', async () => {
    spawnError = 'claude: command not found';
    const { ws, next } = await open();
    ws.send(JSON.stringify({ type: 'billion-start' }));
    expect((await next('spawn-error')).error).toBe('claude: command not found');
  });

  it('announces Billion once, however often Start is pressed', async () => {
    const { ws, seen, next } = await open();
    ws.send(JSON.stringify({ type: 'billion-start' }));
    await next('session-created');
    ws.send(JSON.stringify({ type: 'billion-start' }));
    await settle();
    expect(seen.filter(m => m.type === 'session-created' && m.isBillion)).toHaveLength(1);
  });

  it('says why when Billion is turned off, and starts nothing', async () => {
    process.env.BILLION = '0';
    const { ws, seen, next } = await open();
    expect((await next('welcome')).billionEnabled).toBe(false);
    ws.send(JSON.stringify({ type: 'billion-start' }));
    expect((await next('spawn-error')).error).toMatch(/Billion is off/);
    expect(spawned).toHaveLength(0);
    expect(seen.some(m => m.type === 'session-created')).toBe(false);
  });
});
