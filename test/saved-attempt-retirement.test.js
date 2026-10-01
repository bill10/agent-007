import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import { execFileSync } from 'child_process';
import { createServer } from 'http';

vi.mock('../server/pty.js', () => ({ createSessionFromConfig: vi.fn(() => { throw new Error('must not spawn'); }) }));
const { setConfig, sessions, orphans, adoptingOrphans, codenamePool, CONFIG_PATH, WORKTREE_DIR } = await import('../server/state.js');
const state = await import('../server/state.js');
const { setupRoutes } = await import('../server/http.js');
const { addJob, allJobs, retireSavedAttemptForAgent, readJobForAgent, moveJob, dispatchOnce, fireSchedules } = await import('../server/jobs.js');
const { loadConfig, recoverCrashedSessions, saveConfig } = await import('../server/config.js');
const { savedAttemptToken } = await import('../lib/saved-attempts.js');
const { scanForOrphanedWorktrees } = await import('../server/git.js');
const { respawnOrphan, respawnBoardWorkers } = await import('../server/ws.js');
const { createSessionFromConfig } = await import('../server/pty.js');
const { mintAgentToken, USERS_PATH } = await import('../server/auth.js');
const REPO = mkdtempSync(join(tmpdir(), 'a007-retire-repo-'));
const WORKTREE = join(WORKTREE_DIR, 'video', 'Shadow');
const TOKEN = mintAgentToken();
const WORKER_TOKEN = mintAgentToken();
const noop = () => {};
const app = express();
setupRoutes(app, REPO, { broadcast: noop });
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
afterAll(() => server.close());
async function call(name, args, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.json();
}
let original, schedule, record, billion, fields;
beforeEach(() => {
  rmSync(USERS_PATH, { force: true });
  sessions.clear(); orphans.clear(); adoptingOrphans.clear(); vi.clearAllMocks();
  // All config/worktree/auth paths were redirected by test/setup.js before imports.
  setConfig({ repos: [{ path: REPO }], jobs: [], activeSessions: [], orphans: [] });
  mkdirSync(join(WORKTREE, '.git'), { recursive: true });
  billion = { id: 'billion', name: 'Billion', isBillion: true, ownerId: null, exited: false, agentToken: TOKEN };
  sessions.set(billion.id, billion);
  const attrs = { repoPath: REPO, requiresPr: false, postedByBillion: true, agent: 'codex' };
  schedule = addJob({ ...attrs, title: 'Producer', schedule: '@hourly' }, noop).job;
  original = addJob({ ...attrs, title: 'Original', detail: 'Keep original instructions.' }, noop).job;
  Object.assign(original, { state: 'in-progress', scheduleId: schedule.id, agentSessionId: 'gone', agentName: 'Shadow',
    branchName: 'producer-22', worktreePath: WORKTREE, resultSummary: 'Partial work evidence' });
  record = { name: 'Shadow', jobId: original.id, repoPath: REPO, branchName: original.branchName, worktreePath: WORKTREE,
    ownerId: null, origin: 'board', agent: 'codex', savedAt: '2026-10-01T17:11:48.582Z', permissionFlags: [], approvalsToBillion: true };
  state.config.activeSessions = [record];
  fields = { session: billion, id: original.id, attemptToken: savedAttemptToken(record), reason: 'Verified original absent, recovery accepted, no live production lock, send receipt checked.', externalWorkVerified: true };
});

