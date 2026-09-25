// Billion's edges: the trust dialog answered from the pty stream, the approval
// paths that must fall back to "no decision", board notices that cannot be
// delivered, and the tool refusals the route's own checks make.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { config, sessions } = await import('../server/state.js');
const { setupPtyHandlers, createSessionFromConfig } = await import('../server/pty.js');
const { requestApproval, answerApproval, clearApprovals, formatApproval } = await import('../server/approvals.js');
const { sendText, dropMessages, QUEUE_CAP } = await import('../server/messages.js');
const { addJob, boardSettings, notifyBillion, closeJobForAgent } = await import('../server/jobs.js');
const { setupRoutes } = await import('../server/http.js');
const { mintAgentToken } = await import('../server/auth.js');
const { handleMcpMessage } = await import('../server/mcp.js');
const { BILLION_NAME } = await import('../lib/jobs.js');

function fake(name, fields = {}) {
  return {
    id: `be-${name}`, name, command: 'claude', agent: 'claude', state: 'WAITING', exited: false, ownerId: null,
    stateChangedAt: 0, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() }, ...fields,
  };
}
const typed = (s) => s.pty.write.mock.calls.map(c => c[0]).join('');
const request = { tool_name: 'Bash', tool_input: { command: 'npm test' } };

let billion, worker;
beforeEach(() => {
  sessions.clear();
  billion = fake('Billion', { isBillion: true, command: 'claude --dangerously-skip-permissions' });
  worker = fake('Falcon', { approvalsToBillion: true, repoSlug: 'app', branchName: 'fix-login' });
  sessions.set(billion.id, billion);
  sessions.set(worker.id, worker);
});
afterEach(() => {
  clearApprovals();
  for (const s of [billion, worker]) dropMessages(s.id);
  vi.useRealTimers();
});

describe('the trust dialog, answered from the pty stream', () => {
  const NO = 'Do you trust this folder?\r\n❯ No, exit\r\n  Yes, I trust this folder\r\n';
  const YES = 'Do you trust this folder?\r\n  No, exit\r\n❯ Yes, I trust this folder\r\n';
  function open(fields) {
    let onData;
    const session = {
      id: 'bt', pty: { onData: (cb) => { onData = cb; }, onExit: () => {}, write: vi.fn() },
      ringBuffer: { push: () => {} }, state: 'WORKING', lastOutputAt: 0, lastResizeAt: 0,
      lastStrippedLine: '', recentStrippedLines: [], pendingRaw: '', isTUI: true, exited: false,
      createdAt: Date.now(), ...fields,
    };
    setupPtyHandlers(session, 'bt', () => {});
    clearInterval(session.stateCheckInterval);
    return { session, write: (d) => onData(d) };
  }

  it('waits for the drawing to settle, moves off "No" with Ctrl-N, then confirms "Yes" and stops watching', () => {
    vi.useFakeTimers();
    const { session, write } = open({ isBillion: true, answersTrust: true });
    write(NO);
    expect(session.pty.write).not.toHaveBeenCalled();   // not before it settles
    vi.advanceTimersByTime(400);
    expect(session.pty.write.mock.calls.map(c => c[0])).toEqual(['\x0e']);
    write(YES);
    vi.advanceTimersByTime(400);
    expect(session.pty.write.mock.calls.map(c => c[0])).toEqual(['\x0e', '\r']);
    write(NO);                                           // answered for good
    vi.advanceTimersByTime(400);
    expect(session.pty.write).toHaveBeenCalledTimes(2);
  });

  it('gives up after a few keys on a dialog that never changes', () => {
    vi.useFakeTimers();
    const { session, write } = open({ isBillion: true, answersTrust: true });
    for (let i = 0; i < 10; i++) { write(NO); vi.advanceTimersByTime(400); }
    expect(session.pty.write).toHaveBeenCalledTimes(4);
  });

  it('never types into any other session, or one that has exited', () => {
    vi.useFakeTimers();
    const other = open({});
    other.write(NO);
    vi.advanceTimersByTime(400);
    expect(other.session.pty.write).not.toHaveBeenCalled();
    const gone = open({ isBillion: true, answersTrust: true });
    gone.write(NO);
    gone.session.exited = true;
    vi.advanceTimersByTime(400);
    expect(gone.session.pty.write).not.toHaveBeenCalled();
  });

  it('answers for a board worker marked answersTrust, and not for one without it', () => {
    vi.useFakeTimers();
    const trusted = open({ spawnedBy: 'board', answersTrust: true });
    const plain = open({ spawnedBy: 'board' });
    trusted.write(NO); plain.write(NO);
    vi.advanceTimersByTime(400);
    expect(trusted.session.pty.write.mock.calls.map(c => c[0])).toEqual(['\x0e']);
    expect(plain.session.pty.write).not.toHaveBeenCalled();
  });

  it('marks answersTrust on the spawned session for Billion or autoTrust only', () => {
    const cmd = process.platform === 'win32' ? 'cmd /c exit' : 'true';
    const spawn = (extra) => createSessionFromConfig({ sessionId: `bt-${Math.random()}`, name: 'T', color: '#000', command: cmd, ...extra }, () => {});
    const made = [spawn({ autoTrust: true }), spawn({ isBillion: true }), spawn({ spawnedBy: 'board' })];
    try {
      expect(made.map(r => r.session.answersTrust)).toEqual([true, true, false]);
      expect(made.map(r => r.session.isBillion)).toEqual([false, true, false]);   // autoTrust is not Billion
    } finally {
      for (const r of made) { try { r.session.pty.kill(); } catch {} clearInterval(r.session.stateCheckInterval); }
    }
  });
});

