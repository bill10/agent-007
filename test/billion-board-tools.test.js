// Billion's board tools (docs/BILLION.md, part 3): add_repo and close_job
// (a Review card's verdict, or a To do card archived),
// through the real /mcp route, so the "Billion only" checks are the ones that
// run in production.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtempSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = mkdtempSync(join(tmpdir(), 'a007-bt-repo-'));
const NEW_REPO = mkdtempSync(join(tmpdir(), 'a007-bt-new-'));
execFileSync('git', ['init', '-q'], { cwd: NEW_REPO });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: NEW_REPO });

const { config, sessions } = await import('../server/state.js');
const { setupRoutes } = await import('../server/http.js');
const { addJob, allJobs, boardSettings } = await import('../server/jobs.js');
const { mintAgentToken } = await import('../server/auth.js');
const { BILLION_NAME } = await import('../lib/jobs.js');

const BILLION_TOKEN = mintAgentToken();
const WORKER_TOKEN = mintAgentToken();
const killed = [];

const server = createServer((() => {
  const app = express();
  setupRoutes(app, mkdtempSync(join(tmpdir(), 'a007-bt-static-')), {
    broadcast: () => {},
    killSession: async (id) => { killed.push(id); sessions.delete(id); },
  });
  return app;
})());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
afterAll(() => server.close());

beforeEach(() => {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
  killed.length = 0;
  sessions.set('s-billion', { id: 's-billion', name: BILLION_NAME, isBillion: true, exited: false, agentToken: BILLION_TOKEN, ownerId: null });
  sessions.set('s-worker', { id: 's-worker', name: 'Cobra', repoPath: REPO, exited: false, agentToken: WORKER_TOKEN, ownerId: null });
});

let rpcId = 0;
async function call(name, args, token = BILLION_TOKEN) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  return body.error ? { error: body.error.message } : { text: body.result.content[0].text, isError: body.result.isError };
}

// A card in Review, with a worker still on it (Review keeps its agent).
function reviewCard(fields = {}) {
  const { job } = addJob({ title: 'Research pricing', repoPath: REPO, requiresPr: false, postedByAgent: BILLION_NAME, postedByBillion: true, ...fields }, () => {});
  Object.assign(job, { state: 'review', agentSessionId: 's-worker', agentName: 'Cobra', branchName: 'research-pricing', resultSummary: 'done' });
  return job;
}

describe('add_repo', () => {
  it('puts a repository on the board for Billion', async () => {
    const r = await call('add_repo', { path: NEW_REPO });
    expect(r.isError).toBe(false);
    expect(config.repos.map(repo => repo.path)).toContain(realpathSync(NEW_REPO));
  });

  it('refuses a folder that is not a repository', async () => {
    const r = await call('add_repo', { path: mkdtempSync(join(tmpdir(), 'a007-bt-plain-')) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not a git repository/);
  });

  it('is not a tool any other agent has', async () => {
    expect((await call('add_repo', { path: NEW_REPO }, WORKER_TOKEN)).error).toMatch(/Unknown tool/);
    expect(config.repos).toHaveLength(1);
  });
});

describe('close_job', () => {
  it('accepts a no-PR card: Done, and its worker closed', async () => {
    const job = reviewCard();
    const r = await call('close_job', { id: job.id, accept: true });
    expect(r.text).toMatch(/is Done/);
    expect(job.state).toBe('done');
    expect(killed).toEqual(['s-worker']);
  });

  it('sends a card back with the reason in its detail, for the next worker', async () => {
    const job = reviewCard({ detail: 'Find what competitors charge.' });
    const r = await call('close_job', { id: job.id, accept: false, note: 'Include annual plans.' });
    expect(r.text).toMatch(/back in To do/);
    expect(job.state).toBe('todo');
    expect(job.detail).toBe('Find what competitors charge.\n\nSent back by Billion: Include annual plans.');
    expect(job.resultSummary).toBeNull();
    expect(killed).toEqual(['s-worker']);
  });

  it('will not send a card back without saying why', async () => {
    const job = reviewCard();
    expect((await call('close_job', { id: job.id, accept: false })).text).toMatch(/Say why/);
    expect(job.state).toBe('review');
  });

  it('leaves a card with a pull request to its merge', async () => {
    const job = reviewCard({ requiresPr: true });
    job.prUrl = 'https://github.com/o/r/pull/7';
    expect((await call('close_job', { id: job.id, accept: true })).text).toMatch(/Merge it, or close it/);
    expect(job.state).toBe('review');
    expect(killed).toEqual([]);
  });

  it('closes only Billion\'s own cards, and only from Review', async () => {
    const theirs = reviewCard({ postedByAgent: 'Viper', postedByBillion: false });
    expect((await call('close_job', { id: theirs.id, accept: true })).text).toMatch(/not posted by you/);
    const running = reviewCard();
    running.state = 'in-progress';
    expect((await call('close_job', { id: running.id, accept: true })).text).toMatch(/only a card in Review/);
    expect(allJobs().map(j => j.state)).toEqual(['review', 'in-progress']);
  });

  it('is not a tool any other agent has', async () => {
    const job = reviewCard();
    expect((await call('close_job', { id: job.id, accept: true }, WORKER_TOKEN)).error).toMatch(/Unknown tool/);
    expect(job.state).toBe('review');
  });
});

describe('close_job on a To do card', () => {
  const todoCard = (fields = {}) => addJob({ title: 'Oct 1, 10:30 am: check in', repoPath: REPO, schedule: '30 10 1 10 *', postedByAgent: BILLION_NAME, postedByBillion: true, ...fields }, () => {}).job;

  it('archives one of Billion\'s To do cards without running it, with the note as its reason', async () => {
    const job = todoCard();
    const r = await call('close_job', { id: job.id, accept: true, note: 'Done by hand already.' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/archived in Finished/);
    expect(job.state).toBe('done');
    expect(job.archivedReason).toBe('Done by hand already.');
    expect(job.archivedBy).toBe(BILLION_NAME);
    expect(allJobs()).toContain(job);
  });

  it('wants a reason, its own card, and accept rather than send back', async () => {
    const job = todoCard();
    expect((await call('close_job', { id: job.id, accept: true, note: ' ' })).text).toMatch(/Say why/);
    expect((await call('close_job', { id: job.id, accept: false, note: 'x' })).text).toMatch(/nothing to send back/);
    const theirs = todoCard({ postedByAgent: 'Viper', postedByBillion: false });
    expect((await call('close_job', { id: theirs.id, accept: true, note: 'x' })).text).toMatch(/not posted by you/);
    expect(allJobs().map(j => j.state)).toEqual(['todo', 'todo']);
  });
});

describe('Billion\'s tool list', () => {
  it('has close_job and no retire_job: 24 tools', async () => {
    const { toolsFor } = await import('../server/mcp.js');
    const names = toolsFor({ isBillion: true }).map(t => t.name);
    expect(names).toContain('close_job');
    expect(names).not.toContain('retire_job');
    expect(names).toHaveLength(24);
  });
});
