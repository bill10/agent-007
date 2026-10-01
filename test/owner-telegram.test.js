// Billion reaching the owner (server/owner.js): notify_owner, the "Waiting on
// you" list, and Telegram both ways. fetch is mocked throughout: no test here
// talks to Telegram.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  notifyOwner, tellOwner, sendTelegram, handleUpdate, pollOnce, startTelegram, stopTelegram,
  waitingItems, dismissWaiting, redact, NOTIFY_LIMIT, NOTIFY_WINDOW_MS, chatMessages,
  ownerSays, setOwnerChannel, lastOwnerChannel, splitForTelegram,
} from '../server/owner.js';
import { handleMcpMessage } from '../server/mcp.js';
import { dropMessages } from '../server/messages.js';
import { _resetStatus } from '../server/billion-status.js';
import { sessions, CONFIG_DIR } from '../server/state.js';

const TOKEN = '123456:SECRET-token';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' };
const reply = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
let fetchMock;
// Far apart per test, so the module's rate-limit window never carries over.
let clock = 1e12;
const now = () => (clock += 10 * NOTIFY_WINDOW_MS);

const billion = () => ({
  id: 'owner-billion', name: 'Billion', isBillion: true, command: 'claude --dangerously-skip-permissions',
  state: 'WAITING', exited: false, ownerId: null, stateChangedAt: Date.now() - 5000,
  recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
});
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init.body) }));

