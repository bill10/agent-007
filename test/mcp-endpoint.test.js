// POST /mcp and POST /api/jobs against a real Express server — the auth
// boundary between a person's token and one agent's session token, and the
// round trip that puts a card on the board.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = mkdtempSync(join(tmpdir(), 'a007-mcprepo-'));
const REPO2 = mkdtempSync(join(tmpdir(), 'a007-mcprepo2-'));
const USERS = join(mkdtempSync(join(tmpdir(), 'a007-mcpusers-')), 'users.json');
process.env.AGENT007_USERS_PATH = USERS;

const { config, sessions } = await import('../server/state.js');
const { setupRoutes } = await import('../server/http.js');
const { allJobs, boardSettings, updateSettings } = await import('../server/jobs.js');
const { mintAgentToken, hashToken } = await import('../server/auth.js');

const AGENT_TOKEN = mintAgentToken();
const broadcasts = [];
let baseUrl;

const server = createServer((() => {
  const app = express();
  setupRoutes(app, mkdtempSync(join(tmpdir(), 'a007-static-')), {
    broadcast: (msg) => broadcasts.push(msg),
  });
  return app;
})());

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
baseUrl = `http://127.0.0.1:${server.address().port}`;

afterAll(() => {
  server.close();
  rmSync(USERS, { force: true });
});

// No users file => auth disabled, which is the default single-player shape.
function noUsers() {
  rmSync(USERS, { force: true });
}

function withUser() {
  const token = 'usertoken-abcdefghijklmnop';
  writeFileSync(USERS, JSON.stringify([
    { id: 'u1', displayName: 'Bill', tokenHash: hashToken(token), color: '#fff' },
  ]));
  return token;
}

beforeEach(() => {
  config.repos = [{ path: REPO }, { path: REPO2 }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
  sessions.set('session-1', {
    id: 'session-1', name: 'Onyx', repoPath: REPO,
    ownerId: null, exited: false, agentToken: AGENT_TOKEN,
  });
  broadcasts.length = 0;
  noUsers();
});

const rpc = (body, token = AGENT_TOKEN) => fetch(`${baseUrl}/mcp`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

const callTool = (args, token = AGENT_TOKEN) => rpc({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'post_job', arguments: args },
}, token);

describe('who may reach /mcp', () => {
  it('turns away a caller with no token, even with auth off', () => {
    // Unlike /api, this endpoint is not relaxed in single-player: the token is
    // not keeping strangers out of loopback, it is the only thing that says
    // WHICH agent is calling. Without it there is nobody to attribute a card to.
    return rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)
      .then(res => expect(res.status).toBe(401));
  });

  it('turns away a token belonging to a session that has exited', async () => {
    sessions.get('session-1').exited = true;
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('turns away a token for a session that is simply gone', async () => {
    sessions.clear();
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('does not accept a user token here', async () => {
    const userToken = withUser();
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, userToken)).status).toBe(401);
  });

  it('rejects a cross-origin call from a browser page', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AGENT_TOKEN}`,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('the handshake over HTTP', () => {
  it('answers initialize and lists the tool', async () => {
    const init = await (await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(init.result.serverInfo.name).toBe('agent-007-board');

    const list = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    expect(list.result.tools.map(t => t.name)).toEqual(['post_job']);
  });

  it('answers a notification with 202 and an empty body', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('rejects an oversized body as JSON with a 413', async () => {
    // A detail longer than the cap is the realistic way to hit this — an agent
    // piping a whole log file into the tool. Express's default handler would
    // answer an API client with an HTML error page.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'post_job', arguments: { title: 'x', detail: 'y'.repeat(200_000) } },
      }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/i);
    expect(allJobs()).toHaveLength(0);
  });

  it('answers a malformed body as JSON, not as an HTML error page', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_TOKEN}` },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid JSON/);
  });
});

