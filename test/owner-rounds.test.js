// Rounds (server/rounds.js, server/owner.js "Rounds"): notify_owner queues per
// project, a round releases the top two of each and consolidates what the
// last one left open, one Telegram message per round, the first-start
// migration, Billion's queue tools, and the Billion tab's status line
// (server/billion-status.js). fetch is mocked: nothing here talks to Telegram.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  notifyOwner, tellOwner, ownerSays, waitingItems, waitingPayload, chatMessages, answerWaiting, reopenQuestion,
  releaseRound, roundTick, migrateToRounds, roundQueue, dropQueued, NOTIFY_LIMIT, NOTIFY_WINDOW_MS, setOwnerChannel,
  addChat, pendingOwnerMessages, startRoundNow, doneNumbers, markDone, handleUpdate, roundView, START_ROUND_RE,
} from '../server/owner.js';
import {
  roundSettings, nextRound, lastRound, byPriority, roundState, roundPayload, setRoundBrief, appLink, DEFAULT_ROUNDS, MAX_BRIEF_CHARS,
} from '../server/rounds.js';
import {
  setBillionStatus, statusPayload, publishStatus, setStatusFacts, _resetStatus, STATUS_TTL_MS, MAX_STATUS_CHARS, AWAIT_REPLY_MS,
} from '../server/billion-status.js';
import { comingRound } from '../server/rounds.js';
import { handleMcpMessage } from '../server/mcp.js';
import { takeMessages, dropMessages } from '../server/messages.js';
import { sessions, CONFIG_DIR, config } from '../server/state.js';

const TOKEN = '123456:SECRET-token';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' };
const UTC = { on: true, slots: ['08:30', '15:30'], max: 2, timeZone: 'UTC' };
const at = (iso) => Date.parse(iso);
let fetchMock;
let clock = 3e12;
const now = () => (clock += 10 * NOTIFY_WINDOW_MS);
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ method: url.split('/').pop(), body: JSON.parse(init.body) }));

// Held, so nothing is typed: what the server queued for it is read back with takeMessages.
const billion = { id: 'rounds-billion', name: 'Billion', isBillion: true, command: 'claude', state: 'WAITING', exited: false, messagesHeld: true, ownerId: null, pty: { write: vi.fn() } };
const billionHeard = () => takeMessages(billion.id).queue.map(e => e.text);
const ask = (text, opts = {}) => notifyOwner(text, { env: {}, now: now(), ...opts });

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) }));
  vi.stubGlobal('fetch', fetchMock);
  for (const f of ['waiting.json', 'rounds.json', 'chat.json']) rmSync(join(CONFIG_DIR, f), { force: true });
  sessions.set(billion.id, billion);
  dropMessages(billion.id);
  setOwnerChannel(null);
  delete config.rounds;
  delete config.roundMaxPerProject;
  delete config.roundsTimeZone;
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessions.delete(billion.id);
  dropMessages(billion.id);
  _resetStatus();
});