beforeEach(() => {
  fetchMock = vi.fn(async () => reply(true));
  vi.stubGlobal('fetch', fetchMock);
  rmSync(join(CONFIG_DIR, 'waiting.json'), { force: true });
  rmSync(join(CONFIG_DIR, 'chat.json'), { force: true });
  _resetStatus();
  setOwnerChannel(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessions.delete('owner-billion');
  dropMessages('owner-billion');
  stopTelegram();
});

describe('notify_owner', () => {
  it('sends "Q<n>: <text>", no "Billion" prefix, to the owner\'s chat and pins it', async () => {
    const broadcast = vi.fn();
    expect(await notifyOwner('Spend $20 on a domain? I recommend yes.', { env: ENV, now: now(), broadcast, telegram: true })).toEqual({ ok: true, n: 1, telegram: true });
    const [c] = calls();
    expect(c.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(c.body).toEqual({ chat_id: '42', text: 'Q1: Spend $20 on a domain? I recommend yes.' });
    expect(waitingItems().map(i => i.text)).toEqual(['Spend $20 on a domain? I recommend yes.']);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'waiting-list' }));
  });

  it('with rounds off, pushes only blocking questions by default; telegram overrides it either way', async () => {
    const broadcast = vi.fn();
    expect(await notifyOwner('Name the repo?', { env: ENV, now: now(), broadcast, queue: false })).toEqual({ ok: true, n: 1, telegram: false, held: 'urgency normal' });
    expect(await notifyOwner('Rename later?', { urgency: 'low', env: ENV, now: now(), queue: false })).toEqual({ ok: true, n: 2, telegram: false, held: 'urgency low' });
    expect(fetchMock).not.toHaveBeenCalled();
    // Still filed in the tab: the open-questions strip, the badge, the thread.
    expect(waitingItems().map(i => i.text)).toEqual(['Name the repo?', 'Rename later?']);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'waiting-list' }));
    expect(chatMessages().filter(m => m.q).slice(-2).map(m => m.text)).toEqual(['Name the repo?', 'Rename later?']);

    expect(await notifyOwner('Merge #12?', { urgency: 'blocking', env: ENV, now: now() })).toEqual({ ok: true, n: 3, telegram: true });
    expect(await notifyOwner('Domain expires tonight, renew?', { env: ENV, now: now(), telegram: true })).toEqual({ ok: true, n: 4, telegram: true });
    expect(await notifyOwner('Deploy now?', { urgency: 'blocking', telegram: false, env: ENV, now: now(), queue: false })).toEqual({ ok: true, n: 5, telegram: false, held: 'telegram: false' });
    expect(calls().map(c => c.body.text)).toEqual(['! Q3: Merge #12?', 'Q4: Domain expires tonight, renew?']);
    expect((await notifyOwner('x', { telegram: 'yes', env: ENV, now: now() })).error).toBe('telegram must be true or false.');
  });

  it('says in the tool result whether it went to Telegram', async () => {
    const text = async (result) => (await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'notify_owner', arguments: { text: 'hi', telegram: true } } },
      { session: { isBillion: true }, notifyOwner: async (_, opts) => { expect(opts.telegram).toBe(true); return result; } })).result.content[0].text;
    expect(await text({ ok: true, n: 12, telegram: false, held: 'urgency normal' })).toMatch(/^Put in the owner's Billion tab as Q12; not sent to Telegram \(urgency normal\)\. /);
    expect(await text({ ok: true, n: 3, telegram: true })).toMatch(/^Put in the owner's Billion tab as Q3 and sent on Telegram\. /);
  });

  it('a non-blocking question without Telegram settings is simply filed', async () => {
    expect(await notifyOwner('Which logo?', { env: {}, now: now(), queue: false })).toEqual({ ok: true, n: 1, telegram: false, held: 'urgency normal' });
  });

  it('is off without Telegram settings: pins it, says so, and never calls fetch', async () => {
    const result = await notifyOwner('Which name?', { urgency: 'blocking', env: {}, now: now() });
    expect(result.error).toMatch(/Telegram is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitingItems().map(i => i.text)).toEqual(['Which name?']);
    expect(startTelegram({ env: {} })).toBe(false);
  });

  it('turns a failed send into an error Billion reads, with the token redacted', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
    const result = await notifyOwner('hi', { urgency: 'blocking', env: ENV, now: now() });
    expect(result.error).toMatch(/Telegram send failed/);
    expect(result.error).not.toContain(TOKEN);
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) });
    expect((await sendTelegram('x', { env: ENV })).error).toBe('Bad Request: chat not found');
    expect(redact(`a ${TOKEN} b ${encodeURIComponent(TOKEN)}`, ENV)).toBe('a <token> b <token>');
  });

  it('allows a burst, then refuses until the minute has passed', async () => {
    const t = now();
    for (let i = 0; i < NOTIFY_LIMIT; i++) expect(await notifyOwner(`q${i}`, { telegram: true, env: ENV, now: t + i })).toEqual({ ok: true, n: i + 1, telegram: true });
    const refused = await notifyOwner('one more', { env: ENV, now: t + 10, queue: false });
    expect(refused.error).toMatch(/last minute/);
    expect(fetchMock).toHaveBeenCalledTimes(NOTIFY_LIMIT);
    expect(waitingItems()).toHaveLength(NOTIFY_LIMIT);
    expect(await notifyOwner('later', { telegram: true, env: ENV, now: t + NOTIFY_WINDOW_MS + 1 })).toMatchObject({ ok: true, n: NOTIFY_LIMIT + 1 });
  });

  it('refuses empty text', async () => {
    expect((await notifyOwner('  ', { env: ENV, now: now() })).error).toMatch(/empty/);
  });

  describe('follows the channel of the owner\'s last message', () => {
    const texts = () => calls().filter(c => c.url.endsWith('/sendMessage')).map(c => c.body.text);
    beforeEach(() => { const b = billion(); sessions.set(b.id, b); });

    it('reaches the phone before any owner message this run', async () => {
      expect(lastOwnerChannel()).toBe(null);
      expect(await tellOwner('Morning status', { env: ENV, now: now() })).toEqual({ ok: true, telegram: true });
      expect(texts()).toEqual(['Morning status']);
    });

    it('stays in the tab after a message from the app', async () => {
      expect(await ownerSays('how is the build?', { env: ENV })).toEqual({ ok: true });
      expect(await tellOwner('Green.', { env: ENV, now: now() })).toEqual({ ok: true, telegram: false, tabOnly: true });
      expect(texts()).toEqual([]);
      expect(chatMessages().at(-1)).toMatchObject({ from: 'billion', text: 'Green.' });
    });

    it('goes to the phone again once the owner writes on Telegram', async () => {
      await ownerSays('from the tab', { env: ENV });
      expect(await handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: 'from the phone' } }, { env: ENV })).toBe('delivered');
      expect(await tellOwner('Got it.', { env: ENV, now: now() })).toEqual({ ok: true, telegram: true });
      expect(texts()).toEqual(['Got it.']);
    });

    it('never holds back a notify_owner question', async () => {
      await ownerSays('from the tab', { env: ENV });
      expect((await notifyOwner('Merge #12?', { urgency: 'blocking', env: ENV, now: now() })).ok).toBe(true);
      expect(texts()).toEqual([expect.stringMatching(/^! Q\d+: Merge #12\?$/)]);
    });

    it('says in the tool result that it stayed in the tab', async () => {
      const call = handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tell_owner', arguments: { text: 'hi' } } },
        { session: { isBillion: true }, tellOwner: async () => ({ ok: true, telegram: false, tabOnly: true }) });
      expect((await call).result.content[0].text).toMatch(/Billion tab \(their last message came from the tab, so not sent on Telegram\)/);
    });
  });

  it('is Billion\'s tool only, over MCP', async () => {
    const list = (session) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { session }).result.tools.map(t => t.name);
    expect(list({ isBillion: true })).toContain('notify_owner');
    expect(list({})).not.toContain('notify_owner');
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'notify_owner', arguments: { text: 'hi' } } },
      { session: { isBillion: true }, notifyOwner: async () => ({ error: 'nope' }) });
    expect(res.result).toMatchObject({ isError: true, content: [{ text: 'nope' }] });
  });
});

