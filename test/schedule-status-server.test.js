import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, sessions, CONFIG_DIR } from '../server/state.js';
import { addJob, boardSettings, fireSchedules, jobsPayload, readJobForAgent, runScan, updateJob } from '../server/jobs.js';
import { loadConfig } from '../server/config.js';
import { handleMcpMessage } from '../server/mcp.js';

const now = Date.parse('2026-10-01T12:10:00Z');
const due = '2026-10-01T09:00:00.000Z';
const noop = () => {};
function setup(over = {}) {
  const { job } = addJob({ title: 'Synthetic producer', repoPath: '/synthetic', schedule: '@hourly', postedBy: 'owner', ...over }, noop);
  job.nextRunAt = due;
  return job;
}
function getStatus(id) { return jobsPayload().jobs.find(j => j.id === id).scheduleStatus; }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  config.jobs = [];
  config.repos = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
});
afterEach(() => vi.useRealTimers());

describe('schedule observation in the existing scan', () => {
  it('records a delayed posting once, keeps the due cursor and survives reload with no new run', () => {
    const s = setup();
    expect(getStatus(s.id).code).toBe('overdue');
    const [run] = fireSchedules(noop, { now });
    expect(s.lastScheduleObservation).toEqual({ cron: '@hourly', expectedAt: due, observedAt: new Date(now).toISOString(), outcome: 'posted' });
    expect(getStatus(s.id)).toMatchObject({ code: 'held', label: 'Held: prior run queued', lastExpectedAt: due, lastRun: { id: run.id, startedAt: null } });
    const saved = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'));
    loadConfig();
    expect(config.jobs).toEqual(saved.jobs);
    expect(fireSchedules(noop, { now })).toEqual([]);
    expect(getStatus(s.id).lastExpectedAt).toBe(due);
    expect(config.jobs.filter(j => j.scheduleId === s.id)).toHaveLength(1);
    const restoredRun = config.jobs.find(j => j.id === run.id);
    restoredRun.state = 'done';
    expect(getStatus(s.id).code).toBe('posted-late');
  });
  it('repeated reads are passive; active hold becomes gone after restart without releasing authority', () => {
    const s = setup();
    const r = { id: 'original', state: 'in-progress', scheduleId: s.id, repoPath: s.repoPath, postedBy: s.postedBy, agentSessionId: 'shadow', branchName: 'original-branch' };
    config.jobs.push(r);
    sessions.set('shadow', { state: 'WORKING', lastOutputAt: now });
    expect(fireSchedules(noop, { now })).toEqual([]);
    expect(getStatus(s.id)).toMatchObject({ code: 'held', lastExpectedAt: due, outcome: 'held' });
    sessions.clear();
    loadConfig();
    const before = JSON.stringify(config.jobs);
    expect(getStatus(s.id)).toMatchObject({ code: 'held-gone', blocker: { id: 'original' } });
    expect(readJobForAgent(s.id).job.scheduleStatus.code).toBe('held-gone');
    expect(JSON.stringify(config.jobs)).toBe(before);
  });
  it('does not backfill observations when an overlapping tick is skipped', async () => {
    const s = setup();
    config.jobs.push({ id: 'blocking', state: 'in-progress', branchName: 'test', requiresPr: true, repoPath: '/synthetic', scheduleId: s.id, postedBy: s.postedBy });
    let release;
    const findPr = () => new Promise(resolve => { release = resolve; });
    const scanning = runScan(noop, noop, { findPr, findMerged: async () => ({ pr: null }) });
    expect(await runScan(noop, noop)).toEqual({ skipped: true });
    expect(s.lastScheduleObservation).toBeUndefined();
    release({ pr: null });
    await scanning;
    expect(s.lastScheduleObservation).toMatchObject({ expectedAt: due, outcome: 'held' });
  });
  it('once stays due through a hold then archives after one posting; archive never fires again', () => {
    const s = setup({ once: true });
    const r = { id: 'old', state: 'todo', scheduleId: s.id, repoPath: s.repoPath, postedBy: s.postedBy };
    config.jobs.push(r);
    fireSchedules(noop, { now });
    expect(s.nextRunAt).toBe(due);
    r.state = 'done';
    expect(fireSchedules(noop, { now })).toHaveLength(1);
    expect(getStatus(s.id).code).toBe('archived');
    expect(fireSchedules(noop, { now: now + 86400000 })).toEqual([]);
  });
  it('failed creation has an error observation and no invented run', () => {
    const s = setup();
    s.title = '';
    expect(fireSchedules(noop, { now })).toEqual([]);
    expect(getStatus(s.id)).toMatchObject({ code: 'post-error', outcome: 'error', lastRunAt: null });
  });
  it('read_job and list_jobs expose the same status without changing tool authority', () => {
    const s = setup();
    const call = (name, ctx) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { id: s.id } } }, ctx).result.content[0].text;
    expect(call('read_job', { readJob: readJobForAgent })).toContain('Run posting overdue');
    expect(call('read_job', { readJob: readJobForAgent })).toContain('"lastExpectedAt":null');
    expect(call('list_jobs', { listJobs: () => ({ jobs: [readJobForAgent(s.id).job] }) })).toContain('Run posting overdue');
  });
});


describe('passive reporting regressions', () => {
  it('refreshes age-based stalled status on an unchanged scan without persisting', async () => {
    const s = setup();
    s.nextRunAt = new Date(now + 86400000).toISOString();
    config.jobs.push({ id: 'waiting', state: 'in-progress', scheduleId: s.id, repoPath: s.repoPath, postedBy: s.postedBy, agentSessionId: 'worker', requiresPr: false });
    sessions.set('worker', { state: 'WAITING', lastOutputAt: now });
    expect(getStatus(s.id).code).toBe('held');
    const before = JSON.stringify(config.jobs);
    const savedBefore = readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8');
    vi.setSystemTime(now + 180001);
    const broadcast = vi.fn();
    await runScan(noop, broadcast);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'jobs-list', jobs: expect.arrayContaining([expect.objectContaining({ id: s.id, scheduleStatus: expect.objectContaining({ code: 'held-stalled' }) })]) }));
    expect(JSON.stringify(config.jobs)).toBe(before);
    expect(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8')).toBe(savedBefore);
  });
  it('a recurring schedule edited to once still has a pending firing despite its history', () => {
    const s = setup();
    s.runCount = 4;
    s.lastRunAt = new Date(now - 86400000).toISOString();
    expect(updateJob(s.id, { once: true }, noop).error).toBeUndefined();
    expect(getStatus(s.id).code).toBe('overdue');
    expect(fireSchedules(noop, { now })).toHaveLength(1);
    expect(s.state).toBe('done');
    expect(getStatus(s.id).code).toBe('archived');
  });
});
