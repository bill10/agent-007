// The CI watch on Review cards: Billion hears once per commit and run when CI
// finishes, and a merged or closed PR is filed on the same poll.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { addJob, allJobs, boardSettings, checkReviewCi, checkMergedPullRequests, CI_POLL_MS } from '../server/jobs.js';
import { dropMessages, flushMessages } from '../server/messages.js';
import { parsePrCi } from '../lib/jobs.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-ci-'));
const noop = () => {};

let billion;
beforeEach(() => {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
  billion = {
    id: 'ci-billion', name: 'Billion', isBillion: true, command: 'claude', agent: 'claude', state: 'WORKING',
    exited: false, stateChangedAt: 0, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
  };
  sessions.set(billion.id, billion);
});
afterEach(() => dropMessages(billion.id));

function reviewCard(title, { byBillion = true, pr = 7 } = {}) {
  const { job } = addJob({ title, repoPath: REPO }, noop);
  Object.assign(job, { state: 'review', branchName: `b/${title}`, prNumber: pr, prUrl: `https://gh/o/r/pull/${pr}`, postedByBillion: byBillion });
  return job;
}

const run = (name, conclusion, status = 'COMPLETED', completedAt = '2026-09-25T10:00:00Z') =>
  ({ __typename: 'CheckRun', name, status, conclusion, ...(status === 'COMPLETED' && { completedAt }) });
const view = (fields) => async () => ({ pr: parsePrCi(JSON.stringify({ number: 7, state: 'OPEN', headRefOid: 'sha1', ...fields })) });

