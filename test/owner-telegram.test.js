// Billion reaching the owner (server/owner.js): notify_owner, the "Waiting on
// you" list, and Telegram both ways. fetch is mocked throughout: no test here
// talks to Telegram.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  notifyOwner, sendTelegram, handleUpdate, pollOnce, startTelegram, stopTelegram,
  waitingItems, dismissWaiting, redact, NOTIFY_LIMIT, NOTIFY_WINDOW_MS,
} from '../server/owner.js';
import { handleMcpMessage } from '../server/mcp.js';
import { dropMessages } from '../server/messages.js';
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
  for (const item of waitingItems()) dismissWaiting(item.id);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessions.delete('owner-billion');
  dropMessages('owner-billion');
  stopTelegram();
});

describe('notify_owner', () => {
  it('sends "Billion: <text>" to the owner\'s chat and pins it', async () => {
    const broadcast = vi.fn();
    expect(await notifyOwner('Spend $20 on a domain? I recommend yes.', { env: ENV, now: now(), broadcast })).toEqual({ ok: true });
    const [c] = calls();
    expect(c.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(c.body).toEqual({ chat_id: '42', text: 'Billion: Spend $20 on a domain? I recommend yes.' });
    expect(waitingItems().map(i => i.text)).toEqual(['Spend $20 on a domain? I recommend yes.']);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'waiting-list' }));
  });

  it('is off without Telegram settings: pins it, says so, and never calls fetch', async () => {
    const result = await notifyOwner('Which name?', { env: {}, now: now() });
    expect(result.error).toMatch(/Telegram is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitingItems().map(i => i.text)).toEqual(['Which name?']);
    expect(startTelegram({ env: {} })).toBe(false);
  });

  it('turns a failed send into an error Billion reads, with the token redacted', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
    const result = await notifyOwner('hi', { env: ENV, now: now() });
    expect(result.error).toMatch(/Telegram send failed/);
    expect(result.error).not.toContain(TOKEN);
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) });
    expect((await sendTelegram('x', { env: ENV })).error).toBe('Bad Request: chat not found');
    expect(redact(`a ${TOKEN} b ${encodeURIComponent(TOKEN)}`, ENV)).toBe('a <token> b <token>');
  });

  it('allows a burst, then refuses until the minute has passed', async () => {
    const t = now();
    for (let i = 0; i < NOTIFY_LIMIT; i++) expect(await notifyOwner(`q${i}`, { env: ENV, now: t + i })).toEqual({ ok: true });
    const refused = await notifyOwner('one more', { env: ENV, now: t + 10 });
    expect(refused.error).toMatch(/last minute/);
    expect(fetchMock).toHaveBeenCalledTimes(NOTIFY_LIMIT);
    expect(waitingItems()).toHaveLength(NOTIFY_LIMIT);
    expect(await notifyOwner('later', { env: ENV, now: t + NOTIFY_WINDOW_MS + 1 })).toEqual({ ok: true });
  });

  it('refuses empty text', async () => {
    expect((await notifyOwner('  ', { env: ENV, now: now() })).error).toMatch(/empty/);
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

describe('the Waiting on you list', () => {
  it('persists in the config dir and dismisses one item', async () => {
    await notifyOwner('first', { env: {}, now: now() });
    await notifyOwner('second', { env: {}, now: now() });
    const onDisk = JSON.parse(readFileSync(join(CONFIG_DIR, 'waiting.json'), 'utf8'));
    expect(onDisk.map(i => i.text)).toEqual(['first', 'second']);
    const broadcast = vi.fn();
    expect(dismissWaiting(onDisk[0].id, broadcast)).toBe(true);
    expect(waitingItems().map(i => i.text)).toEqual(['second']);
    expect(broadcast).toHaveBeenCalledWith({ type: 'waiting-list', items: waitingItems() });
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
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification' }));
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