describe('round settings and times', () => {
  it('defaults to 08:30 and 15:30, two per project; [] turns rounds off and a list of nothing valid is a typo', () => {
    expect(roundSettings({})).toEqual({ on: true, slots: DEFAULT_ROUNDS, max: 2, timeZone: undefined });
    expect(roundSettings({ rounds: [] }).on).toBe(false);
    expect(roundSettings({ rounds: ['25:00', 'noon'] }).slots).toEqual(DEFAULT_ROUNDS);
    expect(roundSettings({ rounds: ['16:00', '9:05', '16:00'], roundMaxPerProject: 3, roundsTimeZone: 'America/New_York' }))
      .toEqual({ on: true, slots: ['09:05', '16:00'], max: 3, timeZone: 'America/New_York' });
    expect(roundSettings({ roundMaxPerProject: 0, roundsTimeZone: 'Mars/Base' })).toMatchObject({ max: 2, timeZone: undefined });
    config.rounds = [];
    expect(roundSettings().on).toBe(false);
  });

  it('finds the next and the last round in the owner\'s zone, named for the owner and for Billion', () => {
    expect(nextRound(at('2026-10-01T09:00:00Z'), UTC)).toEqual({ id: '2026-10-01 15:30', at: at('2026-10-01T15:30:00Z'), label: '10/1 pm', name: 'Afternoon round' });
    expect(nextRound(at('2026-10-01T15:30:00Z'), UTC).id).toBe('2026-10-02 08:30');
    expect(nextRound(at('2026-12-31T20:00:00Z'), UTC)).toMatchObject({ id: '2027-01-01 08:30', label: '1/1 am', name: 'Morning round' });
    expect(lastRound(at('2026-10-01T15:30:00Z'), UTC).id).toBe('2026-10-01 15:30');
    expect(lastRound(at('2026-10-01T07:00:00Z'), UTC).id).toBe('2026-09-30 15:30');
    // New York is UTC-4 in October and UTC-5 in December.
    const ny = { ...UTC, timeZone: 'America/New_York' };
    expect(nextRound(at('2026-10-01T12:00:00Z'), ny).at).toBe(at('2026-10-01T12:30:00Z'));
    expect(nextRound(at('2026-12-01T12:00:00Z'), ny).at).toBe(at('2026-12-01T13:30:00Z'));
    expect(nextRound(Date.now(), { ...UTC, on: false })).toBeNull();
  });

  it('orders a queue blocking, normal, low; then rank; then newest', () => {
    const q = (id, urgency, rank, when) => ({ id, urgency, rank, at: when });
    const list = [q('old', 'normal', undefined, '1'), q('new', 'normal', undefined, '2'), q('low', 'low', 1, '3'), q('r2', 'normal', 2, '0'), q('r1', 'normal', 1, '0'), q('blk', 'blocking', undefined, '0')];
    expect(list.sort(byPriority).map(i => i.id)).toEqual(['blk', 'r1', 'r2', 'new', 'old', 'low']);
  });

  it('links the round message to APP_URL, else the first allowed origin', () => {
    expect(appLink({ APP_URL: 'https://mini.tail.ts.net:7007' })).toBe('https://mini.tail.ts.net:7007');
    expect(appLink({ ALLOWED_ORIGINS: 'mini.tail.ts.net,other' })).toMatch(/^http:\/\/mini\.tail\.ts\.net:\d+$/);
    expect(appLink({ ALLOWED_ORIGINS: 'https://mini:7007' })).toBe('https://mini:7007');
    expect(appLink({})).toBe('');
  });
});

describe('notify_owner queues for the round', () => {
  it('queues a normal question: no tab, no thread, no phone, and says where it stands', async () => {
    const broadcast = vi.fn();
    expect(await ask('Name the repo?', { project: 'general', env: ENV, broadcast })).toEqual({ ok: true, queued: true, n: 1, project: 'general', position: 1, of: 1, max: 2 });
    expect(await ask('Rename later?', { project: 'general', urgency: 'low' })).toMatchObject({ position: 2, of: 2 });
    // The newest normal one goes ahead of the older one, and both ahead of low.
    expect(await ask('Pick a logo?', { project: 'general' })).toMatchObject({ n: 3, position: 1, of: 3 });
    expect(waitingItems().map(i => i.status)).toEqual(['queued', 'queued', 'queued']);
    expect(waitingPayload().items).toEqual([]);
    expect(chatMessages().filter(m => m.q)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    // Only the count waiting for the round reaches the tab, never the question.
    expect(broadcast.mock.calls.map(([m]) => m.type)).toEqual(['round-state']);
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'round-state', queued: 1 }));
  });

  it('is not held to the per-minute limit, which is for what reaches the owner', async () => {
    const t = now();
    for (let i = 0; i < NOTIFY_LIMIT + 3; i++) expect((await notifyOwner(`q${i}`, { env: {}, now: t + i })).queued).toBe(true);
  });

  it('sends an emergency at once: blocking, or telegram: true; blocking with telegram: false waits, first in line', async () => {
    expect(await ask('Merge #12? CI is red until you say.', { urgency: 'blocking', env: ENV, project: 'general' })).toEqual({ ok: true, n: 1, telegram: true });
    expect(await ask('Domain expires tonight', { telegram: true, env: ENV })).toEqual({ ok: true, n: 2, telegram: true });
    expect(waitingItems().map(i => [i.status, i.outside])).toEqual([['open', true], ['open', true]]);
    expect(sent().map(c => c.body.text)).toEqual(['! Q1: Merge #12? CI is red until you say.', 'Q2: Domain expires tonight']);
    await ask('Normal', { project: 'general' });
    expect(await ask('Deploy?', { urgency: 'blocking', telegram: false, project: 'general' })).toMatchObject({ queued: true, position: 1 });
  });

  it('takes a rank, 1 first, and refuses one that is not a whole number from 1 to 99', async () => {
    await ask('a', { project: 'x' });
    expect(await ask('b', { project: 'x', rank: 1 })).toMatchObject({ position: 1 });
    expect(waitingItems()[1].rank).toBe(1);
    expect((await ask('c', { rank: 0 })).error).toMatch(/rank/);
    expect((await ask('c', { rank: 1.5 })).error).toMatch(/rank/);
  });

  it('shows everything at once with rounds off ([] in config.json)', async () => {
    config.rounds = [];
    expect(await ask('Name the repo?')).toEqual({ ok: true, n: 1, telegram: false, held: 'urgency normal' });
    expect(waitingItems()[0]).toMatchObject({ status: 'open' });
    expect(waitingItems()[0].outside).toBeUndefined();
  });
});