describe('tell_owner', () => {
  it('sends the text alone, shows a bubble in the Billion tab and files no Waiting item', async () => {
    const broadcast = vi.fn();
    expect(await tellOwner('Got it, restart looks clean.', { env: ENV, now: now(), broadcast })).toEqual({ ok: true, telegram: true });
    expect(calls()).toEqual([{ url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, body: { chat_id: '42', text: 'Got it, restart looks clean.' } }]);
    expect(waitingItems()).toEqual([]);
    expect(broadcast.mock.calls.map(c => c[0].type)).toEqual(['chat-message', 'billion-status']);
    expect(chatMessages().at(-1)).toMatchObject({ from: 'billion', text: 'Got it, restart looks clean.' });
  });

  it('still shows in the tab without Telegram, and says so', async () => {
    expect(await tellOwner('hi', { env: {}, now: now() })).toEqual({ ok: true, telegram: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitingItems()).toEqual([]);
    expect(chatMessages().at(-1)).toMatchObject({ from: 'billion', text: 'hi' });
  });

  it('keeps the bubble and notes a failed Telegram send', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, json: async () => ({ ok: false, error_code: 500, description: `boom ${TOKEN}` }) }));
    const result = await tellOwner('status', { env: ENV, now: now() });
    expect(result).toEqual({ ok: true, note: 'The Telegram send failed: boom <token>' });
    expect(chatMessages().at(-1).text).toBe('status');
  });

  it('shares notify_owner\'s rate limit', async () => {
    const t = now();
    for (let i = 0; i < NOTIFY_LIMIT - 1; i++) expect((await notifyOwner(`q${i}`, { telegram: true, env: ENV, now: t + i })).ok).toBe(true);
    expect(await tellOwner('ok', { env: ENV, now: t + 5 })).toEqual({ ok: true, telegram: true });
    expect((await tellOwner('again', { env: ENV, now: t + 6 })).error).toMatch(/last minute/);
    expect((await notifyOwner('more', { env: ENV, now: t + 7, queue: false })).error).toMatch(/last minute/);
    expect(fetchMock).toHaveBeenCalledTimes(NOTIFY_LIMIT);
  });

  it('refuses empty or oversized text', async () => {
    expect((await tellOwner(' ', { env: ENV, now: now() })).error).toMatch(/empty/);
    expect((await tellOwner('x'.repeat(5000), { env: ENV, now: now() })).error).toMatch(/keep it under/);
  });

  it('is Billion\'s tool only, over MCP', async () => {
    const list = (session) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { session }).result.tools.map(t => t.name);
    expect(list({ isBillion: true })).toContain('tell_owner');
    expect(list({})).not.toContain('tell_owner');
    const call = (ctx) => handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tell_owner', arguments: { text: 'hi' } } }, ctx);
    expect((await call({ session: {} })).error).toBeTruthy();
    expect((await call({ session: { isBillion: true }, tellOwner: async () => ({ ok: true, telegram: true }) })).result.content[0].text).toBe('Shown in the owner\'s Billion tab and sent on Telegram.');
  });
});

