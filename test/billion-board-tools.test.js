// Billion's board tools (docs/BILLION.md, part 3): add_repo and close_job,
// through the real /mcp route, so the "Billion only" checks are the ones that
// run in production.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = mkdtempSync(join(tmpdir(), 'a007-bt-repo-'));
const NEW_REPO = mkdtempSync(join(tmpdir(), 'a007-bt-new-'));
execFileSync('git', ['init', '-q'], { cwd: NEW_REPO });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: NEW_REPO });

const { config, sessions, orphans } = await import('../server/state.js');
const { setupRoutes } = await import('../server/http.js');
const { addJob, allJobs, boardSettings, fireSchedules, moveJob, reconcileJobForAgent } = await import('../server/jobs.js');
const { mintAgentToken, USERS_PATH } = await import('../server/auth.js');
const { BILLION_NAME, scheduleHold, supersededRuns, runsToPrune } = await import('../lib/jobs.js');

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
  rmSync(USERS_PATH, { force: true });
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
  orphans.clear();
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

describe('retire_job', () => {
  const todoCard = (fields = {}) => addJob({ title: 'Oct 1, 10:30 am: check in', repoPath: REPO, schedule: '30 10 1 10 *', postedByAgent: BILLION_NAME, postedByBillion: true, ...fields }, () => {}).job;

  it('archives one of Billion\'s To do cards without running it, with the reason as its note', async () => {
    const job = todoCard();
    const r = await call('retire_job', { id: job.id, reason: 'Done by hand already.' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/archived in Finished/);
    expect(job.state).toBe('done');
    expect(job.archivedReason).toBe('Done by hand already.');
    expect(job.archivedBy).toBe(BILLION_NAME);
    expect(allJobs()).toContain(job);
  });

  it('wants a reason, its own card, and a card still in To do', async () => {
    const job = todoCard();
    expect((await call('retire_job', { id: job.id, reason: ' ' })).text).toMatch(/Say why/);
    const theirs = todoCard({ postedByAgent: 'Viper', postedByBillion: false });
    expect((await call('retire_job', { id: theirs.id, reason: 'x' })).text).toMatch(/not posted by you/);
    const review = reviewCard();
    expect((await call('retire_job', { id: review.id, reason: 'x' })).text).toMatch(/close_job is for Review/);
    expect(allJobs().map(j => j.state)).toEqual(['todo', 'todo', 'review']);
  });

  it('is not a tool any other agent has', async () => {
    const job = todoCard();
    expect((await call('retire_job', { id: job.id, reason: 'x' }, WORKER_TOKEN)).error).toMatch(/Unknown tool/);
    expect(job.state).toBe('todo');
  });
});


describe('reconcile_job', () => {
  function recovery() {
    const fields = { repoPath: REPO, requiresPr: false, postedByBillion: true };
    const { job: schedule } = addJob({ ...fields, title: 'Producer', schedule: '@hourly' }, () => {});
    const { job: old } = addJob({ ...fields, title: 'Gone run' }, () => {});
    Object.assign(old, { state: 'in-progress', scheduleId: schedule.id, agentSessionId: 'missing', branchName: 'old', detail: 'original instructions', resultSummary: 'partial evidence' });
    const { job: replacement } = addJob({ ...fields, title: 'Recovery' }, () => {});
    Object.assign(replacement, { state: 'in-progress', agentSessionId: 's-worker', branchName: 'recovery', detail: `Recover ${old.id}` });
    sessions.get('s-worker').jobId = replacement.id;
    const args = { id: old.id, replacement_id: replacement.id, reason: 'Original gone; external exclusive producer guard verified on recovery.' };
    return { schedule, old, replacement, args };
  }

  it('preserves the gone attempt with no orphan, holds while recovery runs, then permits one due run', async () => {
    const { schedule, old, replacement, args } = recovery();
    const result = await call('reconcile_job', args);
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/no completion recorded/);
    expect(old).toMatchObject({ state: 'review', recoveryJobId: replacement.id, branchName: 'old', agentSessionId: 'missing', detail: 'original instructions', resultSummary: 'partial evidence' });
    expect(old.doneAt).toBeFalsy();
    expect(old.interruptedAt).toBeTruthy();
    expect(replacement.scheduleId).toBe(schedule.id);
    expect(killed).toEqual([]);
    const now = Date.now();
    schedule.nextRunAt = new Date(now - 1000).toISOString();
    expect(fireSchedules(() => {}, { now })).toEqual([]);
    expect(schedule.lastSkipReason).toBe('the recovery run awaits completion and acceptance');
    expect(allJobs()).toHaveLength(3);
    replacement.state = 'review';
    replacement.reviewAt = new Date(now).toISOString();
    expect(scheduleHold(schedule, allJobs())).toMatch(/acceptance/);
    const newer = { id: 'newer', scheduleId: schedule.id, state: 'review', requiresPr: false, reviewAt: new Date(now + 1000).toISOString() };
    expect(supersededRuns([...allJobs(), newer])).toEqual([]);
    replacement.resultSummary = 'Recovered successfully';
    expect((await call('close_job', { id: replacement.id, accept: true })).isError).toBe(false);
    expect(scheduleHold(schedule, allJobs())).toBeNull();
    expect(supersededRuns(allJobs())).toEqual([]);
    schedule.nextRunAt = new Date(now - 1000).toISOString();
    expect(fireSchedules(() => {}, { now })).toHaveLength(1);
    expect(fireSchedules(() => {}, { now })).toEqual([]);
    expect(allJobs()).toContain(old);
    expect((await moveJob(old.id, 'todo', () => {})).error).toMatch(/replacement/);
    expect((await call('reconcile_job', args)).isError).toBe(true);
  });

  it('fails closed if the replacement disappears and retains recovery history during pruning', async () => {
    const { schedule, replacement, args } = recovery();
    await call('reconcile_job', args);
    replacement.state = 'done';
    expect(runsToPrune(allJobs(), 0)).not.toContain(replacement);
    config.jobs = allJobs().filter(j => j !== replacement);
    expect(scheduleHold(schedule, allJobs())).toMatch(/missing or detached/);
  });

  it.each(['live', 'orphan', 'replacement gone', 'wrong repo', 'PR', 'linked', 'owner', 'reason', 'unrelated', 'cross owner', 'self', 'original owner', 'schedule owner', 'original recovers', 'original recovery', 'caller owner', 'second Billion', 'empty original link', 'empty replacement link'])('refuses unsafe handoff: %s', async mode => {
    const { schedule, old, replacement, args } = recovery();
    if (mode === 'live') sessions.set('revived', { jobId: old.id, exited: false });
    if (mode === 'orphan') orphans.set('parked', { jobId: old.id });
    if (mode === 'replacement gone') sessions.delete('s-worker');
    if (mode === 'wrong repo') replacement.repoPath = NEW_REPO;
    if (mode === 'PR') old.requiresPr = true;
    if (mode === 'linked') replacement.scheduleId = 'another';
    if (mode === 'owner') replacement.postedBy = 'owner';
    if (mode === 'reason') args.reason = ' ';
    if (mode === 'unrelated') replacement.detail = 'Unrelated task';
    if (mode === 'cross owner') sessions.get('s-worker').ownerId = 'other';
    if (mode === 'self') args.replacement_id = old.id;
    if (mode === 'original owner') old.postedBy = 'other-owner';
    if (mode === 'schedule owner') schedule.postedBy = 'other-owner';
    if (mode === 'original recovers') old.recoversJobId = 'earlier';
    if (mode === 'original recovery') old.recoveryJobId = 'existing';
    if (mode === 'caller owner') sessions.get('s-billion').ownerId = 'another-owner';
    if (mode === 'empty original link') old.recoveryJobId = '';
    if (mode === 'empty replacement link') replacement.recoversJobId = '';
    if (mode === 'second Billion') sessions.set('other-billion', { id: 'other-billion', isBillion: true, exited: false });
    expect((await call('reconcile_job', args)).isError).toBe(true);
    expect(old.state).toBe('in-progress');
    expect(old.interruptedAt).toBeUndefined();
    expect(killed).toEqual([]);
  });

  it('keeps Review/failure and in-flight retirement held, and serializes duplicate handoffs with dispatch', async () => {
    const { schedule, old, replacement, args } = recovery();
    const results = await Promise.all([call('reconcile_job', args), call('reconcile_job', args)]);
    expect(results.filter(r => !r.isError)).toHaveLength(1);
    expect(allJobs()).toHaveLength(3);
    replacement.state = 'review';
    replacement.resultSummary = 'SKIPPED: failed quality gate';
    expect(scheduleHold(schedule, allJobs())).toMatch(/acceptance/);
    let release;
    const retiring = moveJob(replacement.id, 'done', () => {}, {
      killSession: () => new Promise(resolve => { release = () => { sessions.delete('s-worker'); resolve(); }; }),
    });
    const now = Date.now();
    schedule.nextRunAt = new Date(now - 1000).toISOString();
    expect(replacement.state).toBe('done');
    expect(fireSchedules(() => {}, { now })).toEqual([]);
    release();
    await retiring;
    expect(scheduleHold(schedule, allJobs())).toBeNull();
    expect(old.interruptedAt).toBeTruthy();
  });

  it.each(['impostor', 'unregistered', 'exited'])('refuses a non-current Billion identity: %s', mode => {
    const { old, replacement, args } = recovery();
    let session = sessions.get('s-billion');
    if (mode === 'impostor') session = { ...session };
    if (mode === 'unregistered') sessions.delete(session.id);
    if (mode === 'exited') session.exited = true;
    const result = reconcileJobForAgent({ session, id: old.id, replacementId: replacement.id, reason: args.reason }, () => {});
    expect(result.error).toMatch(/sole live/);
    expect(old.state).toBe('in-progress');
    expect(replacement.scheduleId).toBeFalsy();
  });

  it('refuses a running Billion after user accounts are enabled', () => {
    const { old, replacement, args } = recovery();
    try {
      writeFileSync(USERS_PATH, JSON.stringify([{ id: 'another-owner', tokenHash: 'unused' }]));
      const result = reconcileJobForAgent({ session: sessions.get('s-billion'), id: old.id,
        replacementId: replacement.id, reason: args.reason }, () => {});
      expect(result.error).toMatch(/user accounts disabled/);
      expect(old.state).toBe('in-progress');
      expect(replacement.scheduleId).toBeFalsy();
    } finally {
      rmSync(USERS_PATH, { force: true });
    }
  });

  it('keeps the schedule held when retirement fails', async () => {
    const { schedule, replacement, args } = recovery();
    await call('reconcile_job', args);
    replacement.state = 'review';
    replacement.resultSummary = 'Recovered';
    await moveJob(replacement.id, 'done', () => {}, { killSession: async () => { throw new Error('stop failed'); } });
    expect(replacement.agentSessionId).toBe('s-worker');
    expect(scheduleHold(schedule, allJobs())).toMatch(/acceptance/);
  });

  it('is unavailable to workers', async () => {
    const { args } = recovery();
    expect((await call('reconcile_job', args, WORKER_TOKEN)).error).toMatch(/Unknown tool/);
  });
});