describe('a round', () => {
  const round = (id = '2026-10-01 15:30', label = '10/1 pm') => ({ id, label, name: 'Afternoon round', at: at('2026-10-01T15:30:00Z') });

  it('releases the top two of each project, consolidates the last round\'s open ones, and keeps the rest queued', async () => {
    const broadcast = vi.fn();
    await ask('A1', { project: 'alpha' });
    await ask('A2', { project: 'alpha', urgency: 'low' });
    await ask('A3', { project: 'alpha', rank: 1 });
    await ask('B1', { project: 'beta' });
    const first = await releaseRound(round('2026-10-01 08:30', '10/1 am'), { broadcast, env: {}, settings: UTC });
    expect(first.released.map(i => i.text)).toEqual(['A3', 'B1', 'A1']);
    expect(first.left).toBe(1);
    expect(waitingPayload().items.map(i => [i.text, i.status, i.round, i.pos])).toEqual([
      ['A1', 'open', '2026-10-01 08:30', 2], ['A3', 'open', '2026-10-01 08:30', 0], ['B1', 'open', '2026-10-01 08:30', 1],
    ]);
    // Each released question is a bubble in the thread, answerable there too.
    expect(chatMessages().filter(m => m.q).map(m => [m.text, m.q.status, m.q.round])).toEqual([
      ['A3', 'open', '2026-10-01 08:30'], ['B1', 'open', '2026-10-01 08:30'], ['A1', 'open', '2026-10-01 08:30'],
    ]);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'round-state', current: expect.objectContaining({ id: '2026-10-01 08:30' }) }));

    // A3 is answered, A1 and B1 are left open; an emergency asked outside the round stays.
    const a3 = waitingItems().find(i => i.text === 'A3');
    expect((await answerWaiting(a3.id, 'yes', 'app', { env: {} })).ok).toBe(true);
    await ask('Now!', { urgency: 'blocking', env: {} });
    billionHeard();
    const second = await releaseRound(round(), { env: {}, settings: UTC });
    expect(second.consolidated.map(i => i.text)).toEqual(['A1', 'B1']);
    expect(second.released.map(i => i.text)).toEqual(['A2']);
    const by = Object.fromEntries(waitingItems().map(i => [i.text, i.status]));
    expect(by).toEqual({ A1: 'consolidated', A2: 'open', A3: 'answered', B1: 'consolidated', 'Now!': 'open' });
    // Consolidated: off the open list and the badge, kept as history, its bubble says so.
    expect(waitingPayload().items.filter(i => i.status === 'consolidated').map(i => i.text)).toEqual(['A1', 'B1']);
    expect(chatMessages().find(m => m.text === 'A1').q.status).toBe('consolidated');
    // Numbered for the owner: the emergency first, then the round's question.
    expect(waitingItems().filter(i => i.status === 'open').map(i => [i.text, i.num])).toEqual([['A2', 2], ['Now!', 1]]);
    expect(billionHeard()).toEqual([`[Owner round] Round 10/1 pm released 1 (item 2 = Q${waitingItems().find(i => i.text === 'A2').n}); consolidated Q1, Q4: re-queue only if still top two.`]);
  });

  it('sends one Telegram message for the round, with the brief and a link, never one per question', async () => {
    for (const p of ['a', 'b', 'c']) { await ask(`${p}1`, { project: p }); await ask(`${p}2`, { project: p }); }
    expect(setRoundBrief('Shipped the billing fix; three choices below.')).toEqual({ ok: true, which: 'next', cleared: false });
    await releaseRound(round(), { env: { ...ENV, APP_URL: 'https://mini:7007' }, settings: UTC });
    expect(sent()).toEqual([{ method: 'sendMessage', body: { chat_id: '42', text: 'Afternoon round: 6 items across 3 departments\n\nShipped the billing fix; three choices below.\nhttps://mini:7007' } }]);
    expect(roundState().current).toMatchObject({ id: '2026-10-01 15:30', brief: 'Shipped the billing fix; three choices below.' });
    expect(roundState().brief).toBeUndefined();
  });

  it('says nothing anywhere when there is nothing to release or consolidate', async () => {
    await releaseRound(round(), { env: ENV, settings: UTC });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(billionHeard()).toEqual([]);
    expect(roundState().lastAt).toBe('2026-10-01T15:30:00.000Z');
  });

  it('will not take an answer for a consolidated question, nor reopen one', async () => {
    await ask('Old', { project: 'a' });
    await releaseRound(round('2026-10-01 08:30'), { env: {}, settings: UTC });
    await releaseRound(round(), { env: {}, settings: UTC });
    const old = waitingItems()[0];
    expect(old.status).toBe('consolidated');
    expect((await answerWaiting(old.id, 'yes', 'app', { env: {} })).error).toMatch(/consolidated/);
    expect((await reopenQuestion({ id: old.id })).error).toMatch(/consolidated/);
  });
});