describe('the Waiting on you list', () => {
  it('persists in the config dir and dismisses one item', async () => {
    await notifyOwner('first', { env: {}, now: now(), queue: false });
    await notifyOwner('second', { env: {}, now: now(), queue: false });
    const onDisk = JSON.parse(readFileSync(join(CONFIG_DIR, 'waiting.json'), 'utf8'));
    expect(onDisk.map(i => i.text)).toEqual(['first', 'second']);
    const broadcast = vi.fn();
    expect(dismissWaiting(onDisk[0].id, broadcast)).toBe(true);
    expect(waitingItems().map(i => i.status)).toEqual(['dismissed', 'open']);
    expect(broadcast).toHaveBeenCalledWith({ type: 'waiting-list', items: [expect.objectContaining({ text: 'second' })] });
    expect(dismissWaiting(onDisk[0].id)).toBe(false);
    expect(dismissWaiting('no-such-id')).toBe(false);
  });
});

describe('replies from Telegram', () => {
  const update = (id, chat, text) => ({ update_id: id, message: { chat: { id: chat }, text } });

  it('types the owner\'s message into Billion\'s terminal, marked as theirs', async () => {
    const b = billion();
    sessions.set(b.id, b);
    expect(await handleUpdate(update(1, 42, 'yes, buy it'), { env: ENV })).toBe('delivered');
    expect(b.pty.write.mock.calls.map(c => c[0]).join('')).toContain('[Owner via Telegram] yes, buy it');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores every other chat without a reply', async () => {
    const b = billion();
    sessions.set(b.id, b);
    expect(await handleUpdate(update(1, 43, 'rm -rf everything'), { env: ENV })).toBe('ignored');
    expect(await handleUpdate(update(2, -42, 'group'), { env: ENV })).toBe('ignored');
    expect(await handleUpdate({ update_id: 3 }, { env: ENV })).toBe('ignored');
    expect(b.pty.write).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says "Billion is not running" and queues nothing when it is not', async () => {
    expect(await handleUpdate(update(1, 42, 'hello?'), { env: ENV })).toBe('not-running');
    expect(calls()[0].body).toEqual({ chat_id: '42', text: 'Billion is not running' });
  });

  it('without a chat id, shows the first chat\'s id and uses nothing from it', async () => {
    const b = billion();
    sessions.set(b.id, b);
    const broadcast = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { TELEGRAM_BOT_TOKEN: TOKEN };
    expect(await handleUpdate(update(1, 777, 'hi bot'), { env, broadcast })).toBe('discovery');
    expect(log.mock.calls.join('\n')).toContain('TELEGRAM_CHAT_ID=777');
    expect(log.mock.calls.join('\n')).not.toContain(TOKEN);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'telegram-state' }));
    // A second chat is shown too: a stranger messaging first cannot hide the owner's id.
    await handleUpdate(update(2, 888, 'me'), { env, broadcast });
    expect(log.mock.calls.join('\n')).toContain('TELEGRAM_CHAT_ID=888');
    expect(b.pty.write).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('long-polls from the offset after the last update it saw', async () => {
    fetchMock.mockResolvedValueOnce(reply([update(5, 43, 'a'), update(6, 43, 'b')]));
    expect(await pollOnce(0, { env: ENV })).toBe(7);
    const [first] = calls();
    expect(first.url).toMatch(/\/getUpdates$/);
    expect(first.body).toMatchObject({ timeout: 30 });
    expect(first.body.offset).toBeUndefined();
    fetchMock.mockResolvedValueOnce(reply([]));
    expect(await pollOnce(7, { env: ENV })).toBe(7);
    expect(calls()[1].body.offset).toBe(7);
  });

  it('redacts the token from a failed poll', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: new Error(`bad url bot${TOKEN}`) }));
    await expect(pollOnce(0, { env: ENV })).rejects.toThrow('bad url bot<token>');
  });

  it('stops cleanly: an abort ends the loop', async () => {
    let seen;
    fetchMock.mockImplementation((url, init) => new Promise((resolve, reject) => {
      seen = init.signal;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(startTelegram({ env: ENV })).toBe(true);
    await vi.waitFor(() => expect(seen).toBeDefined());
    stopTelegram();
    expect(seen.aborted).toBe(true);
    await new Promise(r => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe('the poll loop logs going offline and coming back, not every retry', () => {
  // A poll that waits until stopped, like a quiet long poll.
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const netDown = () => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error(`connect ENETUNREACH bot${TOKEN}`), { code: 'ENETUNREACH' }) });
  let lines;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hang);
    lines = [];
    const log = (...args) => { if (String(args[0]).startsWith('Telegram:')) lines.push(args.join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(log);
    vi.spyOn(console, 'error').mockImplementation(log);
  });
  afterEach(() => {
    stopTelegram();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a transient timeout then success logs nothing', async () => {
    fetchMock
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      .mockResolvedValueOnce(reply([]));
    startTelegram({ env: ENV });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(lines).toEqual([]);
  });

  it('a sustained outage logs one offline line and one back-online line, without the token', async () => {
    for (let i = 0; i < 5; i++) fetchMock.mockRejectedValueOnce(netDown());
    fetchMock.mockResolvedValueOnce(reply([]));
    startTelegram({ env: ENV });
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(lines).toEqual(['Telegram: offline (no network), retrying quietly', 'Telegram: back online after 31s']);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('a 401 logs right away with a hint', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) });
    startTelegram({ env: ENV });
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toEqual(['Telegram: getUpdates failed (Unauthorized): the bot token is wrong or revoked; retrying quietly']);
  });

  it('a 401 during an outage still logs its hint, once', async () => {
    const unauthorized = { ok: false, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) };
    for (let i = 0; i < 3; i++) fetchMock.mockRejectedValueOnce(netDown());
    fetchMock.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(unauthorized);
    startTelegram({ env: ENV });
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000);
    expect(lines).toEqual([
      'Telegram: offline (no network), retrying quietly',
      'Telegram: getUpdates failed (Unauthorized): the bot token is wrong or revoked; retrying quietly',
    ]);
  });
});