describe('parsePrCi', () => {
  it('waits while a check runs or none exist, then lists failures from both rollup shapes', () => {
    const p = (rollup) => parsePrCi(JSON.stringify({ state: 'OPEN', headRefOid: 'a', statusCheckRollup: rollup })).ci;
    expect(p([])).toBeNull();
    expect(p([run('Tests (Ubuntu)', 'SUCCESS'), run('Tests (Windows)', '', 'IN_PROGRESS')])).toBeNull();
    expect(p([{ __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' }])).toBeNull();
    expect(p([run('Tests (Ubuntu)', 'SUCCESS'), run('lint', 'SKIPPED', 'COMPLETED', '2026-09-25T10:05:00Z')]))
      .toEqual({ failed: [], finishedAt: '2026-09-25T10:05:00Z' });
    expect(p([{ ...run('test', 'FAILURE'), workflowName: 'Tests (Windows)' }]).failed).toEqual(['Tests (Windows) / test']);
    expect(p([run('Tests (Ubuntu)', 'FAILURE'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' }]).failed)
      .toEqual(['Tests (Ubuntu)', 'ci/legacy']);
    expect(parsePrCi(JSON.stringify({ state: 'CLOSED', mergedAt: '2026-01-01T00:00:00Z' })).state).toBe('MERGED');
  });
});

describe('checkReviewCi', () => {
  it('tells Billion once per head SHA, and a new push re-arms it', async () => {
    const job = reviewCard('ship');
    const passed = view({ statusCheckRollup: [run('Tests (Ubuntu)', 'SUCCESS')] });
    expect((await checkReviewCi(noop, { viewCi: passed })).notified).toEqual([job]);
    expect((await checkReviewCi(noop, { viewCi: passed })).notified).toEqual([]);
    expect(job.ciNotifiedKey).toBe('sha1@2026-09-25T10:00:00Z');

    // Billion is busy, so the notices wait in its queue; flush by resting it.
    const failed = view({ headRefOid: 'sha2', statusCheckRollup: [run('Tests (Ubuntu)', 'SUCCESS'), run('Tests (Windows)', 'FAILURE')] });
    expect((await checkReviewCi(noop, { viewCi: failed })).notified).toEqual([job]);
    billion.state = 'WAITING';
    flushMessages(billion, Date.now());
    const typed = billion.pty.write.mock.calls.map(c => c[0]).join('');
    expect(typed).toContain(`[Job board] CI finished on "ship" (card ${job.id}, PR #7): all passed`);
  });

  it('re-arms when a failed job is re-run on the same commit', async () => {
    const job = reviewCard('flaky');
    const failed = view({ statusCheckRollup: [run('Tests (Windows)', 'FAILURE')] });
    expect((await checkReviewCi(noop, { viewCi: failed })).notified).toEqual([job]);
    expect((await checkReviewCi(noop, { viewCi: view({ statusCheckRollup: [run('Tests (Windows)', '', 'IN_PROGRESS')] }) })).notified).toEqual([]);
    const rerun = view({ statusCheckRollup: [run('Tests (Windows)', 'SUCCESS', 'COMPLETED', '2026-09-25T10:09:00Z')] });
    expect((await checkReviewCi(noop, { viewCi: rerun })).notified).toEqual([job]);
    expect((await checkReviewCi(noop, { viewCi: rerun })).notified).toEqual([]);
  });

  it('names the failed checks', async () => {
    const job = reviewCard('broken');
    billion.state = 'WAITING';
    await checkReviewCi(noop, { viewCi: view({ statusCheckRollup: [run('Tests (Ubuntu)', 'SUCCESS'), run('Tests (Windows)', 'FAILURE')] }) });
    const typed = billion.pty.write.mock.calls.map(c => c[0]).join('');
    expect(typed).toContain(`CI finished on "broken" (card ${job.id}, PR #7): failed: Tests (Windows)`);
  });

  it('stays quiet while checks run, and for cards Billion did not post', async () => {
    const mine = reviewCard('running');
    const theirs = reviewCard('theirs', { byBillion: false });
    const r = await checkReviewCi(noop, { viewCi: view({ statusCheckRollup: [run('Tests (Ubuntu)', '', 'QUEUED')] }) });
    expect(r.notified).toEqual([]);
    const done = await checkReviewCi(noop, { viewCi: view({ statusCheckRollup: [run('Tests (Ubuntu)', 'SUCCESS')] }) });
    expect(done.notified).toEqual([mine]);
    expect(theirs.ciNotifiedKey).toBeUndefined();
  });

  it('files a merged or closed PR through the merge sweep on the same poll', async () => {
    const merged = reviewCard('merged', { byBillion: false });
    const closed = reviewCard('closed');
    const open = reviewCard('open');
    const swept = [];
    const sweep = async (_b, { only }) => { swept.push(...only); return only; };
    const states = { [merged.branchName]: 'MERGED', [closed.branchName]: 'CLOSED' };
    const viewCi = async (_repo, branch) => ({ pr: { state: states[branch] || 'OPEN', headSha: 'x', ci: null } });
    expect((await checkReviewCi(noop, { viewCi, sweep })).filed).toEqual([merged, closed]);
    expect(swept).toEqual([merged, closed]);

    // And the real sweep, narrowed to that card, files it as Done.
    const done = await checkMergedPullRequests(noop, {
      only: [merged],
      findMerged: async () => ({ pr: { url: merged.prUrl, number: 7, mergedAt: '2026-09-25T10:00:00Z' } }),
    });
    expect(done).toEqual([merged]);
    expect(merged.state).toBe('done');
    expect(open.state).toBe('review');
  });

  it('backs off a card whose PR cannot be read', async () => {
    reviewCard('dark');
    const calls = [];
    const viewCi = async () => { calls.push(1); return { pr: null, error: 'no access' }; };
    const t = Date.now();
    await checkReviewCi(noop, { viewCi, now: t });
    await checkReviewCi(noop, { viewCi, now: t + CI_POLL_MS });
    expect(calls).toHaveLength(1);
    await checkReviewCi(noop, { viewCi, now: t + 2 * CI_POLL_MS });
    expect(calls).toHaveLength(2);
    expect(allJobs()[0].state).toBe('review');
  });
});