describe('the server\'s round tick and the first start', () => {
  it('consolidates every open question but blocking ones once, tells Billion, and waits for the next round', async () => {
    writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify([
      { id: 'q1', n: 1, text: 'Old one', at: '2026-09-30T00:00:00Z', status: 'open' },
      { id: 'q2', n: 2, text: 'Stuck merge', at: '2026-09-30T00:00:00Z', status: 'open', urgency: 'blocking' },
      { id: 'q3', n: 3, text: 'Done', at: '2026-09-30T00:00:00Z', status: 'answered', answer: 'ok' },
    ]));
    expect(await roundTick({ now: at('2026-10-01T09:00:00Z'), env: {}, settings: UTC })).toBeNull();
    expect(waitingItems().map(i => i.status)).toEqual(['consolidated', 'open', 'answered']);
    expect(billionHeard()).toEqual(['[Owner round] Rounds are on: the owner now sees your questions only at 08:30 and 15:30, at most 2 per project; notify_owner queues them (see Escalate in CHARTER.md). Consolidated 1 open question (Q1): re-queue only the ones still in a project\'s top two. Next round: 10/1 pm.']);
    expect(migrateToRounds({ settings: UTC })).toBeNull();
    // Not the 08:30 round that passed before the first start; the 15:30 one, once.
    await ask('New', { project: 'a' });
    expect(await roundTick({ now: at('2026-10-01T15:29:59Z'), env: {}, settings: UTC })).toBeNull();
    expect((await roundTick({ now: at('2026-10-01T15:30:05Z'), env: {}, settings: UTC })).released.map(i => i.text)).toEqual(['New']);
    expect(await roundTick({ now: at('2026-10-01T15:31:00Z'), env: {}, settings: UTC })).toBeNull();
    expect(roundPayload(at('2026-10-01T15:31:00Z'), UTC)).toMatchObject({ type: 'round-state', on: true, max: 2, current: { id: '2026-10-01 15:30', label: '10/1 pm' }, next: { id: '2026-10-02 08:30' } });
  });

  it('releases a missed round once after a long stop, and keeps a line for a Billion that is not running', async () => {
    sessions.delete(billion.id);
    await roundTick({ now: at('2026-10-01T09:00:00Z'), env: {}, settings: UTC });
    await ask('Waiting', { project: 'a' });
    const result = await roundTick({ now: at('2026-10-03T10:00:00Z'), env: {}, settings: UTC });
    expect(result.released.map(i => i.text)).toEqual(['Waiting']);
    expect(roundState().current.id).toBe('2026-10-03 08:30');
    expect(roundState().note).toMatch(/Rounds are on[\s\S]*Round 10\/3 am released 1/);
    sessions.set(billion.id, billion);
    await roundTick({ now: at('2026-10-03T10:00:10Z'), env: {}, settings: UTC });
    expect(roundState().note).toBeUndefined();
    expect(billionHeard()).toHaveLength(1);
  });

  it('does nothing with rounds off', async () => {
    expect(await roundTick({ now: Date.now(), settings: { ...UTC, on: false } })).toBeNull();
    expect(roundState()).toEqual({});
  });
});

