// What the pre-landing review of Billion fixed: the trust watcher only just
// after spawn, approvals that cannot outlive their chance of an answer, and
// close_job telling the next worker why, before anyone can pick the card up.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { config, sessions } = await import('../server/state.js');
const { setupPtyHandlers } = await import('../server/pty.js');
const { requestApproval, clearApprovals, dropApprovals, APPROVAL_WAIT_MS } = await import('../server/approvals.js');
const { dropMessages, pendingMessages } = await import('../server/messages.js');
const { addJob, boardSettings, closeJobForAgent } = await import('../server/jobs.js');
const { handleMcpMessage } = await import('../server/mcp.js');
const { HOOK_WAIT_MS, HOOK_TIMEOUT_S } = await import('../server/agent-mcp.js');
const { BILLION_NAME } = await import('../lib/jobs.js');

function fake(name, fields = {}) {
  return {
    id: `rf-${name}`, name, command: 'claude', agent: 'claude', state: 'WAITING', exited: false, ownerId: null,
    stateChangedAt: 0, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() }, ...fields,
  };
}
const request = { tool_name: 'Write', tool_input: { file_path: '/x' } };

let billion, worker;
beforeEach(() => {
  sessions.clear();
  billion = fake('Billion', { isBillion: true, command: 'claude --dangerously-skip-permissions' });
  worker = fake('Falcon', { approvalsToBillion: true });
  sessions.set(billion.id, billion);
  sessions.set(worker.id, worker);
});
afterEach(() => {
  clearApprovals();
  dropMessages(billion.id);
  vi.useRealTimers();
});

describe('the trust watcher', () => {
  it('stands down once Billion is past its start-up, dialog or no dialog', () => {
    vi.useFakeTimers();
    let onData;
    const session = {
      id: 'rf-t', createdAt: Date.now() - 61_000, isBillion: true,
      pty: { onData: (cb) => { onData = cb; }, onExit: () => {}, write: vi.fn() },
      ringBuffer: { push: () => {} }, state: 'WORKING', lastOutputAt: 0, lastResizeAt: 0,
      lastStrippedLine: '', recentStrippedLines: [], pendingRaw: '', isTUI: true, exited: false,
    };
    setupPtyHandlers(session, 'rf-t', () => {});
    clearInterval(session.stateCheckInterval);
    // Billion's own output that happens to look like the dialog.
    onData('Do you trust this folder?\r\n❯ No, exit\r\n  Yes, I trust this folder\r\n');
    vi.advanceTimersByTime(1000);
    expect(session.pty.write).not.toHaveBeenCalled();
    expect(session.trustScreen).toBe('');
  });
});

describe('approvals', () => {
  it('takes an expired request back out of Billion\'s queue', async () => {
    vi.useFakeTimers();
    billion.state = 'WORKING';                     // busy: the request queues
    const answer = requestApproval(worker, request);
    expect(pendingMessages(billion.id)).toBe(1);
    vi.advanceTimersByTime(APPROVAL_WAIT_MS);
    expect(await answer).toEqual({});
    expect(pendingMessages(billion.id)).toBe(0);
  });

  it('hands every waiting request to the owner at once when Billion stops', async () => {
    billion.state = 'WORKING';
    const a = requestApproval(worker, request);
    const b = requestApproval(worker, request);
    dropApprovals();
    expect(await a).toEqual({});
    expect(await b).toEqual({});
  });

  it('keeps the hook\'s limits above the wait, so the server always gives up first', () => {
    expect(HOOK_WAIT_MS).toBeGreaterThan(APPROVAL_WAIT_MS);
    expect(HOOK_TIMEOUT_S * 1000).toBeGreaterThan(HOOK_WAIT_MS);
  });
});

describe('close_job sending a card back', () => {
  const REPO = mkdtempSync(join(tmpdir(), 'a007-rf-repo-'));
  beforeEach(() => {
    config.repos = [{ path: REPO }];
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
  });

  it('writes the reason on the card before it is back in To do, and names the PR to close', async () => {
    const { job } = addJob({ title: 'Fix login', detail: 'Make it work.', repoPath: REPO, postedByAgent: BILLION_NAME, postedByBillion: true }, () => {});
    Object.assign(job, { state: 'review', agentSessionId: worker.id, branchName: 'fix-login', prUrl: 'https://github.com/o/r/pull/7' });
    let detailWhenMoved = null;
    const result = await closeJobForAgent({ session: billion, id: job.id, accept: false, note: 'Cover the error path.' }, () => {}, {
      killSession: async () => { detailWhenMoved = job.detail; },
    });
    expect(detailWhenMoved).toMatch(/Sent back by Billion: Cover the error path\.$/);
    expect(job.state).toBe('todo');
    expect(result.oldPrUrl).toBe('https://github.com/o/r/pull/7');
    const reply = handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'close_job', arguments: { id: job.id, accept: false, note: 'x' } } },
      { session: billion, closeJob: async () => result },
    );
    expect((await reply).result.content[0].text).toMatch(/close https:\/\/github\.com\/o\/r\/pull\/7/);
  });

  it('shows who posted each card in list_jobs', () => {
    const { job } = addJob({ title: 'Mine', repoPath: REPO, postedByAgent: BILLION_NAME, postedByBillion: true }, () => {});
    const reply = handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_jobs', arguments: {} } },
      { session: billion, listJobs: () => ({ jobs: [{ ...job, repo: 'r' }], archived: 0 }) },
    );
    expect(reply.result.content[0].text).toMatch(/posted by Billion/);
  });
});