describe('approval edges', () => {
  it('describes a request with no card, no tool name, and a huge input', () => {
    const text = formatApproval('ab12', worker, { tool_input: { content: 'x'.repeat(5000) } }, null);
    expect(text.split('\n')[0]).toBe('[Approval ab12] Falcon (app · fix-login) asks to use a tool:');
    expect(text).toMatch(/… \(\d+ characters not shown\) …/);
    expect(text).toMatch(/Cut short: an allow here goes to the owner/);
    expect(formatApproval('ab12', { name: 'Solo' }, {}, null).split('\n')[0]).toBe('[Approval ab12] Solo asks to use a tool:');
  });

  it('refuses a bad decision and keeps the request waiting for a good one', async () => {
    const pending = requestApproval(worker, request);
    const id = typed(billion).match(/\[Approval ([0-9a-f]+)\]/)[1];
    expect(answerApproval(id, 'yes').error).toMatch(/must be "allow", "deny" or "owner"/);
    answerApproval(id, 'deny');
    expect((await pending).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Billion declined this.' });
  });

  it('gives no decision for Billion asking itself, or for no worker', async () => {
    expect(await requestApproval({ ...billion, approvalsToBillion: true }, request)).toEqual({});
    expect(await requestApproval(null, request)).toEqual({});
    expect(billion.pty.write).not.toHaveBeenCalled();
  });

  it('gives no decision at once when Billion\'s queue is full', async () => {
    billion.messagesHeld = false;
    billion.state = 'WORKING';                          // nothing flushes
    for (let i = 0; i < QUEUE_CAP; i++) expect(sendText(billion, `n${i}`)).toBe(true);
    expect(sendText(billion, 'one too many')).toBe(false);
    expect(await requestApproval(worker, request)).toEqual({});
  });

  it('sendText refuses a missing or exited session', () => {
    expect(sendText(null, 'x')).toBe(false);
    expect(sendText({ ...billion, exited: true }, 'x')).toBe(false);
  });
});

describe('notices to Billion', () => {
  const REPO = mkdtempSync(join(tmpdir(), 'a007-be-repo-'));
  beforeEach(() => {
    config.repos = [{ path: REPO }];
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
  });
  const card = (fields) => ({ id: 'j1', title: 'Fix login', repoPath: REPO, postedByAgent: BILLION_NAME, postedByBillion: true, ...fields });

  it('names the pull request and trims a long summary', () => {
    expect(notifyBillion(card({ prUrl: 'https://github.com/o/r/pull/9', resultSummary: 's'.repeat(2000) }))).toBe(true);
    expect(typed(billion)).toContain('> Pull request: https://github.com/o/r/pull/9');
    expect(typed(billion)).toContain('… (read_job for the rest)');
  });

  it('is dropped when no Billion is running', () => {
    billion.exited = true;
    expect(notifyBillion(card({}))).toBe(false);
    sessions.delete(billion.id);
    expect(notifyBillion(card({}))).toBe(false);
  });

  it('close_job itself refuses anyone but Billion, and an unknown card', async () => {
    expect((await closeJobForAgent({ session: worker, id: 'x', accept: true })).error).toMatch(/Only Billion/);
    expect((await closeJobForAgent({ session: billion, id: 'nope', accept: true })).error).toMatch(/No card with id "nope"/);
  });
});

describe('tool replies', () => {
  const callTool = (name, args, ctx) => handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { session: billion, ...ctx }).result;

  it('answer_permission says who now decides', () => {
    expect(callTool('answer_permission', { id: 'a', decision: 'owner' }, { answerPermission: () => ({ worker: 'Falcon', choice: 'owner' }) })
      .content[0].text).toMatch(/Left to the owner: Falcon's dialog/);
    expect(callTool('answer_permission', { id: 'a', decision: 'allow' }, { answerPermission: () => ({ worker: 'Falcon', choice: 'allow' }) })
      .content[0].text).toBe('Falcon has your answer: allow.');
  });

  it('billion_ready with nothing waiting, and add_repo\'s success line', async () => {
    expect(callTool('billion_ready', {}, { billionReady: () => ({ waiting: 0 }) }).content[0].text).toBe('Inbox open. Nothing is waiting.');
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_repo', arguments: { path: '/r/app' } } },
      { session: billion, addRepo: async () => ({ path: '/r/app', slug: 'app' }) });
    expect(r.result.content[0].text).toBe('/r/app is on the board as "app". post_job can use it now.');
  });
});