describe('retire_saved_attempt', () => {
  it('binds the MCP operation to read_job token, preserves work and persists audit without completing or dispatching', async () => {
    const before = structuredClone(original);
    const token = readJobForAgent(original.id).job.savedAttemptToken;
    expect(token).toBe(fields.attemptToken);
    const response = await call('retire_saved_attempt', { id: original.id, attempt_token: token, reason: fields.reason, external_work_verified: true });
    expect(response.result.isError).toBe(false);
    expect(response.result.content[0].text).toMatch(/not completed/);
    expect(original).toEqual(before);
    expect(schedule.state).toBe('todo');
    expect(state.config.activeSessions).toEqual([]);
    const disk = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    expect(disk.retiredSavedAttempts[0]).toMatchObject({ token, record, retiredBy: billion.id, reason: fields.reason, externalWorkVerified: true });
    expect(disk.retiredSavedAttempts[0].retiredAt).toBeTruthy();
    expect(existsSync(WORKTREE)).toBe(true);
    expect(codenamePool.has(record.name)).toBe(true);
    expect(createSessionFromConfig).not.toHaveBeenCalled();
    expect(readJobForAgent(original.id).job.savedAttemptRetiredAt).toBeTruthy();
    expect((await moveJob(original.id, 'todo', noop)).error).toMatch(/retired/);
    expect(retireSavedAttemptForAgent(fields, noop).error).toMatch(/already retired/);
  });

  it('requires singleton identity and keeps workers from discovering the tool', async () => {
    sessions.set('worker', { id: 'worker', ownerId: null, agentToken: WORKER_TOKEN });
    const r = await call('retire_saved_attempt', {}, WORKER_TOKEN);
    expect(r.error.message).toMatch(/Unknown tool/);
  });

  it.each(['auth', 'caller owner', 'impostor', 'unregistered', 'exited caller', 'second Billion', 'original owner', 'schedule owner',
    'record owner', 'live', 'parked', 'orphan', 'persisted orphan', 'adopting', 'duplicate record', 'wrong job', 'wrong repo',
    'wrong branch', 'wrong worktree', 'no savedAt', 'user origin', 'stale token', 'changed flags', 'no attestation', 'no reason', 'shared card'])('rejects ambiguity or missing authority: %s', mode => {
    const before = structuredClone(original);
    if (mode === 'auth') writeFileSync(USERS_PATH, JSON.stringify([{ id: 'owner' }]));
    if (mode === 'caller owner') billion.ownerId = 'owner';
    if (mode === 'impostor') fields.session = { ...billion };
    if (mode === 'unregistered') sessions.delete(billion.id);
    if (mode === 'exited caller') billion.exited = true;
    if (mode === 'second Billion') sessions.set('second', { isBillion: true, ownerId: null });
    if (mode === 'original owner') original.postedBy = 'owner';
    if (mode === 'schedule owner') schedule.postedBy = 'owner';
    if (mode === 'record owner') record.ownerId = 'owner';
    if (mode === 'live' || mode === 'parked') sessions.set('old', { ...record, id: 'old', exited: mode === 'parked' });
    if (mode === 'orphan') orphans.set('old', { ...record, id: 'old' });
    if (mode === 'persisted orphan') state.config.orphans = [{ ...record, id: 'old' }];
    if (mode === 'adopting') adoptingOrphans.add('unknown');
    if (mode === 'duplicate record') state.config.activeSessions.push({ ...record });
    if (mode === 'wrong job') record.jobId = 'another';
    if (mode === 'wrong repo') record.repoPath = '/another';
    if (mode === 'wrong branch') record.branchName = 'another';
    if (mode === 'wrong worktree') record.worktreePath = '/another';
    if (mode === 'no savedAt') delete record.savedAt;
    if (mode === 'user origin') record.origin = 'user';
    if (mode === 'stale token') fields.attemptToken = 'stale';
    if (mode === 'changed flags') record.permissionFlags = ['--changed'];
    if (mode === 'no attestation') fields.externalWorkVerified = false;
    if (mode === 'no reason') fields.reason = '';
    if (mode === 'shared card') allJobs().push({ ...original, id: 'other' });
    expect(retireSavedAttemptForAgent(fields, noop).error).toBeTruthy();
    expect(state.config.retiredSavedAttempts).toBeUndefined();
    expect(original.state).toBe(before.state);
    expect(state.config.activeSessions).toContain(record);
    rmSync(USERS_PATH, { force: true });
  });

  it('rolls back when durable receipt persistence fails', () => {
    const before = state.config.activeSessions;
    const save = vi.fn(() => false);
    expect(retireSavedAttemptForAgent(fields, noop, { save }).error).toMatch(/persist/);
    expect(save).toHaveBeenCalledWith(noop, { atomic: true });
    expect(state.config.activeSessions).toBe(before);
    expect(state.config.retiredSavedAttempts).toBeUndefined();
  });

  it('leaves the previous config file intact when atomic persistence cannot write its temporary file', () => {
    saveConfig();
    const beforeDisk = readFileSync(CONFIG_PATH, 'utf8');
    const temporary = `${CONFIG_PATH}.${process.pid}.retirement.tmp`;
    mkdirSync(temporary);
    try {
      expect(retireSavedAttemptForAgent(fields, noop).error).toMatch(/persist/);
      expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(beforeDisk);
      expect(state.config.activeSessions).toContain(record);
      expect(state.config.retiredSavedAttempts).toBeUndefined();
    } finally { rmSync(temporary, { recursive: true }); }
  });

  it('does not touch unrelated saved sessions, cards, or live workers', () => {
    const other = { ...record, name: 'Other', jobId: 'other', worktreePath: '/unrelated', branchName: 'other' };
    state.config.activeSessions.push(other);
    sessions.set('other', { ...other, id: 'other', ownerId: 'someone', exited: false });
    expect(retireSavedAttemptForAgent(fields, noop).error).toBeUndefined();
    expect(state.config.activeSessions).toEqual([other]);
    expect(sessions.has('other')).toBe(true);
  });

  it('keeps stale original held and permits only separate schedule replacement, without duplicate dispatch', async () => {
    const r = await Promise.all([Promise.resolve().then(() => retireSavedAttemptForAgent(fields, noop)), Promise.resolve().then(() => retireSavedAttemptForAgent(fields, noop))]);
    expect(r.filter(v => !v.error)).toHaveLength(1);
    schedule.nextRunAt = new Date(Date.now() - 1000).toISOString();
    expect(fireSchedules(noop)).toEqual([]);
    const spawn = vi.fn();
    expect(await dispatchOnce(spawn, noop)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(state.config.retiredSavedAttempts).toHaveLength(1);
  });
});

describe('retirement survives every recovery route', () => {
  it('demonstrates the unsuppressed saved record would become a restart orphan and is then refused by retirement', () => {
    recoverCrashedSessions(noop);
    expect([...orphans.values()]).toEqual([expect.objectContaining({ jobId: original.id, worktreePath: WORKTREE, reason: 'server-restart' })]);
    expect(retireSavedAttemptForAgent(fields, noop).error).toBeTruthy();
  });

  it('archives the saved attempt across restart while other crashed sessions still recover', async () => {
    expect(retireSavedAttemptForAgent(fields, noop).error).toBeUndefined();
    const receipt = structuredClone(state.config.retiredSavedAttempts[0]);
    // Replay the stale active entry, simulating a stale snapshot alongside the
    // receipt; startup must honor the receipt, not re-convert this attempt.
    const otherPath = mkdtempSync(join(tmpdir(), 'a007-other-'));
    state.config.activeSessions = [record, { ...record, name: 'Other', jobId: 'other', worktreePath: otherPath, branchName: 'other' }];
    saveConfig();
    loadConfig();
    codenamePool.recycle(record.name);
    recoverCrashedSessions(noop);
    expect(codenamePool.has(record.name)).toBe(true);
    expect(state.config.retiredSavedAttempts[0]).toEqual(receipt);
    expect([...orphans.values()].map(o => o.name)).toEqual(['Other']);
    expect(allJobs().find(j => j.id === original.id).state).toBe('in-progress');
    await scanForOrphanedWorktrees(noop);
    expect([...orphans.values()].some(o => o.worktreePath === WORKTREE)).toBe(false);
    expect(await respawnBoardWorkers({ paceMs: 0 })).toEqual([]);
    expect(createSessionFromConfig).not.toHaveBeenCalled();
  });

  it('rechecks retirement after asynchronous worktree discovery so no orphan is published mid-handoff', async () => {
    rmSync(WORKTREE, { recursive: true, force: true });
    execFileSync('git', ['init', '-q'], { cwd: REPO });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'init'], { cwd: REPO });
    execFileSync('git', ['worktree', 'add', '-q', '-b', record.branchName, WORKTREE], { cwd: REPO });
    const discovering = scanForOrphanedWorktrees(noop);
    expect(retireSavedAttemptForAgent(fields, noop).error).toBeUndefined();
    await discovering;
    expect([...orphans.values()].some(o => o.worktreePath === WORKTREE)).toBe(false);
    expect(createSessionFromConfig).not.toHaveBeenCalled();
    // The real git worktree remains intact; only test cleanup removes it.
    expect(execFileSync('git', ['-C', WORKTREE, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(record.branchName);
    execFileSync('git', ['worktree', 'remove', WORKTREE], { cwd: REPO });
  });

  it('blocks running-server manual and automatic orphan recovery, even after the original card is removed', async () => {
    retireSavedAttemptForAgent(fields, noop);
    const orphan = { ...record, id: 'late', reason: 'server-restart' };
    orphans.set(orphan.id, orphan);
    expect(await respawnBoardWorkers({ paceMs: 0 })).toEqual([]);
    expect((await respawnOrphan(orphan.id)).error).toMatch(/retired/);
    state.config.jobs = allJobs().filter(j => j !== original);
    const discovered = { id: 'discovered', repoPath: record.repoPath, branchName: record.branchName, worktreePath: WORKTREE, origin: 'user' };
    orphans.set(discovered.id, discovered);
    expect((await respawnOrphan(discovered.id, { recreate: true })).error).toMatch(/retired/);
    expect(createSessionFromConfig).not.toHaveBeenCalled();
    expect(existsSync(WORKTREE)).toBe(true);
  });
});
