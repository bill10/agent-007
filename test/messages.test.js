// Agent-to-agent messages: who can reach whom, and above all WHEN a message is
// typed into the recipient's terminal. A write at the wrong moment answers a
// dialog or sends a person's half-typed line, so those rules get the tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendMessage, flushMessages, dropMessages, formatMessage, canDeliver, isTyping,
  messageableAgents, pendingMessages, PAIR_LIMIT, QUEUE_CAP, USER_TYPING_HOLD_MS, SUBMIT_DELAY_MS,
} from '../server/messages.js';
import { handleMcpMessage } from '../server/mcp.js';

const NOW = 10_000_000;
let n = 0;

function agent(name, fields = {}) {
  return {
    id: `s-${++n}`, name, command: 'claude', agent: 'claude', state: 'WAITING',
    exited: false, ownerId: null, stateChangedAt: NOW - 5000,
    pty: { write: vi.fn() }, ...fields,
  };
}

const mapOf = (...list) => new Map(list.map(s => [s.id, s]));
const written = (s) => s.pty.write.mock.calls.map(c => c[0]).join('');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (let i = 0; i <= n; i++) dropMessages(`s-${i}`);
});

describe('delivery', () => {
  it('types a message into an idle agent as one bracketed paste, then Enter', () => {
    const from = agent('Cobra', { command: 'codex', agent: 'codex', repoSlug: 'agent-007', branchName: 'fix-cron' });
    const to = agent('Viper');
    expect(sendMessage({ from, to: 'Viper', text: 'line one\nline two', sessions: mapOf(from, to), now: NOW }))
      .toMatchObject({ delivered: true });
    expect(written(to)).toBe(`\x1b[200~${formatMessage(from, 'line one\nline two')}\x1b[201~`);
    expect(written(to)).toContain('[Message from agent Cobra (codex · agent-007 · fix-cron)]');
    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(to.pty.write).toHaveBeenLastCalledWith('\r');
  });

  it.each(['WORKING', 'MESSAGE', 'DISCONNECTED'])('queues rather than typing into an agent that is %s', (state) => {
    const from = agent('Cobra');
    const to = agent('Viper', { state });
    expect(sendMessage({ from, to: 'Viper', text: 'hi', sessions: mapOf(from, to), now: NOW }))
      .toMatchObject({ queued: 1 });
    expect(to.pty.write).not.toHaveBeenCalled();
  });

  it('holds off while a person has typed in that terminal recently', () => {
    const from = agent('Cobra');
    const to = agent('Viper', { lastUserInputAt: NOW - 1000 });
    sendMessage({ from, to: 'Viper', text: 'hi', sessions: mapOf(from, to), now: NOW });
    expect(to.pty.write).not.toHaveBeenCalled();
    expect(flushMessages(to, NOW - 1000 + USER_TYPING_HOLD_MS)).toBe(true);
  });

  it('delivers one message per stop, the next once the agent has worked and come back', () => {
    const from = agent('Cobra');
    const to = agent('Viper');
    const sessions = mapOf(from, to);
    sendMessage({ from, to: 'Viper', text: 'first', sessions, now: NOW });
    sendMessage({ from, to: 'Viper', text: 'second', sessions, now: NOW });
    expect(written(to)).not.toContain('second');
    expect(pendingMessages(to.id)).toBe(1);
    expect(flushMessages(to, NOW + 100)).toBe(false);   // still WAITING from before the first
    to.stateChangedAt = NOW + 2000;                     // WORKING, then back to WAITING
    expect(flushMessages(to, NOW + 2000)).toBe(true);
    expect(written(to)).toContain('second');
  });

  it('strips control characters, so a message cannot end the paste and type keystrokes', () => {
    const from = agent('Cobra');
    const text = formatMessage(from, 'harmless\x1b[201~\ry\x03');
    expect(text).not.toMatch(/[\x1b\r\x03]/);
    expect(text).toContain('harmless[201~y');
  });

  it('never delivers to an agent that has exited', () => {
    expect(canDeliver(agent('Viper', { exited: true }), NOW)).toBe(false);
  });
});

