// Answering Billion's questions (server/owner.js): choices, the Q numbers,
// open → answered / dismissed, answers from the app and from Telegram (buttons
// and replies), and waiting.json written before any of that. fetch is mocked:
// nothing here talks to Telegram.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  notifyOwner, handleUpdate, waitingItems, waitingPayload, dismissWaiting, answerWaiting, checkChoices,
  pollOnce, NOTIFY_WINDOW_MS,
} from '../server/owner.js';
import { handleMcpMessage, NOTIFY_OWNER_TOOL } from '../server/mcp.js';
import { dropMessages } from '../server/messages.js';
import { mayAnswerOwner } from '../server/ws.js';
import { USERS_PATH } from '../server/auth.js';
import { sessions, CONFIG_DIR } from '../server/state.js';

const TOKEN = '123456:SECRET-token';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' };
const reply = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
let fetchMock;
let clock = 2e12;
const now = () => (clock += 10 * NOTIFY_WINDOW_MS);
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ method: url.split('/').pop(), body: JSON.parse(init.body) }));

let b;
const typed = () => b.pty.write.mock.calls.map(c => c[0]).join('');

beforeEach(() => {
  fetchMock = vi.fn(async () => reply({ message_id: 900 }));
  vi.stubGlobal('fetch', fetchMock);
  rmSync(join(CONFIG_DIR, 'waiting.json'), { force: true });
  b = {
    id: 'answers-billion', name: 'Billion', isBillion: true, command: 'claude', state: 'WAITING', exited: false,
    ownerId: null, stateChangedAt: Date.now() - 5000, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
  };
  sessions.set(b.id, b);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessions.delete(b.id);
  dropMessages(b.id);
});

const ask = (text, opts = {}) => notifyOwner(text, { env: ENV, now: now(), ...opts });