describe('Billion\'s round tools over MCP', () => {
  const call = (name, args, ctx) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { session: { isBillion: true }, ...ctx });
  const text = (res) => res.result.content[0].text;
  const next = { id: '2026-10-01 15:30', label: '10/1 pm' };

  it('are Billion\'s only', () => {
    const list = (session) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { session }).result.tools.map(t => t.name);
    for (const name of ['list_round_queue', 'drop_queued', 'set_round_brief', 'set_status']) {
      expect(list({ isBillion: true })).toContain(name);
      expect(list({})).not.toContain(name);
    }
  });

  it('notify_owner says which round and where in the project\'s queue, and passes rank', async () => {
    const notify = vi.fn(async () => ({ ok: true, queued: true, n: 7, project: 'agent-007', position: 1, of: 1, max: 2, nextRound: next }));
    expect(text(await call('notify_owner', { text: 'Ship?', rank: 2 }, { notifyOwner: notify })))
      .toBe('Queued as Q7 for the 15:30 round (10/1 pm), position 1 of 2 in agent-007. The owner sees it then, not before; their answer arrives here as [Owner via app] Q7: …. Keep working on everything else.');
    expect(notify).toHaveBeenCalledWith('Ship?', expect.objectContaining({ rank: 2 }));
    const behind = vi.fn(async () => ({ ok: true, queued: true, n: 8, project: 'agent-007', position: 3, of: 3, max: 2, nextRound: next }));
    expect(text(await call('notify_owner', { text: 'And?' }, { notifyOwner: behind }))).toMatch(/^Queued as Q8, position 3 in agent-007: behind the top 2, so it is not in the 15:30 round/);
  });

  it('says emergencies only in the description', async () => {
    const { NOTIFY_OWNER_TOOL } = await import('../server/mcp.js');
    expect(NOTIFY_OWNER_TOOL.description).toMatch(/EMERGENCIES ONLY/);
    expect(NOTIFY_OWNER_TOOL.inputSchema.properties.urgency.description).toMatch(/cannot wait\s+for the next round/);
  });

  it('list_round_queue lists the queue by project, and drop_queued takes one out', async () => {
    await ask('Alpha one', { project: 'alpha' });
    await ask('Alpha two', { project: 'alpha', urgency: 'low' });
    await ask('Alpha three', { project: 'alpha', rank: 1 });
    await ask('Beta', { project: 'beta' });
    const ctx = { listRoundQueue: () => ({ ...roundQueue(UTC), nextRound: next }), dropQueued };
    expect(text(await call('list_round_queue', {}, ctx))).toBe([
      '0 question(s) open on the owner\'s screen now. Next: the 15:30 round (10/1 pm), taking the top 2 of each project.',
      '',
      'alpha (3)',
      '  1. Q3 [rank 1, next round] Alpha three',
      '  2. Q1 [next round] Alpha one',
      '  3. Q2 [low, later] Alpha two',
      '',
      'beta (1)',
      '  1. Q4 [next round] Beta',
    ].join('\n'));
    expect(text(await call('drop_queued', { number: 2 }, ctx))).toBe('Dropped Q2 from the round queue; the owner will not see it.');
    expect(waitingItems()[1]).toMatchObject({ status: 'dismissed', dropped: true });
    expect(text(await call('drop_queued', { number: 2 }, ctx))).toBe('Q2 is not queued (it is dismissed).');
    expect(text(await call('drop_queued', {}, ctx))).toBe('Name the question by number or id.');
    expect(dropQueued({ number: 99 }).error).toBe('There is no Q99.');
  });

  it('set_round_brief sets the next round\'s or the current one\'s, up to its length', async () => {
    const ctx = { setRoundBrief };
    expect(text(await call('set_round_brief', { text: 'Quiet morning.' }, ctx))).toBe('The brief is set for the next round.');
    expect(roundState().brief).toBe('Quiet morning.');
    expect(text(await call('set_round_brief', { text: 'x', round: 'current' }, ctx))).toMatch(/No round has been released yet/);
    expect(text(await call('set_round_brief', { text: 'x'.repeat(MAX_BRIEF_CHARS + 1) }, ctx))).toMatch(/keep it to 600/);
    expect(text(await call('set_round_brief', { text: '' }, ctx))).toBe('Cleared the brief for the next round.');
  });
});

describe('the status line', () => {
  it('shows Billion\'s words until they are 30 minutes old, with what the server knows', () => {
    const b = { state: 'WORKING', exited: false };
    setStatusFacts(() => ({ billion: b, workers: 3, nextRoundAt: 123 }));
    expect(setBillionStatus('  reviewing   PR #120 ', 1000)).toEqual({ ok: true, cleared: false });
    expect(statusPayload(1000)).toEqual({ type: 'billion-status', text: 'reviewing PR #120', running: true, working: true, workers: 3, nextRoundAt: 123, awaitingReply: false, pending: [], currentRequest: null, steps: [], progress: {} });
    expect(statusPayload(1000 + STATUS_TTL_MS).text).toBe('');
    expect(setBillionStatus('x'.repeat(MAX_STATUS_CHARS + 1)).error).toMatch(/140/);
    expect(setBillionStatus('').cleared).toBe(true);
    b.state = 'WAITING';
    expect(statusPayload()).toMatchObject({ working: false, text: '' });
    setStatusFacts(() => ({}));
    expect(statusPayload()).toMatchObject({ running: false, working: false, workers: 0, nextRoundAt: null });
  });

  it('says Billion is on the owner\'s message from when it is sent until Billion\'s next tell_owner', async () => {
    setStatusFacts(() => ({ billion }));
    const broadcast = vi.fn();
    expect((await ownerSays('How is the launch going?', { broadcast, env: {} })).ok).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'billion-status', awaitingReply: true }));
    expect(publishStatus(broadcast)).toBe(false);   // only on a change
    expect((await tellOwner('Going well.', { broadcast, env: {}, now: now() })).ok).toBe(true);
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'billion-status', awaitingReply: false }));
  });

  it('set_status over MCP', async () => {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_status', arguments: { text: 'reviewing PR #120' } } },
      { session: { isBillion: true }, setStatus: (t) => setBillionStatus(t) });
    expect(res.result.content[0].text).toBe('Status shown in the owner\'s Billion tab.');
    expect(statusPayload().text).toBe('reviewing PR #120');
    const listed = handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { session: { isBillion: true } });
    const description = listed.result.tools.find(tool => tool.name === 'set_status').description;
    expect(description).toContain('current step, findings');
    expect(description).toContain('uncertainty or blocker, and next check');
    expect(description).toContain('Never include private reasoning, raw analysis, tool output, command arguments or secrets');
    expect(description).toContain('Work details');
    expect(description).not.toContain('reads off your screen');
  });
});

