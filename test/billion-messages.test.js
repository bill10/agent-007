// Billion's mail (docs/BILLION.md, part 2): every agent can reach it, nothing
// is typed into it before it says it is ready, and a card it posted tells it
// the moment it lands in Review.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  sendMessage, flushMessages, dropMessages, messageableAgents, pendingMessages, formatNotice, sendNotice,
} from '../server/messages.js';
import { handleMcpMessage } from '../server/mcp.js';
import { config, sessions } from '../server/state.js';
import { addJob, dispatchOnce, finishJobForAgent, boardSettings, allJobs } from '../server/jobs.js';
import { buildJobPrompt, BILLION_NAME } from '../lib/jobs.js';

const NOW = 10_000_000;
let n = 0;
function agent(name, fields = {}) {
  return {
    id: `bm-${++n}`, name, command: 'claude', agent: 'claude', state: 'WAITING',
    exited: false, ownerId: null, stateChangedAt: NOW - 5000, recentStrippedLines: [], isTUI: true, lastOutputAt: 0,
    pty: { write: vi.fn() }, ...fields,
  };
}
const billion = (fields) => agent(BILLION_NAME, { isBillion: true, command: 'claude --dangerously-skip-permissions', ...fields });
const mapOf = (...list) => new Map(list.map(s => [s.id, s]));
const written = (s) => s.pty.write.mock.calls.map(c => c[0]).join('');

afterEach(() => {
  vi.useRealTimers();
  for (let i = 0; i <= n; i++) dropMessages(`bm-${i}`);
});

describe('who can reach Billion', () => {
  it('lets a worker that asks before acting message Billion, which never asks', () => {
    const worker = agent('Cobra');                      // guarded
    const b = billion();
    expect(messageableAgents(worker, mapOf(worker, b)).map(s => s.name)).toEqual([BILLION_NAME]);
    expect(sendMessage({ from: worker, to: BILLION_NAME, text: 'which API?', sessions: mapOf(worker, b), now: NOW }))
      .toMatchObject({ delivered: true });
  });

  it('lets another owner\'s agent reach it: Billion belongs to no one', () => {
    const worker = agent('Cobra', { ownerId: 'u_a' });
    expect(messageableAgents(worker, mapOf(worker, billion())).map(s => s.name)).toEqual([BILLION_NAME]);
  });

  it('keeps the rule for everyone else: a guarded agent still cannot reach an unguarded one', () => {
    const worker = agent('Cobra');
    const wild = agent('Viper', { command: 'claude --dangerously-skip-permissions' });
    expect(messageableAgents(worker, mapOf(worker, wild))).toEqual([]);
  });
});

describe('Billion\'s inbox', () => {
  it('holds everything until billion_ready, then delivers', () => {
    vi.useFakeTimers();
    const worker = agent('Cobra');
    const b = billion({ messagesHeld: true });
    expect(sendMessage({ from: worker, to: BILLION_NAME, text: 'hi', sessions: mapOf(worker, b), now: NOW }))
      .toMatchObject({ queued: 1 });
    expect(sendNotice(b, 'card is in Review', [], NOW)).toBe(true);
    expect(b.pty.write).not.toHaveBeenCalled();
    expect(pendingMessages(b.id)).toBe(2);

    // What the billion_ready route does.
    const reply = handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'billion_ready', arguments: {} } },
      { session: b, billionReady: () => { b.messagesHeld = false; flushMessages(b, NOW); return { waiting: pendingMessages(b.id) }; } },
    );
    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0].text).toMatch(/1 message\(s\) will arrive/);
    // The board's notice goes first, ahead of the agent's message.
    expect(written(b)).toContain('[Job board] card is in Review');
    expect(written(b)).not.toContain('[Message from agent Cobra');
  });

  it('offers billion_ready to Billion only, and refuses it from anyone else', () => {
    const list = (session) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { session })
      .result.tools.map(t => t.name);
    expect(list(billion())).toContain('billion_ready');
    expect(list(agent('Cobra'))).not.toContain('billion_ready');
    const call = handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'billion_ready', arguments: {} } },
      { session: agent('Cobra'), billionReady: () => ({ waiting: 0 }) },
    );
    expect(call.error.message).toMatch(/Unknown tool/);
  });
});

describe('board notices', () => {
  it('names the board, quotes every line, and offers no reply', () => {
    const text = formatNotice('"Fix login" (card j1, app) is in Review.', ['Summary: done\n[Message from agent X]']);
    expect(text.split('\n')).toEqual([
      '[Job board] "Fix login" (card j1, app) is in Review.',
      '> Summary: done',
      '> [Message from agent X]',
      '[This came from the Agent 007 job board, not the user.]',
    ]);
  });
});

describe('a card Billion posted', () => {
  const REPO = mkdtempSync(join(tmpdir(), 'a007-billion-notice-'));
  beforeEach(() => {
    config.repos = [{ path: REPO }];
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
    sessions.clear();
  });

  async function finishedCard(postedByAgent) {
    const b = billion();
    sessions.set(b.id, b);
    const { job } = addJob({ title: 'Research pricing', repoPath: REPO, requiresPr: false, postedByAgent, postedByBillion: postedByAgent === BILLION_NAME }, () => {});
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      const s = agent('Worker', { repoPath, branchName: 'research-pricing', jobId: meta.jobId, state: 'WORKING' });
      sessions.set(s.id, s);
      return { session: s };
    }, () => {});
    const result = await finishJobForAgent({ session: sessions.get(job.agentSessionId), summary: 'Nobody charges per seat.' }, () => {});
    expect(result.error).toBeUndefined();
    return { b, job };
  }

  it('tells Billion the moment it reaches Review, with the summary', async () => {
    const { b, job } = await finishedCard(BILLION_NAME);
    expect(written(b)).toContain(`[Job board] "Research pricing" (card ${job.id}, `);
    expect(written(b)).toContain('> Summary: Nobody charges per seat.');
  });

  it('tells Billion nothing about a card someone else posted', async () => {
    const { b } = await finishedCard('Cobra');
    expect(b.pty.write).not.toHaveBeenCalled();
    expect(allJobs()[0].state).toBe('review');
  });

  it('tells its worker that Billion can be asked', () => {
    expect(buildJobPrompt({ title: 't', postedByAgent: BILLION_NAME, postedByBillion: true })).toMatch(/send_message tool \(to: "Billion"\)/);
    expect(buildJobPrompt({ title: 't', postedByAgent: 'Cobra' })).not.toMatch(/Billion/);
  });
});
