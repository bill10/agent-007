// Billion answers workers' permission dialogs (docs/BILLION.md, part 4). The
// rule everything here protects: only Billion's explicit answer ever reaches
// the worker as allow or deny; anything else — no Billion, silence, an error —
// is "no decision", and the dialog goes to a person.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const { config, sessions } = await import('../server/state.js');
const { setupRoutes } = await import('../server/http.js');
const { requestApproval, answerApproval, clearApprovals, APPROVAL_WAIT_MS } = await import('../server/approvals.js');
const { dropMessages } = await import('../server/messages.js');
const { withApprovalHook } = await import('../server/agent-mcp.js');
const { mintAgentToken } = await import('../server/auth.js');
const { addJob, dispatchOnce, boardSettings } = await import('../server/jobs.js');
const { BILLION_NAME } = await import('../lib/jobs.js');

const HOOK = fileURLToPath(new URL('../server/permission-hook.js', import.meta.url));

function fake(name, fields = {}) {
  return {
    id: `ap-${name}`, name, command: 'claude', agent: 'claude', state: 'WAITING', exited: false, ownerId: null,
    stateChangedAt: 0, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() }, ...fields,
  };
}
const typed = (s) => s.pty.write.mock.calls.map(c => c[0]).join('');
const request = { tool_name: 'Write', tool_input: { file_path: '/elsewhere/x.txt', content: 'hi' } };

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

const idOf = (s) => typed(s).match(/\[Approval ([0-9a-f]+)\]/)[1];