it('keeps a queued question past the closed-items cap, like an open one', async () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, n: i + 1, text: `old ${i}`, at: '2026-09-01T00:00:00Z', status: 'answered', answer: 'ok' }));
  writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify([{ id: 'q', n: 100, text: 'queued', at: '2026-09-01T00:00:00Z', status: 'queued', project: 'a' }, ...items]));
  await ask('one more', { project: 'a' });
  expect(JSON.parse(readFileSync(join(CONFIG_DIR, 'waiting.json'), 'utf8')).filter(i => i.status === 'queued').map(i => i.id)).toContain('q');
});

it('caps queued questions on their own, so a long queue never pushes an open question out', async () => {
  const open = Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, n: i + 1, text: `open ${i}`, at: '2026-09-01T00:00:00Z', status: 'open', project: 'a' }));
  const queued = Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, n: 100 + i, text: `queued ${i}`, at: '2026-09-01T00:00:00Z', status: 'queued', project: 'a' }));
  writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify([...open, ...queued]));
  await ask('one more', { project: 'a' });
  const saved = JSON.parse(readFileSync(join(CONFIG_DIR, 'waiting.json'), 'utf8'));
  expect(saved.filter(i => i.status === 'open')).toHaveLength(50);
  expect(saved.filter(i => i.status === 'queued').map(i => i.text)).not.toContain('queued 0');
  expect(saved.filter(i => i.status === 'queued').map(i => i.text)).toContain('one more');
});

describe('the owner starts a round early', () => {
  it('releases the next round now under the same rules, and the clock does not release it again', async () => {
    const t = at('2026-10-01T13:00:00Z');
    await roundTick({ now: at('2026-10-01T09:00:00Z'), env: {}, settings: UTC });
    billionHeard();
    for (const p of ['a', 'a', 'a', 'b']) await ask(`${p} question`, { project: p });
    const result = await startRoundNow({ now: t, env: {}, settings: UTC });
    expect(result.released.map(i => i.project)).toEqual(['b', 'a', 'a']);
    expect(result.left).toBe(1);
    expect(roundState().current).toMatchObject({ id: '2026-10-01 15:30', early: true });
    expect(billionHeard()[0]).toMatch(/^\[Owner round\] Round 10\/1 pm \(started early by the owner\) released 3 \(item 1 = Q\d+, item 2 = Q\d+, item 3 = Q\d+\); 1 still queued/);
    expect(await roundTick({ now: at('2026-10-01T15:30:05Z'), env: {}, settings: UTC })).toBeNull();
    expect(comingRound(at('2026-10-01T15:31:00Z'), UTC).id).toBe('2026-10-02 08:30');
    expect(roundView(t, UTC)).toMatchObject({ queued: 1, next: { id: '2026-10-02 08:30' } });
  });

  it('is refused with rounds off', async () => {
    expect((await startRoundNow({ settings: { ...UTC, on: false } })).error).toMatch(/Rounds are off/);
  });

  it('is what "start the round now" in the chat does, and it is not a turn of Billion\'s', async () => {
    for (const phrase of ['Start the round now', 'start round', 'please release the next round.', 'Begin the round now!']) expect(START_ROUND_RE.test(phrase)).toBe(true);
    for (const phrase of ['start the round after lunch', 'when does the round start?']) expect(START_ROUND_RE.test(phrase)).toBe(false);
    await ask('Queued one', { project: 'a' });
    expect(await ownerSays('Start the round now', { env: {} })).toEqual({ ok: true });
    expect(waitingItems()[0]).toMatchObject({ status: 'open', num: 1 });
    expect(billionHeard().filter(l => l.startsWith('[Owner via app]'))).toEqual([]);
    expect(chatMessages().at(-1)).toMatchObject({ from: 'owner', text: 'Start the round now' });
  });
});