describe('choices and recommended', () => {
  it('accepts 2 to 5 short distinct choices and a recommended one of them', () => {
    expect(checkChoices(undefined, undefined)).toBeNull();
    expect(checkChoices(['yes', 'no'], 'yes')).toBeNull();
    expect(checkChoices(['a', 'b', 'c', 'd', 'e'])).toBeNull();
    expect(checkChoices(['yes'])).toMatch(/2 to 5/);
    expect(checkChoices(['a', 'b', 'c', 'd', 'e', 'f'])).toMatch(/2 to 5/);
    expect(checkChoices('yes,no')).toMatch(/2 to 5/);
    expect(checkChoices(['yes', ' '])).toMatch(/1 to 40/);
    expect(checkChoices(['yes', 'x'.repeat(41)])).toMatch(/1 to 40/);
    expect(checkChoices(['yes', 'yes'])).toMatch(/differ/);
    expect(checkChoices(['yes', 'no'], 'maybe')).toMatch(/one of the choices/);
    expect(checkChoices(undefined, 'yes')).toMatch(/needs choices/);
    expect(checkChoices(['1', '2'], 1)).toMatch(/one of the choices/);
  });

  it('refuses a bad pick before pinning or sending anything', async () => {
    expect((await ask('Buy?', { choices: ['yes', 'no'], recommended: 'maybe' })).error).toMatch(/one of the choices/);
    expect(waitingItems()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('are in the MCP schema and reach notifyOwner', async () => {
    const { properties } = NOTIFY_OWNER_TOOL.inputSchema;
    expect(properties.choices).toMatchObject({ type: 'array', minItems: 2, maxItems: 5 });
    expect(properties.recommended.type).toBe('string');
    const notify = vi.fn(async () => ({ ok: true, n: 4 }));
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notify_owner', arguments: { text: 'Buy?', choices: ['yes', 'no'], recommended: 'yes' } } },
      { session: { isBillion: true }, notifyOwner: notify });
    expect(notify).toHaveBeenCalledWith('Buy?', { choices: ['yes', 'no'], recommended: 'yes' });
    expect(res.result.content[0].text).toContain('[Owner via app] Q4:');
  });

  it('go to Telegram as buttons, the recommended one marked, callback_data under 64 bytes', async () => {
    expect(await ask('Buy the domain?', { choices: ['yes', 'no'], recommended: 'yes' })).toEqual({ ok: true, n: 1 });
    const [item] = waitingItems();
    expect(item).toMatchObject({ n: 1, status: 'open', choices: ['yes', 'no'], recommended: 'yes', tgMessageId: 900 });
    const { body } = calls()[0];
    expect(body.text).toBe('Billion (Q1): Buy the domain?');
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons.map(x => x.text)).toEqual(['yes (recommended)', 'no']);
    expect(buttons.map(x => x.callback_data)).toEqual([`${item.id}:0`, `${item.id}:1`]);
    for (const x of buttons) expect(Buffer.byteLength(x.callback_data)).toBeLessThanOrEqual(64);
  });
});

describe('answering in the app', () => {
  it('types "[Owner via app] Q<n>: <answer>" with the question for context, and marks it answered', async () => {
    await ask('first');
    await ask('Spend $20 on a domain for the launch page? I recommend yes, it is cheap.', { choices: ['yes', 'no'] });
    const item = waitingItems()[1];
    const broadcast = vi.fn();
    fetchMock.mockClear();
    expect(await answerWaiting(item.id, 'yes', 'app', { broadcast, env: ENV })).toMatchObject({ ok: true });
    expect(typed()).toContain('[Owner via app] Q2: yes (re: "Spend $20 on a domain for the launch page? I recommend yes,…")');
    expect(waitingItems()[1]).toMatchObject({ status: 'answered', answer: 'yes', answeredVia: 'app' });
    expect(broadcast).toHaveBeenCalledWith(waitingPayload());
    // The phone's copy says so and loses its buttons.
    expect(calls()).toEqual([{ method: 'editMessageText', body: { chat_id: '42', message_id: 900, text: `Billion (Q2): ${item.text}\n\nAnswered in app: yes` } }]);
  });

  it('edits the phone\'s copy even when the app answered before the send came back', async () => {
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise(r => { finish = () => r(reply({ message_id: 901 })); }));
    const asked = ask('Ship it?', { choices: ['yes', 'no'] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect((await answerWaiting(waitingItems()[0].id, 'yes', 'app', { env: ENV })).ok).toBe(true);
    finish();
    await asked;
    expect(calls().at(-1)).toEqual({ method: 'editMessageText', body: { chat_id: '42', message_id: 901, text: 'Billion (Q1): Ship it?\n\nAnswered in app: yes' } });
  });

  it('keeps the card open when Billion is not running, and refuses a second answer', async () => {
    await ask('Which name?', { env: {} });
    const [item] = waitingItems();
    sessions.delete(b.id);
    expect(await answerWaiting(item.id, 'Raven', 'app')).toEqual({ error: 'Billion is not running' });
    expect(waitingItems()[0].status).toBe('open');
    sessions.set(b.id, b);
    expect(await answerWaiting(item.id, '  ', 'app')).toEqual({ error: 'The answer is empty.' });
    expect((await answerWaiting(item.id, 'Raven', 'app')).ok).toBe(true);
    expect((await answerWaiting(item.id, 'Crow', 'app')).error).toMatch(/Q1 was answered already: Raven/);
    expect(dismissWaiting(item.id)).toBe(true);
    expect(waitingItems()[0].status).toBe('dismissed');
    expect((await answerWaiting(item.id, 'Crow', 'app')).error).toMatch(/gone/);
    expect(waitingPayload().items).toEqual([]);
  });
});

describe('answering on Telegram', () => {
  const tap = (chat, data, id = 'cq1') => ({ update_id: 1, callback_query: { id, data, message: { chat: { id: chat }, message_id: 900 } } });

  it('a button tap answers the question, acknowledges the tap, and edits the message', async () => {
    await ask('Buy it?', { choices: ['yes', 'no'], recommended: 'yes' });
    const [item] = waitingItems();
    fetchMock.mockClear();
    expect(await handleUpdate(tap(42, `${item.id}:1`), { env: ENV })).toBe('answered');
    expect(typed()).toContain('[Owner via Telegram] Q1: no (re: "Buy it?")');
    expect(waitingItems()[0]).toMatchObject({ status: 'answered', answer: 'no', answeredVia: 'telegram' });
    const sent = calls();
    expect(sent.find(c => c.method === 'editMessageText').body.text).toBe('Billion (Q1): Buy it?\n\nAnswered: no');
    expect(sent.find(c => c.method === 'answerCallbackQuery').body).toEqual({ callback_query_id: 'cq1', text: 'Sent: no' });
    // A second tap only hears that it was answered.
    expect(await handleUpdate(tap(42, `${item.id}:0`, 'cq2'), { env: ENV })).toBe('stale');
    expect(calls().at(-1).body).toEqual({ callback_query_id: 'cq2', text: 'Already answered: no' });
  });

  it('ignores a tap from any other chat, without a word', async () => {
    await ask('Buy it?', { choices: ['yes', 'no'] });
    const [item] = waitingItems();
    fetchMock.mockClear();
    expect(await handleUpdate(tap(43, `${item.id}:0`), { env: ENV })).toBe('ignored');
    expect(await handleUpdate(tap(42, `${item.id}:0`), { env: { TELEGRAM_BOT_TOKEN: TOKEN } })).toBe('ignored');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(b.pty.write).not.toHaveBeenCalled();
    expect(waitingItems()[0].status).toBe('open');
  });

  it('a typed reply to a question answers it; a plain message goes through as before', async () => {
    await ask('Which name?');
    const msg = (text, extra) => ({ update_id: 2, message: { chat: { id: 42 }, text, ...extra } });
    expect(await handleUpdate(msg('Raven', { reply_to_message: { message_id: 900 } }), { env: ENV })).toBe('answered');
    expect(typed()).toContain('[Owner via Telegram] Q1: Raven (re: "Which name?")');
    expect(waitingItems()[0]).toMatchObject({ status: 'answered', answer: 'Raven' });
    expect(await handleUpdate(msg('and ship it', { reply_to_message: { message_id: 555 } }), { env: ENV })).toBe('delivered');
    expect(await handleUpdate(msg('hello'), { env: ENV })).toBe('delivered');
    expect(waitingItems()).toHaveLength(1);
  });

  it('asks Telegram for button taps as well as messages', async () => {
    fetchMock.mockResolvedValueOnce(reply([]));
    await pollOnce(0, { env: ENV });
    expect(calls()[0].body.allowed_updates).toEqual(['message', 'callback_query']);
  });
});

describe('waiting.json from before answers', () => {
  it('reads old items as open, numbered in order, and carries on from there', async () => {
    writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify([
      { id: 'old-1', text: 'Old one', at: '2026-01-01T00:00:00.000Z' },
      { id: 'old-2', text: 'Old two', at: '2026-01-02T00:00:00.000Z' },
    ]));
    expect(waitingItems().map(i => [i.id, i.n, i.status])).toEqual([['old-1', 1, 'open'], ['old-2', 2, 'open']]);
    expect((await answerWaiting('old-2', 'done', 'app')).ok).toBe(true);
    expect(typed()).toContain('[Owner via app] Q2: done');
    expect((await ask('New', { env: {} })).n).toBe(3);
    expect(waitingItems().map(i => [i.n, i.status])).toEqual([[1, 'open'], [2, 'answered'], [3, 'open']]);
  });
});

describe('the list\'s size', () => {
  it('keeps the newest 50 open questions and the newest 30 closed ones', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, n: i + 1, text: 't', at: '', status: i % 2 ? 'open' : 'answered' }));
    writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify(items));
    dismissWaiting('x1');   // any save trims
    const kept = waitingItems();
    expect(kept.filter(i => i.status === 'open')).toHaveLength(49);
    expect(kept.filter(i => i.status !== 'open')).toHaveLength(30);
    expect(kept.at(-1).id).toBe('x99');
  });
});

describe('who may answer', () => {
  it('anyone on a single-user server; nobody once user accounts are on', () => {
    expect(mayAnswerOwner()).toBe(true);
    writeFileSync(USERS_PATH, JSON.stringify([{ id: 'u1', displayName: 'A', color: '#d4a847', tokenHash: 'x' }]));
    try {
      expect(mayAnswerOwner()).toBe(false);
    } finally {
      rmSync(USERS_PATH, { force: true });
    }
  });
});
