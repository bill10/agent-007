// POST /mcp and POST /api/jobs against a real Express server — the auth
// boundary between a person's token and one agent's session token, and the
// round trip that puts a card on the board.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

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

const callNamed = (name, args, token = AGENT_TOKEN) => rpc({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name, arguments: args },
}, token);

const callTool = (args, token = AGENT_TOKEN) => callNamed('post_job', args, token);

// What an agent actually reads back: the text, and whether it was a refusal.
// One read of the body — a Response can only be consumed once.
const toolResult = async (res) => {
  const { result } = await res.json();
  return { text: result.content[0].text, failed: result.isError };
};
const toolText = async (res) => (await toolResult(res)).text;

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
    expect(list.result.tools.map(t => t.name)).toEqual(['post_job', 'list_jobs', 'read_job', 'edit_job']);
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
    await callTool({ title: 'Elsewhere', repo: basename(REPO2) });
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
    expect(body.repoName).toBe(basename(REPO));
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

describe('reading and editing the board through the tools', () => {
  // The ids are generated, so every test here starts by posting through the
  // same door an agent would and reading the id back off the board.
  const post = async (args) => {
    await callTool(args);
    return allJobs()[allJobs().length - 1];
  };

  it('lists the board grouped by column, with the id needed to act on a card', async () => {
    const todo = await post({ title: 'Add rate limiting' });
    const running = await post({ title: 'Already going' });
    running.state = 'in-progress';
    running.agentName = 'Slate';

    const text = await toolText(await callNamed('list_jobs', {}));
    expect(text).toMatch(/2 card\(s\)/);
    expect(text).toMatch(/To do \(1\)[\s\S]*Add rate limiting/);
    expect(text).toMatch(/In progress \(1\)[\s\S]*Already going/);
    expect(text).toContain(todo.id);
    expect(text).toContain('Slate');
  });

  it('leaves finished cards off the board but says they are there', async () => {
    const done = await post({ title: 'Long since merged' });
    done.state = 'done';

    const board = await toolText(await callNamed('list_jobs', {}));
    expect(board).not.toContain('Long since merged');
    expect(board).toMatch(/1 finished card\(s\) are archived/);

    const archive = await toolText(await callNamed('list_jobs', { state: 'done' }));
    expect(archive).toContain('Long since merged');
  });

  it('filters by repo, by folder name, the way posting does', async () => {
    await post({ title: 'Here' });
    await post({ title: 'Elsewhere', repo: basename(REPO2) });
    const text = await toolText(await callNamed('list_jobs', { repo: basename(REPO2) }));
    expect(text).toContain('Elsewhere');
    expect(text).not.toContain('Here');
  });

  it('refuses a state that is not a column, rather than answering with nothing', async () => {
    const { text, failed } = await toolResult(await callNamed('list_jobs', { state: 'backlog' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/Unknown state/);
  });

  it('reads one card back in full, detail and all', async () => {
    const job = await post({ title: 'Add rate limiting', detail: 'Token bucket, 100/min.' });
    job.branchName = 'board/add-rate-limiting';
    job.lastError = 'worktree busy';

    const text = await toolText(await callNamed('read_job', { id: job.id }));
    expect(text).toContain('Token bucket, 100/min.');
    expect(text).toContain('board/add-rate-limiting');
    expect(text).toContain('worktree busy');
    expect(text).toMatch(/column: To do/);
  });

  it('hands back an unknown id as a tool error naming what to do', async () => {
    const { text, failed } = await toolResult(await callNamed('read_job', { id: 'job-nope' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/No job with id .*list the board/);
  });

  it('edits a To do card and repaints every open board', async () => {
    const job = await post({ title: 'Add rate limiting', detail: 'Token bucket.' });
    broadcasts.length = 0;

    const text = await toolText(await callNamed('edit_job', {
      id: job.id, title: 'Add rate limiting to /api', detail: 'Token bucket, 100/min.',
    }));
    expect(text).toMatch(/Updated title, detail/);
    // A one-time card gets no "It runs ..." tail — that only applies to a
    // scheduled edit.
    expect(text).not.toContain('It runs');
    expect(allJobs()[0].title).toBe('Add rate limiting to /api');
    expect(allJobs()[0].detail).toBe('Token bucket, 100/min.');
    expect(broadcasts.some(m => m.type === 'jobs-list')).toBe(true);
  });

  it('leaves the fields it was not given alone', async () => {
    const job = await post({ title: 'Add rate limiting', detail: 'Token bucket.' });
    await callNamed('edit_job', { id: job.id, title: 'Retitled' });
    expect(allJobs()[0].detail).toBe('Token bucket.');
    expect(allJobs()[0].repoPath).toBe(REPO);
  });

  it('turns a card into a scheduled one and back again', async () => {
    const job = await post({ title: 'Sweep the logs' });
    await callNamed('edit_job', { id: job.id, schedule: '@daily' });
    expect(allJobs()[0].type).toBe('scheduled');
    expect(allJobs()[0].nextRunAt).toBeTruthy();

    await callNamed('edit_job', { id: job.id, schedule: '' });
    expect(allJobs()[0].type).toBe('one-time');
    expect(allJobs()[0].schedule).toBeNull();
    expect(allJobs()[0].nextRunAt).toBeNull();
  });

  it('refuses to edit a card that has left To do, and changes nothing', async () => {
    // The whole rule: the agent working this card was handed its text at
    // dispatch, so a later edit would leave the card describing work nobody
    // was asked to do.
    for (const state of ['in-progress', 'review', 'done']) {
      const job = await post({ title: `Gone to ${state}`, detail: 'Original.' });
      job.state = state;

      const { text, failed } = await toolResult(
        await callNamed('edit_job', { id: job.id, title: 'Rewritten', detail: 'Rewritten.' }));
      expect(failed, state).toBe(true);
      expect(text, state).toMatch(/only cards still in To do can be edited/);
      expect(job.title, state).toBe(`Gone to ${state}`);
      expect(job.detail, state).toBe('Original.');
    }
  });

  it('refuses an edit that changes nothing, rather than reporting a save', async () => {
    const job = await post({ title: 'Add rate limiting' });
    const { text, failed } = await toolResult(
      await callNamed('edit_job', { id: job.id, title: 'Add rate limiting' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/Nothing to change/);
  });

  it('refuses to blank a title', async () => {
    const job = await post({ title: 'Add rate limiting' });
    const { failed } = await toolResult(await callNamed('edit_job', { id: job.id, title: '   ' }));
    expect(failed).toBe(true);
    expect(allJobs()[0].title).toBe('Add rate limiting');
  });

  it('turns a user token away from the read and edit tools too', async () => {
    // /mcp is the agent door: a person reads and edits through the board's own
    // API, and their token does not resolve here at all.
    const userToken = withUser();
    for (const name of ['list_jobs', 'read_job', 'edit_job']) {
      expect((await callNamed(name, { id: 'job-1' }, userToken)).status, name).toBe(401);
    }
  });

  it('will not let an agent rewrite a card someone else queued', async () => {
    // A To do card's detail is the next agent's prompt, handed to an unattended
    // run. Every board agent holds one of these tokens, so an agent in one repo
    // must not be able to rewrite what runs in another person's.
    withUser();
    const job = await post({ title: 'Theirs', detail: 'Original.' });
    job.postedBy = 'someone-else';
    job.postedByName = 'Ada';

    const { text, failed } = await toolResult(
      await callNamed('edit_job', { id: job.id, detail: 'Do something else entirely.' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/was queued by Ada/);
    expect(job.detail).toBe('Original.');
  });

  it('leaves an unowned card alone on a single-player board', async () => {
    // No users file: postedBy is null on every card and the agent has no owner
    // either, so the ownership rule must not fire at all.
    const job = await post({ title: 'Mine', detail: 'Original.' });
    expect(job.postedBy).toBeNull();
    const { failed } = await toolResult(await callNamed('edit_job', { id: job.id, detail: 'Updated.' }));
    expect(failed).toBeFalsy();
    expect(allJobs()[0].detail).toBe('Updated.');
  });

  it('says out loud that an agent edited a card, and leaves its name on it', async () => {
    // The same reasoning as the toast on a posted card, and more so: an edit
    // destroys text rather than adding a card, and the card otherwise still
    // reads as the work of whoever queued it.
    const job = await post({ title: 'Add rate limiting' });
    broadcasts.length = 0;
    await callNamed('edit_job', { id: job.id, detail: 'Token bucket, 100/min.' });

    const toast = broadcasts.find(m => m.type === 'notification');
    expect(toast.message).toMatch(/Onyx edited a job: "Add rate limiting"/);
    expect(allJobs()[0].editedByAgent).toBe('Onyx');
    expect(allJobs()[0].editedAt).toBeTruthy();
    expect(await toolText(await callNamed('read_job', { id: job.id }))).toMatch(/edited by Onyx on /);
  });

  it('refuses a repo filter that is not a string, rather than listing everything', async () => {
    await post({ title: 'Here' });
    const { text, failed } = await toolResult(await callNamed('list_jobs', { repo: 42 }));
    expect(failed).toBe(true);
    expect(text).toMatch(/repo must be a string/);
  });

  it('lists the board in the order the board itself shows', async () => {
    const first = await post({ title: 'Queued first' });
    const second = await post({ title: 'Queued second' });
    // Stored out of order: the reply is sorted by when each was posted, the
    // way the board's To do column is.
    first.postedAt = '2026-09-03T10:00:00.000Z';
    second.postedAt = '2026-09-03T09:00:00.000Z';
    const text = await toolText(await callNamed('list_jobs', {}));
    expect(text.indexOf('Queued second')).toBeLessThan(text.indexOf('Queued first'));
  });

  it('moves a card to another repository by folder name', async () => {
    const job = await post({ title: 'Move me' });
    const text = await toolText(await callNamed('edit_job', { id: job.id, repo: basename(REPO2) }));
    expect(text).toMatch(/Updated repo on "Move me"/);
    expect(allJobs()[0].repoPath).toBe(REPO2);
  });

  it('refuses to move a card to an unknown repository, and leaves it in place', async () => {
    const job = await post({ title: 'Stay put' });
    const { text, failed } = await toolResult(await callNamed('edit_job', { id: job.id, repo: '/nope' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/Unknown repository/);
    expect(allJobs()[0].repoPath).toBe(REPO);
  });

  it("treats resending the card's current repo as no change", async () => {
    const job = await post({ title: 'Stay put' });
    const { text, failed } = await toolResult(await callNamed('edit_job', { id: job.id, repo: basename(REPO) }));
    expect(failed).toBe(true);
    expect(text).toMatch(/Nothing to change/);
  });

  it('refuses a non-string detail or schedule from the wire', async () => {
    const job = await post({ title: 'Add rate limiting' });
    let r = await toolResult(await callNamed('edit_job', { id: job.id, detail: 5 }));
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/detail must be a string/);
    r = await toolResult(await callNamed('edit_job', { id: job.id, schedule: 5 }));
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/schedule must be a string/);
  });

  it('propagates a bad cron from updateJob as a tool error, unapplied', async () => {
    const job = await post({ title: 'Digest' });
    const { text, failed } = await toolResult(
      await callNamed('edit_job', { id: job.id, schedule: 'every friday' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/five fields/i);
    expect(allJobs()[0].type).toBe('one-time');
  });

  it('hands an unknown card id to edit_job back as a tool error', async () => {
    const { text, failed } = await toolResult(await callNamed('edit_job', { id: 'job-nope', title: 'X' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/No job with id/);
  });

  it('answers a no-op edit on a dispatched card with the To do rule, not "nothing to change"', async () => {
    // The gate runs before the fields are diffed, so a same-value edit to a
    // card that has left To do reports the rule that actually stopped it.
    const job = await post({ title: 'Add rate limiting' });
    job.state = 'in-progress';
    const { text, failed } = await toolResult(
      await callNamed('edit_job', { id: job.id, title: 'Add rate limiting' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/only cards still in To do can be edited/);
    expect(text).not.toMatch(/Nothing to change/);
  });

  it('reports nothing archived when a column filter is applied, even with finished cards on the board', async () => {
    const done = await post({ title: 'Wrapped up' });
    done.state = 'done';
    const text = await toolText(await callNamed('list_jobs', { state: 'todo' }));
    expect(text).not.toMatch(/archived/i);
  });

  it('refuses to list an unknown repository too', async () => {
    const { text, failed } = await toolResult(await callNamed('list_jobs', { repo: '/nope' }));
    expect(failed).toBe(true);
    expect(text).toMatch(/Unknown repository/);
  });

  it('shows the schedule and pull request in the one-line list summary', async () => {
    const job = await post({ title: 'Nightly sweep' });
    Object.assign(job, {
      type: 'scheduled', schedule: '@daily', nextRunAt: '2026-09-04T09:00:00.000Z',
      prUrl: 'https://github.com/x/y/pull/9',
    });
    const text = await toolText(await callNamed('list_jobs', {}));
    expect(text).toMatch(/scheduled @daily, next/);
    expect(text).toContain('https://github.com/x/y/pull/9');
  });

  it('reads the agent, schedule and pull request fields when a card carries them', async () => {
    const job = await post({ title: 'Nightly sweep' });
    Object.assign(job, {
      state: 'in-progress',
      type: 'scheduled', schedule: '@daily', nextRunAt: '2026-09-04T09:00:00.000Z',
      runCount: 3, lastRunAt: '2026-09-01T09:00:00.000Z',
      agentName: 'Slate', startedAt: '2026-09-01T08:00:00.000Z',
      worktreePath: '/wt/9',
      prUrl: 'https://github.com/x/y/pull/9', prMergedAt: '2026-09-02T00:00:00.000Z',
      prCheckError: 'checks failing',
    });
    const text = await toolText(await callNamed('read_job', { id: job.id }));
    expect(text).toMatch(/schedule: @daily.*run 3 time\(s\)/);
    expect(text).toMatch(/agent: Slate, started/);
    expect(text).toMatch(/pull request: https:\/\/github\.com\/x\/y\/pull\/9 \(merged/);
    expect(text).toMatch(/pull request check: checks failing/);
    // Never the absolute paths: this reply goes to whatever agent asked, about
    // every card on the board, and those describe the user's disk.
    expect(text).not.toContain('/wt/9');
    expect(text).not.toContain(REPO);
    expect(text).toContain(basename(REPO));
  });
});