describe('posting a job through the tool', () => {
  it('lands a card in To do, credited to the agent that typed it', async () => {
    const res = await callTool({ title: 'Add rate limiting', detail: 'Token bucket.' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(false);

    expect(allJobs()).toHaveLength(1);
    const job = allJobs()[0];
    expect(job.title).toBe('Add rate limiting');
    expect(job.state).toBe('todo');
    expect(job.postedByAgent).toBe('Onyx');
    expect(job.repoPath).toBe(REPO);
  });

  it('defaults to the repo that agent is working in', async () => {
    await callTool({ title: 'No repo named' });
    expect(allJobs()[0].repoPath).toBe(REPO);
  });

  it('reaches another configured repo by folder name', async () => {
    // Deliberate: an agent noticing work elsewhere is the case this exists for.
    await callTool({ title: 'Elsewhere', repo: REPO2.split('/').pop() });
    expect(allJobs()[0].repoPath).toBe(REPO2);
  });

  it('refuses a repo the board does not know, instead of queueing a job that never runs', async () => {
    const body = await (await callTool({ title: 'Nowhere', repo: '/not/a/repo' })).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Unknown repository/);
    expect(allJobs()).toHaveLength(0);
  });

  it('refuses an empty title', async () => {
    const body = await (await callTool({ title: '   ' })).json();
    expect(body.result.isError).toBe(true);
    expect(allJobs()).toHaveLength(0);
  });

  it('does not stringify a non-string title into the card', async () => {
    // This body comes off the wire; {} would otherwise land as "[object Object]".
    const body = await (await callTool({ title: { nope: 1 } })).json();
    expect(body.result.isError).toBe(true);
    expect(allJobs()).toHaveLength(0);
  });

  it('carries postedByAgent out to the client on the board payload', async () => {
    // The seam between the stored job and the rendered card. jobsPayload spreads
    // the job today, but if it ever grows a field whitelist the "via <agent>"
    // credit would vanish silently and both other tests would still pass.
    await callTool({ title: 'Add rate limiting' });
    const payload = broadcasts.find(m => m.type === 'jobs-list');
    expect(payload.jobs[0].postedByAgent).toBe('Onyx');
  });

  it('repaints every open board and announces the card', async () => {
    // The user may be looking at a terminal, not the board tab.
    await callTool({ title: 'Add rate limiting' });
    expect(broadcasts.some(m => m.type === 'jobs-list')).toBe(true);
    const note = broadcasts.find(m => m.type === 'notification');
    expect(note.message).toContain('Onyx posted a job');
  });

  it('warns the agent when the dispatcher is stopped', async () => {
    updateSettings({ running: false }, () => {});
    const body = await (await callTool({ title: 'Queued but idle' })).json();
    expect(body.result.content[0].text).toMatch(/dispatcher is stopped/);
  });

  it('credits the human who owns the terminal', async () => {
    withUser();
    sessions.get('session-1').ownerId = 'u1';
    await callTool({ title: 'On behalf of Bill' });
    const job = allJobs()[0];
    expect(job.postedByName).toBe('Bill');
    expect(job.postedByAgent).toBe('Onyx');
  });
});

describe('POST /api/jobs — the door for agents that cannot take an MCP server', () => {
  const post = (body, token) => fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  it('accepts an agent token and returns the created card', async () => {
    const res = await post({ title: 'From a plain HTTP agent' }, AGENT_TOKEN);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.title).toBe('From a plain HTTP agent');
    expect(body.repoName).toBe(REPO.split('/').pop());
    expect(allJobs()).toHaveLength(1);
  });

  it('rejects a bad repo with a 400 rather than a tool-shaped error', async () => {
    const res = await post({ title: 'x', repo: '/nope' }, AGENT_TOKEN);
    expect(res.status).toBe(400);
  });

  it('needs a credential once users exist', async () => {
    withUser();
    expect((await post({ title: 'x' }, null)).status).toBe(401);
  });
});

describe('the agent token reaches nothing else', () => {
  it('cannot browse the filesystem', async () => {
    // The gate ordering is the access-control decision: /api/browse sits below
    // requireUser, so an agent token is identified and then refused. If this
    // ever returns 200, a route has drifted above the gate.
    withUser();
    const res = await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/needs a user token/);
  });

  it('still tells an anonymous caller they are unauthenticated, not forbidden', async () => {
    withUser();
    expect((await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`)).status).toBe(401);
  });

  it('lets a real user through', async () => {
    const userToken = withUser();
    const res = await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);
  });
});