describe('long text to Telegram is split, never cut', () => {
  it('splitForTelegram joins back to the text, each piece within the limit, cutting at newlines first', () => {
    expect(splitForTelegram('short')).toEqual(['short']);
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} of a long listing`).join('\n');
    const parts = splitForTelegram(text, 4096);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
    expect(parts.every(p => p.length <= 4096)).toBe(true);
    expect(parts.slice(0, -1).every(p => p.endsWith('\n'))).toBe(true);
    const solid = '😀'.repeat(5000);
    expect(splitForTelegram(solid, 4096).join('')).toBe(solid);
    expect(splitForTelegram(solid, 4096).map(p => Array.from(p).length)).toEqual([4096, 904]);
  });

  it('sendTelegram sends consecutive messages, the buttons on the last', async () => {
    fetchMock.mockImplementation(async () => reply({ message_id: 5 }));
    const text = 'word '.repeat(2000);
    const markup = { inline_keyboard: [[{ text: 'yes', callback_data: 'a' }]] };
    expect((await sendTelegram(text, { env: ENV, extra: { reply_markup: markup } })).ok).toBe(true);
    const sent = calls().map(c => c.body);
    expect(sent.length).toBe(3);
    expect(sent.map(b => b.text).join('')).toBe(text);
    expect(sent.every(b => b.text.length <= 4096)).toBe(true);
    expect(sent.map(b => 'reply_markup' in b)).toEqual([false, false, true]);
  });

  it('a long answer edits the question to what fits and sends the rest as a follow-up message', async () => {
    const b = billion();
    sessions.set(b.id, b);
    fetchMock.mockImplementation(async () => reply({ message_id: 900 }));
    await notifyOwner('Which listing?', { env: ENV, now: now(), choices: ['a', 'b'], telegram: true });
    const long = 'answer text '.repeat(600);
    const { answerWaiting } = await import('../server/owner.js');
    fetchMock.mockClear();
    expect((await answerWaiting(waitingItems()[0].id, long, 'app', { env: ENV })).ok).toBe(true);
    const sent = calls();
    expect(sent[0].url).toMatch(/editMessageText$/);
    expect(sent[0].body.text.length).toBeLessThanOrEqual(4096);
    const joined = [sent[0].body.text, ...sent.slice(1).map(c => c.body.text)].join('');
    expect(joined).toBe(`Q1: Which listing?\n\nAnswered in app: ${long.trim()}`);
    dropMessages(b.id);
  });
});
