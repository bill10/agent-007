// What a spawned agent inherits from the server: its environment without
// Agent 007's own settings (lib/helpers.js, ptyEnv), and for a board worker on
// Claude Code, no channel plugins (server/agent-mcp.js, withBoardWorkerSettings).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

const spawn = vi.fn(() => ({ pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }));
vi.mock('node-pty', () => ({ spawn }));
vi.mock('../server/command-path.js', async (orig) => ({
  ...(await orig()), commandExists: () => true, resolveExecutable: (f) => f,
}));

const { createSessionFromConfig } = await import('../server/pty.js');
const { setCodexHookHash, mcpConfigPath } = await import('../server/agent-mcp.js');

const SECRETS = { TELEGRAM_BOT_TOKEN: '123:fake', TELEGRAM_CHAT_ID: '42', WHISPER_MODEL: '/m.bin', SAY_VOICE: 'Ava' };
const KEPT = { CODEX_HOME: '/tmp/codex-home', CLAUDE_CONFIG_DIR: '/tmp/claude-config' };

let n = 0;
function spawnWith(fields) {
  const result = createSessionFromConfig({ sessionId: `env-${++n}`, name: 'Falcon', color: 'red', command: 'claude', cwd: tmpdir(), ...fields });
  clearInterval(result.session?.stateCheckInterval);
  const [, args, opts] = spawn.mock.calls.at(-1);
  return { args, env: opts.env };
}
const settingsOf = (args) => (args.includes('--settings') ? JSON.parse(args[args.indexOf('--settings') + 1]) : null);

beforeEach(() => { Object.assign(process.env, SECRETS, KEPT); spawn.mockClear(); });
afterEach(() => { for (const k of Object.keys({ ...SECRETS, ...KEPT })) delete process.env[k]; });

// The spawns server.js and server/ws.js make, by the fields that tell them apart.
const PATHS = {
  'a board dispatch': { spawnedBy: 'board', jobId: 'j1', autoTrust: true },
  "a dispatch of Billion's card": { spawnedBy: 'board', jobId: 'j1', approvalsToBillion: true },
  'a re-spawned board worker': { spawnedBy: 'user', origin: 'board' },
  'the + Agent form': { spawnedBy: 'user' },
  'Billion (and a Billion switch)': { isBillion: true },
  'Billion on Codex': { isBillion: true, command: 'codex' },
};

describe('the environment a spawned agent gets', () => {
  for (const [path, fields] of Object.entries(PATHS)) {
    it(`has none of the server's settings: ${path}`, () => {
      const { env } = spawnWith(fields);
      for (const key of Object.keys(SECRETS)) expect(env).not.toHaveProperty(key);
      expect(Object.keys(env).filter(k => k.startsWith('AGENT007_'))).toEqual([]);
      expect(env).toMatchObject(KEPT);
      expect(env.HOME ?? env.USERPROFILE).toBeTruthy();
      expect(env.PATH ?? env.Path).toBeTruthy();
    });
  }

  it('comes from one spawn call, which scrubs it', () => {
    const users = readdirSync('server').filter(f => readFileSync(`server/${f}`, 'utf8').includes("from 'node-pty'"));
    expect(users).toEqual(['pty.js']);
    const calls = readFileSync('server/pty.js', 'utf8').match(/spawnPty\([^]*?\}\);/g);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('env: { ...ptyEnv(process.env), ...hookEnv }');
  });
});

describe('a Codex worker on Billion\'s card', () => {
  const fields = { spawnedBy: 'board', jobId: 'j1', approvalsToBillion: true, command: 'codex' };
  afterEach(() => setCodexHookHash(null));

  it('names its own MCP config to the hook, and gets the hook, once the hash is known', () => {
    setCodexHookHash(`sha256:${'d'.repeat(64)}`);
    const { args, env } = spawnWith(fields);
    expect(args.some(a => a.startsWith('hooks.PermissionRequest='))).toBe(true);
    expect(env.AGENT007_HOOK_CONFIG).toBe(mcpConfigPath(`env-${n}`));
  });

  it('gets neither without it, and asks the owner', () => {
    const { args, env } = spawnWith(fields);
    expect(args.some(a => a.startsWith('hooks.'))).toBe(false);
    expect(env).not.toHaveProperty('AGENT007_HOOK_CONFIG');
  });
});

describe('channel plugins', () => {
  it('are off in a Claude Code board worker, fresh or re-spawned, hooked or not', () => {
    for (const fields of [PATHS['a board dispatch'], PATHS["a dispatch of Billion's card"], PATHS['a re-spawned board worker']]) {
      const settings = settingsOf(spawnWith(fields).args);
      expect(settings.enabledPlugins['telegram@claude-plugins-official']).toBe(false);
    }
    // The hooked one keeps its hook in the same --settings.
    expect(settingsOf(spawnWith(PATHS["a dispatch of Billion's card"]).args).hooks).toBeTruthy();
  });

  it('are left alone for hand-started agents, Billion and Codex', () => {
    expect(settingsOf(spawnWith(PATHS['the + Agent form']).args)).toBeNull();
    expect(settingsOf(spawnWith(PATHS['Billion (and a Billion switch)']).args)).toBeNull();
    expect(spawnWith({ ...PATHS['a board dispatch'], command: 'codex' }).args).not.toContain('--settings');
  });
});

describe('input to a Windows terminal', () => {
  it('drops a failed write instead of throwing it at the process', () => {
    // node-pty on Windows writes input through this socket and never listens
    // for its errors; an unheard 'error' emit throws, as the real one would.
    const inSocket = new EventEmitter();
    spawn.mockReturnValueOnce({ pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, _agent: { inSocket } });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnWith({});
    expect(() => inSocket.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }))).not.toThrow();
    expect(quiet).toHaveBeenCalledWith('Input to "Falcon" was dropped: write EAGAIN');
    quiet.mockRestore();
  });
});