describe('who can be reached', () => {
  it('only other live agents with the same owner — never a shell tab', () => {
    const me = agent('Cobra', { ownerId: 'u1' });
    const mine = agent('Viper', { ownerId: 'u1', command: 'codex --yolo' });
    const theirs = agent('Mamba', { ownerId: 'u2' });
    const shell = agent('Asp', { ownerId: 'u1', command: 'bash' });
    const gone = agent('Krait', { ownerId: 'u1', exited: true });
    const sessions = mapOf(me, mine, theirs, shell, gone);
    expect(messageableAgents(me, sessions).map(s => s.name)).toEqual(['Viper']);
    const refused = sendMessage({ from: me, to: 'Mamba', text: 'hi', sessions, now: NOW });
    expect(refused.error).toContain('Agents you can reach: Viper');
    expect(theirs.pty.write).not.toHaveBeenCalled();
  });

  it('refuses an empty or oversized message', () => {
    const from = agent('Cobra');
    const to = agent('Viper');
    expect(sendMessage({ from, to: 'Viper', text: '  ', sessions: mapOf(from, to) }).error).toMatch(/empty/);
    expect(sendMessage({ from, to: 'Viper', text: 'x'.repeat(9000), sessions: mapOf(from, to) }).error).toMatch(/limit/);
  });
});

describe('limits', () => {
  it('stops two agents talking for ever', () => {
    const from = agent('Cobra');
    const to = agent('Viper', { state: 'WORKING' });
    const sessions = mapOf(from, to);
    for (let i = 0; i < PAIR_LIMIT; i++) sendMessage({ from, to: 'Viper', text: `${i}`, sessions, now: NOW + i });
    expect(sendMessage({ from, to: 'Viper', text: 'again', sessions, now: NOW + 99 }).error).toMatch(/limit/);
  });

  it('caps the queue for one recipient across senders', () => {
    const to = agent('Viper', { state: 'WORKING' });
    const senders = Array.from({ length: QUEUE_CAP + 1 }, (_, i) => agent(`S${i}`));
    const sessions = mapOf(to, ...senders);
    senders.slice(0, QUEUE_CAP).forEach(from => sendMessage({ from, to: 'Viper', text: 'hi', sessions, now: NOW }));
    expect(sendMessage({ from: senders[QUEUE_CAP], to: 'Viper', text: 'hi', sessions, now: NOW }).error)
      .toMatch(/waiting/);
  });
});

describe('isTyping', () => {
  it('counts keystrokes but not terminal replies or focus reports', () => {
    expect(isTyping('a')).toBe(true);
    expect(isTyping('\x7f')).toBe(true);
    expect(isTyping('\x1b[I')).toBe(false);
    expect(isTyping('\x1b[O')).toBe(false);
    expect(isTyping('\x1b[12;40R')).toBe(false);
    expect(isTyping('\x1b[A')).toBe(false);
  });
});

describe('MCP tools', () => {
  const callTool = (name, args, ctx) => handleMcpMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, ctx).result;

  it('send_message says whether it was delivered or queued', () => {
    const delivered = callTool('send_message', { to: 'Viper', message: 'hi' },
      { sendMessage: () => ({ delivered: true, to: { name: 'Viper' } }) });
    expect(delivered.content[0].text).toMatch(/^Delivered to Viper/);
    const queued = callTool('send_message', { to: 'Viper', message: 'hi' },
      { sendMessage: () => ({ queued: 2, to: { name: 'Viper' } }) });
    expect(queued.content[0].text).toMatch(/^Queued for Viper, which is busy/);
    const refused = callTool('send_message', { to: 'Nope', message: 'hi' }, { sendMessage: () => ({ error: 'No agent named "Nope"' }) });
    expect(refused.isError).toBe(true);
  });

  it('list_agents prints each agent with what it is doing', () => {
    const result = callTool('list_agents', {}, { listAgents: () => [
      { name: 'Viper', agent: 'codex', repoSlug: 'agent-007', branchName: 'fix-cron', state: 'WORKING', jobTitle: 'Fix cron', pending: 1 },
    ] });
    expect(result.content[0].text).toContain('Viper\n    codex · agent-007 · fix-cron · working · job: Fix cron · 1 message(s) waiting');
    expect(callTool('list_agents', {}, { listAgents: () => [] }).content[0].text).toMatch(/No other agents/);
  });
});