describe('the routes\' own checks', () => {
  const WORKER_TOKEN = mintAgentToken();
  const BILLION_TOKEN = mintAgentToken();
  const http = createServer((() => { const app = express(); setupRoutes(app, mkdtempSync(join(tmpdir(), 'a007-be-static-')), { broadcast: () => {} }); return app; })());
  let base;
  beforeAll(async () => {
    await new Promise(r => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${http.address().port}`;
  });
  afterAll(() => http.close());
  const post = (path, token, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }).then(r => r.json());
  const tool = (name, args) => post('/mcp', BILLION_TOKEN, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    .then(b => b.result.content[0].text);

  beforeEach(() => {
    worker.agentToken = WORKER_TOKEN;
    billion.agentToken = BILLION_TOKEN;
  });

  it('names the worker\'s card in the approval request', async () => {
    config.jobs = [];
    const { job } = addJob({ title: 'Speed up CI', repoPath: mkdtempSync(join(tmpdir(), 'a007-be-r-')) }, () => {});
    config.repos = [{ path: job.repoPath }];
    worker.jobId = job.id;
    const pending = post('/hook/permission', WORKER_TOKEN, request);
    await vi.waitFor(() => expect(typed(billion)).toContain('(card "Speed up CI", app · fix-login)'));
    clearApprovals();
    expect(await pending).toEqual({});
  });

  it('billion_ready opens the held inbox and counts what is still waiting', async () => {
    billion.messagesHeld = true;
    billion.state = 'WORKING';                          // held mail stays queued
    sendText(billion, 'a');
    sendText(billion, 'b');
    expect(await tool('billion_ready', {})).toMatch(/Inbox open\. 2 message\(s\)/);
    expect(billion.messagesHeld).toBe(false);
  });

  it('add_repo reads ~/ as the home folder, and refuses a relative path', async () => {
    expect(await tool('add_repo', { path: '~/a007-no-such-folder-xyz' })).toBe('Directory does not exist');
    expect(await tool('add_repo', { path: 'projects/app' })).toBe('Path must be absolute');
  });
});