describe('asking Billion', () => {
  it('types the request into Billion, and returns its allow', async () => {
    const answer = requestApproval(worker, request, { jobTitle: 'Fix login' });
    expect(typed(billion)).toContain('Falcon (card "Fix login", app · fix-login) asks to use Write:');
    expect(typed(billion)).toContain('>   "file_path": "/elsewhere/x.txt",');
    expect(answerApproval(idOf(billion), 'allow')).toEqual({ worker: 'Falcon', choice: 'allow', cut: false });
    expect(await answer).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('passes a deny on with Billion\'s reason', async () => {
    const answer = requestApproval(worker, request);
    answerApproval(idOf(billion), 'deny', 'Write inside your worktree.');
    expect((await answer).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Write inside your worktree.' });
  });

  it('gives no decision when Billion leaves it to the owner', async () => {
    const left = requestApproval(worker, request);
    answerApproval(idOf(billion), 'owner');
    expect(await left).toEqual({});
  });

  it('gives no decision when Billion stays silent, and turns away a late answer', async () => {
    vi.useFakeTimers();
    const silent = requestApproval(worker, request);
    const id = idOf(billion);
    vi.advanceTimersByTime(APPROVAL_WAIT_MS);
    expect(await silent).toEqual({});
    expect(answerApproval(id, 'allow').error).toMatch(/ran out of time/);
  });

  it('never asks a Billion that is missing, stopped, or still introducing itself', async () => {
    billion.messagesHeld = true;
    expect(await requestApproval(worker, request)).toEqual({});
    billion.messagesHeld = false;
    billion.exited = true;
    expect(await requestApproval(worker, request)).toEqual({});
    sessions.delete(billion.id);
    expect(await requestApproval(worker, request)).toEqual({});
  });

  it('answers only for workers hooked to Billion', async () => {
    expect(await requestApproval(fake('Viper'), request)).toEqual({});
    expect(billion.pty.write).not.toHaveBeenCalled();
  });
});

describe('the hook in the worker\'s command line', () => {
  it('goes into a Claude Code worker, pointing at its own MCP config', () => {
    const args = withApprovalHook('claude', ['--permission-mode', 'auto', 'do it'], '/cfg/s1.json');
    expect(args[0]).toBe('--settings');
    const hook = JSON.parse(args[1]).hooks.PermissionRequest[0].hooks[0];
    expect(hook.command).toContain('permission-hook.js" "/cfg/s1.json"');
    expect(hook.timeout * 1000).toBeGreaterThan(APPROVAL_WAIT_MS);
    // Its own instructions need no one's permission.
    expect(JSON.parse(args[1]).permissions.allow).toEqual(['mcp__agent-007-board__finish_job', 'mcp__agent-007-board__send_message']);
    expect(args.slice(2)).toEqual(['--permission-mode', 'auto', 'do it']);
  });

  it('stays out of Codex, and out of a command with its own --settings', () => {
    // The same array, not a copy: pty.js records "hooked" by identity.
    const codex = ['x'];
    expect(withApprovalHook('codex', codex, '/cfg/s1.json')).toBe(codex);
    const own = ['--settings', '{}'];
    expect(withApprovalHook('claude', own, '/cfg/s1.json')).toBe(own);
  });

  it('is asked for on Billion\'s cards only', async () => {
    // One repo per card, so the per-repo limit dispatches all three.
    config.repos = [1, 2, 3].map(() => ({ path: mkdtempSync(join(tmpdir(), 'a007-ap-repo-')) }));
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
    sessions.clear();
    const cards = [BILLION_NAME, 'Viper', undefined].map((postedByAgent, i) =>
      addJob({ title: `Card ${i}`, repoPath: config.repos[i].path, postedByAgent, postedByBillion: i === 0 }, () => {}).job);
    const metas = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      metas.push(meta);
      const s = fake(`w${metas.length}`, { repoPath, jobId: meta.jobId });
      sessions.set(s.id, s);
      return { session: s };
    }, () => {});
    const hooked = Object.fromEntries(metas.map(m => [m.jobId, m.approvalsToBillion]));
    expect(cards.map(c => hooked[c.id])).toEqual([true, false, false]);
  });
});

describe('the hook script', () => {
  const run = (configPath, stdin) => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, configPath]);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => resolve(out));
    child.stdin.end(stdin);
  });
  let reply = {};
  let seen = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  const cfg = join(mkdtempSync(join(tmpdir(), 'a007-ap-cfg-')), 's.json');
  beforeAll(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    writeFileSync(cfg, JSON.stringify({ mcpServers: { 'agent-007-board': {
      url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'Bearer tok' } } } }));
  });
  afterAll(() => server.close());

  it('posts the request with the worker\'s token and prints a real answer', async () => {
    reply = { body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } };
    const out = await run(cfg, JSON.stringify(request));
    expect(seen).toEqual({ url: '/hook/permission', auth: 'Bearer tok', body: request });
    expect(JSON.parse(out).hookSpecificOutput.decision.behavior).toBe('allow');
  });

  it('prints nothing — no decision — for anything else', async () => {
    for (const r of [{ body: {} }, { status: 500, body: { hookSpecificOutput: { decision: { behavior: 'allow' } } } }, { body: 'not json' },
      { body: { hookSpecificOutput: { decision: { behavior: 'maybe' } } } }]) {
      reply = r;
      expect(await run(cfg, JSON.stringify(request))).toBe('');
    }
    expect(await run('/no/such/config.json', JSON.stringify(request))).toBe('');
  });
});

describe('POST /hook/permission and answer_permission', () => {
  const WORKER_TOKEN = mintAgentToken();
  const BILLION_TOKEN = mintAgentToken();
  const app = express();
  setupRoutes(app, mkdtempSync(join(tmpdir(), 'a007-ap-static-')), { broadcast: () => {} });
  const http = createServer(app);
  let base;
  beforeAll(async () => {
    await new Promise(r => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${http.address().port}`;
  });
  afterAll(() => http.close());
  const post = (path, token, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }).then(r => r.json());
  const answer = (token, args) => post('/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'answer_permission', arguments: args } });

  it('holds the worker\'s request until Billion answers over MCP', async () => {
    worker.agentToken = WORKER_TOKEN;
    billion.agentToken = BILLION_TOKEN;
    const pending = post('/hook/permission', WORKER_TOKEN, request);
    await vi.waitFor(() => expect(typed(billion)).toContain('[Approval '));
    const id = idOf(billion);
    expect((await answer(WORKER_TOKEN, { id, decision: 'allow' })).error.message).toMatch(/Unknown tool/);
    expect((await answer(BILLION_TOKEN, { id, decision: 'deny', reason: 'Not this card.' })).result.isError).toBe(false);
    expect((await pending).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Not this card.' });
  });

  it('refuses a request without an agent token', async () => {
    const res = await fetch(`${base}/hook/permission`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.ok).toBe(false);
  });
});
