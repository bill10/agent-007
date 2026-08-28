// POST /api/jobs — the door the `agent-007-job` CLI knocks on, so that "add
// that to the job board" is something you can ask the agent you are already
// talking to.
//
// Runs the real server: the interesting behaviour is the middleware chain
// (origin -> auth -> JSON body) and how an agent's session token is resolved
// back to a repo and an attribution, none of which exists below Express.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { server, sessions } from '../server.js';
import { hashToken } from '../server/auth.js';
import { config } from '../server/state.js';
import { allJobs } from '../server/jobs.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createServer } from 'http';

const PORT = 17017;
let baseUrl;
let repoPath;

function post(body, { token, origin } = {}) {
  return fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// A stand-in for a live agent terminal. The real one comes from
// createSessionFromConfig, which would need a PTY; all this route cares about
// is the token, the repo, the name and whether the session is still alive.
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
});

afterAll(async () => {
  sessions.clear();
  try { rmSync(repoPath, { recursive: true, force: true }); } catch {}
  await new Promise(r => server.close(r));
});

beforeEach(() => { config.jobs = []; sessions.clear(); });

describe('POST /api/jobs', () => {
  it('queues a card in To do, attributed to the calling agent', async () => {
    fakeSession('session-1');
    const res = await post({ title: 'Add rate limiting', detail: 'Token bucket.' }, { token: 'a007a_session-1_token' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.title).toBe('Add rate limiting');
    expect(body.job.state).toBe('todo');
    // The agent's own repo is the default, so a caller only names one when it
    // means a different repo.
    expect(body.job.repoPath).toBe(repoPath);
    expect(body.job.postedByAgent).toBe('Mirage');
    // The CLI tells the agent whether the board will act on the card.
    expect(typeof body.dispatcherRunning).toBe('boolean');
    expect(allJobs()).toHaveLength(1);
  });

  it('accepts a repo by folder name or full path, and refuses an unknown one', async () => {
    const name = repoPath.split('/').pop();
    expect((await (await post({ title: 'By name', repo: name })).json()).job.repoPath).toBe(repoPath);
    expect((await (await post({ title: 'By path', repo: repoPath })).json()).job.repoPath).toBe(repoPath);

    const res = await post({ title: 'Nowhere', repo: '/not/a/repo' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown repository/i);
    expect(allJobs()).toHaveLength(2);
  });

  it('refuses a job with no title and one with no repo to run in', async () => {
    const noTitle = await post({ title: '   ', repo: repoPath });
    expect(noTitle.status).toBe(400);
    expect((await noTitle.json()).error).toMatch(/title/i);

    // No session (so no default repo) and no --repo: the CLI is told which
    // repos exist rather than being left to guess.
    const noRepo = await post({ title: 'Where?' });
    expect(noRepo.status).toBe(400);
    expect((await noRepo.json()).error).toMatch(/which repository/i);
  });

  it('answers a malformed body with JSON, not an HTML error page', async () => {
    const res = await post('{not json', {});
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect((await res.json()).error).toMatch(/invalid json/i);
  });

  it('answers an oversized body with JSON too, not an HTML error page', async () => {
    // Reachable from the CLI: --detail (or piped stdin) is arbitrary length.
    const res = await post({ title: 'Huge', repo: repoPath, detail: 'x'.repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect((await res.json()).error).toMatch(/too large/i);
    expect(allJobs()).toHaveLength(0);
  });

  it('is behind the same cross-origin gate as the rest of /api', async () => {
    const res = await post({ title: 'From a website', repo: repoPath }, { origin: 'http://evil.example.com' });
    expect(res.status).toBe(403);
    expect(allJobs()).toHaveLength(0);
  });
});

// --- With auth on ---
// Same live-enable trick as server.test.js: write users.json at the throwaway
// path so the already-running server picks it up, then remove it.

describe('POST /api/jobs with auth enabled', () => {
  const usersPath = process.env.AGENT007_USERS_PATH;
  const userToken = 'tok_' + Math.random().toString(36).slice(2, 12);

  beforeAll(() => {
    writeFileSync(usersPath, JSON.stringify([
      { id: 'u_test', displayName: 'Tester', color: '#d4a847', tokenHash: hashToken(userToken) },
    ]));
  });
  afterAll(() => { try { rmSync(usersPath, { force: true }); } catch {} });

  it('rejects an anonymous post', async () => {
    const res = await post({ title: 'Anonymous', repo: repoPath });
    expect(res.status).toBe(401);
    expect(allJobs()).toHaveLength(0);
  });

  it('accepts a user token and credits the user', async () => {
    const res = await post({ title: 'From the user', repo: repoPath }, { token: userToken });
    expect(res.status).toBe(201);
    const { job } = await res.json();
    expect(job.postedBy).toBe('u_test');
    expect(job.postedByName).toBe('Tester');
    expect(job.postedByAgent).toBeNull();
  });

  it('accepts a live agent token and credits both the agent and its owner', async () => {
    fakeSession('session-9', { ownerId: 'u_test' });
    const res = await post({ title: 'From the agent' }, { token: 'a007a_session-9_token' });
    expect(res.status).toBe(201);
    const { job } = await res.json();
    expect(job.postedByAgent).toBe('Mirage');
    expect(job.postedByName).toBe('Tester');
  });

  it("stops honouring an agent's token once its terminal is gone", async () => {
    fakeSession('session-10', { exited: true });
    const res = await post({ title: 'From a dead agent' }, { token: 'a007a_session-10_token' });
    expect(res.status).toBe(401);
    expect(allJobs()).toHaveLength(0);
  });

  it('accepts an agent token only in the Authorization header, never in the URL', async () => {
    fakeSession('session-12');
    // ?token= lands in every proxy/access log between the browser and here; the
    // user token needs it for the WS handshake, an agent token never does.
    const res = await fetch(`${baseUrl}/api/jobs?token=a007a_session-12_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Via the URL', repo: repoPath }),
    });
    expect(res.status).toBe(401);
    expect(allJobs()).toHaveLength(0);
  });

  it('does not let an agent token reach a user-only endpoint', async () => {
    fakeSession('session-11');
    const res = await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`, {
      headers: { Authorization: 'Bearer a007a_session-11_token' },
    });
    expect(res.status).toBe(403);
  });
});


// --- The CLI against the live server ---
// The parser has unit tests (test/job-cli.test.js); this covers the wiring an
// agent actually exercises: argv -> env -> HTTP -> a card on the board.

describe('agent-007-job end to end', () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-cli', 'agent-007-job');

  // stdinMode 'idle' hands the CLI a pipe that never closes and never sends —
  // what an agent harness can do. The command must still finish.
  function runCli(args, { token, stdinMode = 'ignore', url } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: {
          ...process.env,
          AGENT007_URL: url || baseUrl,
          ...(token ? { AGENT007_TOKEN: token } : {}),
        },
        stdio: [stdinMode === 'idle' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  }

  it('posts a card and reports where it landed', async () => {
    fakeSession('session-cli');
    const { code, stdout } = await runCli(['Posted from the CLI', '--detail', 'With a body.'], { token: 'a007a_session-cli_token' });
    expect(code).toBe(0);
    expect(stdout).toContain('Posted "Posted from the CLI"');
    const [job] = allJobs();
    expect(job.detail).toBe('With a body.');
    expect(job.postedByAgent).toBe('Mirage');
  });

  it('finishes even when stdin is a pipe that never closes', async () => {
    fakeSession('session-cli2');
    const { code, stdout, stderr } = await runCli(['Idle stdin'], { token: 'a007a_session-cli2_token', stdinMode: 'idle' });
    // Without the read timeout (and the destroy that releases the handle) this
    // hangs forever, and the agent that ran it hangs with it.
    expect(code).toBe(0);
    expect(stderr).toMatch(/nothing arrived on stdin/i);
    expect(stdout).toContain('Idle stdin');
    expect(allJobs()).toHaveLength(1);
  }, 15_000);

  it('exits non-zero and says why when the server refuses', async () => {
    // No session token and no --repo: the server cannot guess a repo.
    const { code, stderr } = await runCli(['Nowhere to run']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/which repository/i);
    expect(allJobs()).toHaveLength(0);
  });

  it('does not claim success when an accepted request comes back unreadable', async () => {
    // A server that commits the job, then dies before the body is flushed. The
    // old failure here was a stack trace, which reads as "it failed" and gets
    // the agent to post the same work a second time.
    const flaky = createServer((req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"job":');
    });
    await new Promise(r => flaky.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${flaky.address().port}`;
    try {
      const { code, stderr } = await runCli(['Half an answer'], { url });
      expect(code).toBe(1);
      expect(stderr).toMatch(/could not be read/i);
      expect(stderr).toMatch(/check the board/i);
      expect(stderr).not.toMatch(/TypeError|at Object|\bstack\b/);
    } finally {
      await new Promise(r => flaky.close(r));
    }
  });

  it('exits 2 on a usage error without touching the board', async () => {
    const { code, stderr } = await runCli(['--detail', 'body only']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/title/i);
    expect(allJobs()).toHaveLength(0);
  });
});
