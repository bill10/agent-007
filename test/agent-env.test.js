// The environment an agent terminal is spawned with. This is the whole
// discovery mechanism for agent-posted jobs: if `agent-007-job` is not on PATH
// with a URL and a token beside it, asking an agent to queue a job fails with
// "command not found".

import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, statSync } from 'fs';
import { delimiter, join } from 'path';
import { agentEnv, boardBaseUrl, AGENT_CLI_DIR } from '../server/agent-env.js';
import { mintAgentToken, resolveAgentToken } from '../server/auth.js';
import { sessions } from '../server/state.js';

describe('agentEnv', () => {
  const env = agentEnv({
    sessionId: 'session-3', name: 'Mirage', agentToken: 'a007a_x',
    repoPath: '/code/app', worktreePath: '/wt/mirage', branchName: 'bill/vesper',
  });

  it('puts the job CLI first on PATH without dropping the inherited one', () => {
    expect(env.PATH.startsWith(AGENT_CLI_DIR + delimiter)).toBe(true);
    expect(env.PATH).toContain(process.env.PATH);
  });

  it('ships the CLI as an executable file in that directory', () => {
    const cli = join(AGENT_CLI_DIR, 'agent-007-job');
    expect(existsSync(cli)).toBe(true);
    // Mode 0o111: PATH lookup skips a file that is not executable, and losing
    // the bit in a checkout is silent until an agent tries to use it.
    if (process.platform !== 'win32') expect(statSync(cli).mode & 0o111).toBeGreaterThan(0);
  });

  it('carries the address, the token and who is calling', () => {
    expect(env.AGENT007_URL).toBe(boardBaseUrl());
    expect(env.AGENT007_TOKEN).toBe('a007a_x');
    expect(env.AGENT007_SESSION_ID).toBe('session-3');
    expect(env.AGENT007_AGENT_NAME).toBe('Mirage');
    expect(env.AGENT007_REPO).toBe('/code/app');
    expect(env.AGENT007_WORKTREE).toBe('/wt/mirage');
    expect(env.AGENT007_BRANCH).toBe('bill/vesper');
  });

  it('keeps the inherited environment and the terminal type', () => {
    expect(env.TERM).toBe('xterm-256color');
    expect(env.HOME ?? env.USERPROFILE).toBeDefined();
  });

  it('leaves a session with no repo blank rather than undefined', () => {
    const bare = agentEnv({ sessionId: 'session-4' });
    expect(bare.AGENT007_REPO).toBe('');
    expect(bare.AGENT007_BRANCH).toBe('');
  });
});

describe('boardBaseUrl', () => {
  // state.js reads HOST/PORT at module load, so re-import per case (same
  // pattern as test/origin.test.js).
  afterEach(() => { delete process.env.HOST; vi.resetModules(); });
  async function load(host) {
    if (host === undefined) delete process.env.HOST; else process.env.HOST = host;
    vi.resetModules();
    return (await import('../server/agent-env.js')).boardBaseUrl;
  }

  it('is a loopback http URL on the configured port', () => {
    // Default test env: HOST unset -> 127.0.0.1.
    expect(boardBaseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('sends a wildcard bind to loopback, keeping the token off the network', async () => {
    expect((await load('0.0.0.0'))()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await load('::'))()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('brackets an IPv6 bind so the URL parses', async () => {
    expect((await load('::1'))()).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  it('uses a specific bind address as-is — loopback may not be listening there', async () => {
    expect((await load('100.64.0.7'))()).toMatch(/^http:\/\/100\.64\.0\.7:\d+$/);
  });
});

describe('agent session tokens', () => {
  it('mints distinct tokens and resolves one back to its live session', () => {
    const a = mintAgentToken();
    const b = mintAgentToken();
    expect(a).not.toBe(b);
    sessions.set('session-7', { id: 'session-7', agentToken: a, exited: false });
    expect(resolveAgentToken(a).id).toBe('session-7');
    expect(resolveAgentToken(b)).toBeNull();
    expect(resolveAgentToken('')).toBeNull();
    sessions.clear();
  });

  it('stops resolving once the session has exited', () => {
    const token = mintAgentToken();
    sessions.set('session-8', { id: 'session-8', agentToken: token, exited: true });
    expect(resolveAgentToken(token)).toBeNull();
    sessions.clear();
  });
});
