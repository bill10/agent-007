// The Billion chat (server/owner.js): what the owner types in the Billion tab
// reaching Billion as [Owner via app], a typed answer to a question, Billion's
// tell_owner and notify_owner as bubbles that follow their question's state,
// Telegram messages in the same thread, the cap, and the token redacted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  ownerSays, chatMessages, chatPayload, notifyOwner, tellOwner, handleUpdate, dismissWaiting, waitingItems,
  APP_PREFIX, OWNER_PREFIX, CHAT_CAP, NOTIFY_WINDOW_MS,
} from '../server/owner.js';
import { dropMessages } from '../server/messages.js';
import { sessions, CONFIG_DIR } from '../server/state.js';

const TOKEN = '123456:SECRET-token';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' };
let clock = 3e12;
const now = () => (clock += 10 * NOTIFY_WINDOW_MS);
let b;
// Without the bracketed-paste markers each chunk is wrapped in.
const typed = () => b.pty.write.mock.calls.map(c => c[0]).join("").replace(/\x1b\[20[01]~/g, "");

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) })));
  rmSync(join(CONFIG_DIR, 'waiting.json'), { force: true });
  rmSync(join(CONFIG_DIR, 'chat.json'), { force: true });
  b = {
    id: 'chat-billion', name: 'Billion', isBillion: true, command: 'claude', state: 'WAITING', exited: false,
    ownerId: null, stateChangedAt: Date.now() - 5000, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
  };
  sessions.set(b.id, b);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessions.delete(b.id);
  dropMessages(b.id);
});

describe('the owner typing in the Billion tab', () => {
  it('reaches Billion as [Owner via app] and shows as the owner\'s bubble', async () => {
    const broadcast = vi.fn();
    expect(await ownerSays('  How is the release going? ', { broadcast })).toEqual({ ok: true });
    expect(typed()).toContain(`${APP_PREFIX} How is the release going?`);
    const [m] = chatMessages();
    expect(m).toMatchObject({ from: 'owner', via: 'app', text: 'How is the release going?' });
    expect(broadcast).toHaveBeenCalledWith({ type: 'chat-message', message: m });
  });

  it('refuses while Billion is not running, and keeps nothing, so the text stays in the box', async () => {
    b.exited = true;
    expect(await ownerSays('hello')).toEqual({ error: 'Billion is not running; start it, then send again.' });
    expect(chatMessages()).toEqual([]);
  });

  it('refuses empty and oversized text', async () => {
    expect((await ownerSays('  ')).error).toMatch(/empty/);
    expect((await ownerSays('x'.repeat(5000))).error).toMatch(/under 4096/);
    expect(b.pty.write).not.toHaveBeenCalled();
  });

  it('answers the question it names, as a typed answer: the question collapses and the words show as the owner\'s', async () => {
    const broadcast = vi.fn();
    await notifyOwner('Merge #12?', { env: {}, now: now(), choices: ['yes', 'no'], recommended: 'yes', broadcast });
    const [q] = waitingItems();
    expect(await ownerSays('yes, after CI', { answers: q.id, broadcast })).toMatchObject({ ok: true });
    expect(typed()).toContain(`${APP_PREFIX} Q1: yes, after CI (re: "Merge #12?")`);
    const [question, answer] = chatMessages();
    expect(question.q).toMatchObject({ n: 1, status: 'answered', answer: 'yes, after CI', answeredVia: 'app', choices: ['yes', 'no'], recommended: 'yes' });
    expect(answer).toMatchObject({ from: 'owner', via: 'app', text: 'yes, after CI', re: 1 });
  });
});

describe('Billion\'s side of the thread', () => {
  it('a question is a bubble carrying its choices, and follows it to dismissed', async () => {
    const broadcast = vi.fn();
    await notifyOwner('Buy the domain?', { env: {}, now: now(), choices: ['yes', 'no'], urgency: 'blocking', broadcast });
    const [m] = chatMessages();
    expect(m).toMatchObject({ from: 'billion', text: 'Buy the domain?', q: { n: 1, urgency: 'blocking', status: 'open', choices: ['yes', 'no'] } });
    dismissWaiting(m.q.id, broadcast);
    expect(chatMessages()[0].q.status).toBe('dismissed');
    expect(broadcast).toHaveBeenCalledWith({ type: 'chat-message', message: expect.objectContaining({ q: expect.objectContaining({ status: 'dismissed' }) }) });
  });

  it('redacts the bot token from everything the thread keeps', async () => {
    await tellOwner(`the token is ${TOKEN}`, { env: ENV, now: now() });
    expect(chatMessages().at(-1).text).toBe('the token is <token>');
    expect(JSON.stringify(chatPayload())).not.toContain(TOKEN);
  });

  it('keeps the newest 500 and lets older ones fall off', async () => {
    const old = Array.from({ length: CHAT_CAP }, (_, i) => ({ id: `m${i}`, at: new Date(i).toISOString(), from: 'billion', text: `m${i}` }));
    writeFileSync(join(CONFIG_DIR, 'chat.json'), JSON.stringify(old));
    await tellOwner('newest', { env: {}, now: now() });
    const kept = chatMessages();
    expect(kept).toHaveLength(CHAT_CAP);
    expect([kept[0].text, kept.at(-1).text]).toEqual(['m1', 'newest']);
  });

  it('opens a thread that does not exist yet on the questions already asked', async () => {
    await notifyOwner('Asked before the chat', { env: {}, now: now() });
    rmSync(join(CONFIG_DIR, 'chat.json'));
    expect(chatMessages()).toEqual([expect.objectContaining({ from: 'billion', text: 'Asked before the chat', q: expect.objectContaining({ n: 1, status: 'open' }) })]);
  });

  it('reads a missing or broken file as an empty thread', () => {
    expect(chatMessages()).toEqual([]);
    writeFileSync(join(CONFIG_DIR, 'chat.json'), '{nope');
    expect(chatMessages()).toEqual([]);
  });
});

describe('Telegram in the same thread', () => {
  it('the owner\'s Telegram message shows as theirs, via Telegram', async () => {
    const broadcast = vi.fn();
    expect(await handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: 'ship it' } }, { env: ENV, broadcast })).toBe('delivered');
    expect(typed()).toContain(`${OWNER_PREFIX} ship it`);
    expect(chatMessages()).toEqual([expect.objectContaining({ from: 'owner', via: 'telegram', text: 'ship it' })]);
  });

  it('a Telegram reply to a question shows as a typed answer; a button tap only collapses it', async () => {
    await notifyOwner('Rename the repo?', { env: ENV, now: now(), choices: ['yes', 'no'] });
    const [q] = waitingItems();
    expect(await handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: 'not yet', reply_to_message: { message_id: q.tgMessageId } } }, { env: ENV })).toBe('answered');
    expect(chatMessages().map(m => [m.from, m.text])).toEqual([['billion', 'Rename the repo?'], ['owner', 'not yet']]);

    await notifyOwner('Tag v2?', { env: ENV, now: now(), choices: ['yes', 'no'] });
    const q2 = waitingItems().at(-1);
    await handleUpdate({ update_id: 3, callback_query: { id: 'c', data: `${q2.id}:0`, message: { chat: { id: 42 } } } }, { env: ENV });
    const thread = chatMessages();
    expect(thread).toHaveLength(3);
    expect(thread.at(-1).q).toMatchObject({ status: 'answered', answer: 'yes', answeredVia: 'telegram' });
  });
});
