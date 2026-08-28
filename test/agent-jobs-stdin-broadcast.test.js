// Two paths through POST /api/jobs and the agent-007-job CLI that
// test/agent-jobs-api.test.js does not reach:
//
//  1. The CLI's documented main use case — `git log ... | agent-007-job "..."`
//     — piping real detail through stdin. The existing CLI test only covers
//     an idle pipe that times out; the actual read-and-use-it path
//     (readStdin's `for await` loop and Buffer.concat) is otherwise untested.
//  2. The WS notification broadcast to other open tabs when an agent posts a
//     job (server/http.js), so a user watching a terminal sees the card land
//     without switching to the board.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { server, sessions } from '../server.js';
import { config } from '../server/state.js';
import { allJobs } from '../server/jobs.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import WebSocket from 'ws';

const PORT = 17019;
let baseUrl, wsUrl;
let repoPath;

function fakeSession(id, overrides = {}) {
  const session = {
    id, name: 'Mirage', exited: false, repoPath,
    agentToken: `a007a_${id}_token`, ownerId: null, ...overrides,
  };
  sessions.set(id, session);
  return session;
}

beforeAll(async () => {
  repoPath = mkdtempSync(join(tmpdir(), 'a007-repo-'));
  config.repos = [{ path: repoPath }];
  config.jobs = [];
  server.listen(PORT, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${PORT}`;
  wsUrl = `ws://127.0.0.1:${PORT}`;
});

afterAll(async () => {
  sessions.clear();
  try { rmSync(repoPath, { recursive: true, force: true }); } catch {}
  await new Promise(r => server.close(r));
});

beforeEach(() => { config.jobs = []; sessions.clear(); });

describe('agent-007-job reads real piped stdin', () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-cli', 'agent-007-job');

  function runCliWithStdin(args, stdinText, token) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, AGENT007_URL: baseUrl, ...(token ? { AGENT007_TOKEN: token } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(stdinText);
    });
  }

  it('uses piped stdin as the detail when --detail is not given', async () => {
    fakeSession('session-stdin');
    const { code } = await runCliWithStdin(
      ['Follow up on the last commit'],
      'fix: handle empty repo list\n\nSee TODOS.md for the rest.\n',
      'a007a_session-stdin_token',
    );
    expect(code).toBe(0);
    const [job] = allJobs();
    // Trimmed: readStdin() trims trailing/leading whitespace from the pipe.
    expect(job.detail).toBe('fix: handle empty repo list\n\nSee TODOS.md for the rest.');
  });

  it('prefers an explicit --detail over piped stdin when both are given', async () => {
    fakeSession('session-stdin2');
    const { code } = await runCliWithStdin(
      ['Explicit wins', '--detail', 'From the flag'],
      'From the pipe, should be ignored',
      'a007a_session-stdin2_token',
    );
    expect(code).toBe(0);
    const [job] = allJobs();
    expect(job.detail).toBe('From the flag');
  });

  it('fails clearly, not with a stack trace, when the board is unreachable', async () => {
    // No server listens here — the fetch() itself rejects (ECONNREFUSED),
    // exercising the catch block around the request, which none of the
    // existing CLI tests reach (they all talk to a live server, or one that
    // accepts the connection and replies badly).
    const child = spawn(process.execPath, [CLI, 'Nobody home'], {
      env: { ...process.env, AGENT007_URL: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).toBe(1);
    expect(stderr).toMatch(/could not reach the job board/i);
    expect(stderr).toMatch(/is agent 007 still running/i);
  });
});

describe('POST /api/jobs broadcasts a notification for an agent-posted card', () => {
  const connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const nextMatching = (ws, pred, timeoutMs = 4000) => new Promise((resolve) => {
    const to = setTimeout(() => { ws.off('message', h); resolve(null); }, timeoutMs);
    const h = (d) => { const m = JSON.parse(d); if (pred(m)) { clearTimeout(to); ws.off('message', h); resolve(m); } };
    ws.on('message', h);
  });

  it('tells an open tab which agent queued the card, without the user touching the board', async () => {
    const client = await connect();
    fakeSession('session-notify');
    const note = nextMatching(client, m => m.type === 'notification' && /Mirage/.test(m.message || ''));
    const res = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer a007a_session-notify_token' },
      body: JSON.stringify({ title: 'Add rate limiting' }),
    });
    expect(res.status).toBe(201);
    const payload = await note;
    expect(payload).toBeTruthy();
    expect(payload.message).toContain('Mirage');
    expect(payload.message).toContain('Add rate limiting');
    client.close();
  });
});