describe('numbered items and "1d"', () => {
  it('reads "1d", "1d 3d" and "1d, 3d", and nothing else', () => {
    expect(doneNumbers('1d')).toEqual([1]);
    expect(doneNumbers(' 1d 3D ')).toEqual([1, 3]);
    expect(doneNumbers('1d, 3d,1d')).toEqual([1, 3]);
    expect(doneNumbers('2 d')).toEqual([2]);
    for (const text of ['1', 'd', '1d3d', 'done 1', '1day', '12 dogs']) expect(doneNumbers(text)).toBeNull();
  });

  it('numbers an emergency next in the round, and marks items done: folded as done, Billion told which', async () => {
    await ask('Pick a name', { project: 'a' });
    await releaseRound({ id: 'r1', label: '10/1 am', name: 'Morning round', at: at('2026-10-01T08:30:00Z') }, { env: {}, settings: UTC });
    await ask('2FA code please', { urgency: 'blocking', env: {} });
    expect(waitingItems().map(i => [i.text, i.num, i.numRound])).toEqual([['Pick a name', 1, 'r1'], ['2FA code please', 2, 'r1']]);
    billionHeard();
    expect(await ownerSays('1d 2d 7d', { env: {} })).toEqual({ ok: true, note: 'No open item 7.' });
    expect(waitingItems().map(i => [i.status, i.answer, i.done])).toEqual([['answered', 'done', true], ['answered', 'done', true]]);
    expect(billionHeard()).toEqual(['[Owner via app] item 1 done (Q1: "Pick a name"); item 2 done (Q2: "2FA code please")']);
    expect(chatMessages().find(m => m.q?.n === 1).q).toMatchObject({ status: 'answered', done: true, num: 1 });
    expect((await ownerSays('1d', { env: {} })).error).toBe('No open item 1 in this round.');
  });

  it('works from Telegram too, with a reply saying what was done', async () => {
    await ask('Pick a name', { project: 'a' });
    await releaseRound({ id: 'r1', label: '10/1 am', name: 'Morning round', at: at('2026-10-01T08:30:00Z') }, { env: {}, settings: UTC });
    fetchMock.mockClear();
    expect(await handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '1d' } }, { env: ENV })).toBe('done');
    expect(sent().map(c => c.body.text)).toEqual(['Done: item 1.']);
    expect(billionHeard()).toContain('[Owner via Telegram] item 1 done (Q1: "Pick a name")');
  });

  it('needs Billion running, like an answer', async () => {
    await ask('Pick', { urgency: 'blocking', env: {} });
    sessions.delete(billion.id);
    expect((await markDone([1])).error).toBe('Billion is not running');
    expect(waitingItems()[0].status).toBe('open');
  });
});

describe('the owner\'s messages wait for replies of their own', () => {
  it('keeps each message pending until a tell_owner answers it, oldest first; a server notice answers none', async () => {
    setStatusFacts(() => ({ billion }));
    await ownerSays('First question?', { env: {} });
    await ownerSays('Second question?', { env: {} });
    const [first, second] = chatMessages().filter(m => m.from === 'owner').map(m => m.id);
    expect(statusPayload().pending).toEqual([first, second]);
    await tellOwner('Account switched.', { env: {}, now: now(), notice: true });
    expect(statusPayload().pending).toEqual([first, second]);
    await tellOwner('Answer one.', { env: {}, now: now() });
    expect(chatMessages().at(-1)).toMatchObject({ text: 'Answer one.', replyTo: first });
    expect(statusPayload()).toMatchObject({ pending: [second], awaitingReply: true });
    await tellOwner('Answer two.', { env: {}, now: now() });
    expect(statusPayload()).toMatchObject({ pending: [], awaitingReply: false });
  });

  it('retains unanswered requests through chat pruning, then releases answered records', async () => {
    await ownerSays('First?', { env: {} });
    const first = chatMessages().at(-1).id;
    setBillionStatus('Checking first');
    const saved = chatMessages();
    for (let i = 0; i < 499; i++) saved.push({ id: `notice-${i}`, from: 'billion', notice: true, text: 'System update' });
    writeFileSync(join(CONFIG_DIR, 'chat.json'), JSON.stringify(saved));
    await ownerSays('Second?', { env: {} });
    const second = chatMessages().at(-1).id;
    _resetStatus();
    expect(chatMessages()).toHaveLength(500);
    expect(pendingOwnerMessages().map(m => m.id)).toEqual([first, second]);
    await tellOwner('First answer.', { env: {}, now: now() });
    expect(chatMessages().at(-1)).toMatchObject({ replyTo: first, workDetails: ['Checking first'] });
    expect(chatMessages().some(m => m.id === first)).toBe(false);
    await tellOwner('Second answer.', { env: {}, now: now() });
    expect(chatMessages().at(-1).replyTo).toBe(second);
    expect(pendingOwnerMessages()).toEqual([]);
    // Once answered, pruning the answer cannot reopen a retained owner record.
    const secondMessage = chatMessages().find(m => m.id === second);
    expect(secondMessage.awaitsReply).toBe(false);
    writeFileSync(join(CONFIG_DIR, 'chat.json'), JSON.stringify([secondMessage]));
    addChat({ from: 'billion', text: 'Later update', notice: true });
    expect(pendingOwnerMessages()).toEqual([]);
  });

  it('accepts only explicit status summaries, never reading raw analysis, tool calls or secrets off the screen', async () => {
    const getAll = vi.fn(() => ['private analysis\n• Ran echo SECRET_COMMAND_OUTPUT\n⏺ Bash(secret)']);
    setStatusFacts(() => ({ billion: { ...billion, state: 'WORKING', ringBuffer: { getAll } } }));
    await ownerSays('Check it.', { env: {} });
    const id = chatMessages().at(-1).id;
    expect(statusPayload()).toMatchObject({ steps: [], progress: { [id]: [] } });
    vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN);
    try {
      setBillionStatus(`Checking evidence ${TOKEN}`);
      expect(statusPayload().progress[id]).toEqual(['Checking evidence <token>']);
      expect(readFileSync(join(CONFIG_DIR, 'chat.json'), 'utf8')).not.toContain(TOKEN);
    } finally { vi.unstubAllEnvs(); }
    expect(getAll).not.toHaveBeenCalled();
    expect(JSON.stringify(statusPayload())).not.toMatch(/SECRET_COMMAND_OUTPUT|private analysis|Bash/);
  });

  it('keeps progress intact when a status is cleared or refused, and never copies pre-request status', async () => {
    setStatusFacts(() => ({ billion }));
    setBillionStatus('Earlier background work');
    await ownerSays('New question?', { env: {} });
    const id = chatMessages().at(-1).id;
    expect(statusPayload().progress[id]).toEqual([]);
    setBillionStatus('Checking evidence');
    expect(setBillionStatus(null)).toHaveProperty('error');
    expect(setBillionStatus('x'.repeat(MAX_STATUS_CHARS + 1))).toHaveProperty('error');
    expect(setBillionStatus('  ')).toEqual({ ok: true, cleared: true });
    expect(statusPayload()).toMatchObject({ text: '', progress: { [id]: ['Checking evidence'] } });
    await tellOwner('Answer.', { env: {}, now: now() });
    expect(chatMessages().at(-1)).toMatchObject({ replyTo: id, workDetails: ['Checking evidence'] });
  });

  it('persists distinct summaries and oldest-first bindings across a server restart, without stale activity', async () => {
    setStatusFacts(() => ({ billion }));
    await ownerSays('First?', { env: {} });
    const first = chatMessages().at(-1).id;
    for (const text of ['Starting', 'Found evidence', 'Checking uncertainty', 'Next: verify', 'Next: verify']) setBillionStatus(text);
    await ownerSays('Second?', { env: {} });
    const second = chatMessages().at(-1).id;
    _resetStatus();
    expect(statusPayload()).toMatchObject({ running: false, pending: [], awaitingReply: false });
    setStatusFacts(() => ({ billion }));
    expect(statusPayload()).toMatchObject({ pending: [first, second], progress: { [first]: ['Found evidence', 'Checking uncertainty', 'Next: verify'], [second]: [] } });
    expect(statusPayload(Date.now() + AWAIT_REPLY_MS)).toMatchObject({ pending: [], awaitingReply: false });
    const saved = chatMessages();
    saved[0].at = new Date(Date.now() - AWAIT_REPLY_MS - 1).toISOString();
    writeFileSync(join(CONFIG_DIR, 'chat.json'), JSON.stringify(saved));
    expect(statusPayload()).toMatchObject({ pending: [second], currentRequest: first });
    await tellOwner('Worker finished.', { env: {}, now: now(), notice: true });
    expect(statusPayload().pending).toEqual([second]);
    await tellOwner('First answer.', { env: {}, now: now() });
    expect(chatMessages().at(-1)).toMatchObject({ replyTo: first, workDetails: ['Found evidence', 'Checking uncertainty', 'Next: verify'] });
    setBillionStatus('Checking second');
    await tellOwner('Second answer.', { env: {}, now: now() });
    expect(chatMessages().at(-1)).toMatchObject({ replyTo: second, workDetails: ['Checking second'] });
    _resetStatus();
    setStatusFacts(() => ({ billion }));
    expect(statusPayload()).toMatchObject({ pending: [], progress: {} });
  });
});
