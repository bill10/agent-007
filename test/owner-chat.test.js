// The Billion chat (server/owner.js): what the owner types in the Billion tab
// reaching Billion as [Owner via app], a typed answer to a question, Billion's
// tell_owner and notify_owner as bubbles that follow their question's state,
// Telegram messages in the same thread, the cap, and the token redacted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  ownerSays, chatMessages, chatFilePath, chatPayload, notifyOwner, tellOwner, handleUpdate, dismissWaiting, waitingItems,
  APP_PREFIX, OWNER_PREFIX, CHAT_CAP, NOTIFY_WINDOW_MS, MAX_OWNER_CHARS,
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
  rmSync(join(CONFIG_DIR, 'chat-files'), { recursive: true, force: true });
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
    expect(await ownerSays('  How is the release going? ', { broadcast })).toMatchObject({ ok: true });
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

  it('refuses empty text and text past the technical ceiling', async () => {
    expect((await ownerSays('  ')).error).toMatch(/empty/);
    expect((await ownerSays('x'.repeat(MAX_OWNER_CHARS + 1))).error).toMatch(/send it in parts/);
    expect(b.pty.write).not.toHaveBeenCalled();
  });

  it('delivers a long pasted message whole, newlines kept, and keeps it whole in the thread', async () => {
    const listing = Array.from({ length: 60 }, (_, i) => `Item ${i}: a product with a long description`.padEnd(150, '.')).join('\n');
    expect(listing.length).toBeGreaterThan(4096);
    expect(await ownerSays(listing)).toMatchObject({ ok: true });
    // Typed in small bracketed pastes, one after another, then one Enter: one turn.
    await vi.waitFor(() => expect(typed()).toBe(`${APP_PREFIX} ${listing}\r`), { timeout: 20000 });
    expect(chatMessages()[0].text).toBe(listing);
    expect(readFileSync(join(CONFIG_DIR, 'chat.json'), 'utf8')).toContain(JSON.stringify(listing));
  });

  it('delivers a long answer whole with its line breaks', async () => {
    await notifyOwner('Which listing?', { env: {}, now: now(), queue: false });
    const [q] = waitingItems();
    const listing = Array.from({ length: 60 }, (_, i) => `Line ${i} of the pasted listing`).join('\n');
    expect(await ownerSays(listing, { answers: q.id })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(typed()).toBe(`${APP_PREFIX} Q1: ${listing} (re: "Which listing?")\r`), { timeout: 20000 });
    expect(chatMessages().at(-1).text).toBe(listing);
  });

  it('answers the question it names, as a typed answer: the question collapses and the words show as the owner\'s', async () => {
    const broadcast = vi.fn();
    await notifyOwner('Merge #12?', { env: {}, now: now(), choices: ['yes', 'no'], recommended: 'yes', broadcast, queue: false });
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
    await notifyOwner('Asked before the chat', { env: {}, now: now(), queue: false });
    rmSync(join(CONFIG_DIR, 'chat.json'));
    expect(chatMessages()).toEqual([expect.objectContaining({ from: 'billion', text: 'Asked before the chat', q: expect.objectContaining({ n: 1, status: 'open' }) })]);
  });

  it('keeps an open question past the cap: its bubble is where it is answered', async () => {
    const openQ = { id: 'oq', at: new Date(0).toISOString(), from: 'billion', text: 'still open?', q: { id: 'x', n: 1, status: 'open' } };
    const old = Array.from({ length: CHAT_CAP - 1 }, (_, i) => ({ id: `m${i}`, at: new Date(i + 1).toISOString(), from: 'billion', text: `m${i}` }));
    writeFileSync(join(CONFIG_DIR, 'chat.json'), JSON.stringify([openQ, ...old]));
    await tellOwner('newest', { env: {}, now: now() });
    const kept = chatMessages();
    expect(kept).toHaveLength(CHAT_CAP);
    expect(kept.map(m => m.id).slice(0, 2)).toEqual(['oq', 'm1']);
  });

  it('reads a missing file as an empty thread, and moves a broken one aside rather than overwrite it', async () => {
    expect(chatMessages()).toEqual([]);
    writeFileSync(join(CONFIG_DIR, 'chat.json'), '{nope');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(chatMessages()).toEqual([]);
    expect(readFileSync(join(CONFIG_DIR, 'chat.json.bad'), 'utf8')).toBe('{nope');
    error.mockRestore();
  });

  it('redacts the token from a question too, in the Waiting list the strip shows', async () => {
    await notifyOwner(`use ${TOKEN}?`, { env: ENV, now: now(), queue: false });
    expect(waitingItems()[0].text).toBe('use <token>?');
    expect(chatMessages()[0].text).toBe('use <token>?');
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
    await notifyOwner('Rename the repo?', { env: ENV, now: now(), choices: ['yes', 'no'], telegram: true });
    const [q] = waitingItems();
    expect(await handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: 'not yet', reply_to_message: { message_id: q.tgMessageId } } }, { env: ENV })).toBe('answered');
    expect(chatMessages().map(m => [m.from, m.text])).toEqual([['billion', 'Rename the repo?'], ['owner', 'not yet']]);

    await notifyOwner('Tag v2?', { env: ENV, now: now(), choices: ['yes', 'no'], telegram: true });
    const q2 = waitingItems().at(-1);
    await handleUpdate({ update_id: 3, callback_query: { id: 'c', data: `${q2.id}:0`, message: { chat: { id: 42 } } } }, { env: ENV });
    const thread = chatMessages();
    expect(thread).toHaveLength(3);
    expect(thread.at(-1).q).toMatchObject({ status: 'answered', answer: 'yes', answeredVia: 'telegram' });
  });
});

// Files pasted, dropped or picked in the Billion tab (server/owner.js "The
// chat's attachments").
describe('attachments in the Billion tab', () => {
  const file = (name, text = 'hello', type = 'text/plain') => ({ name, type, data: Buffer.from(text).toString('base64') });
  const dir = () => join(CONFIG_DIR, 'chat-files');

  it('saves them owner-only under chat-files/<message id>, and one turn carries their absolute paths', async () => {
    expect(await ownerSays('look at this', { files: [file('shot.png', 'png', 'image/png'), file('notes.pdf')] })).toMatchObject({ ok: true });
    const [m] = chatMessages();
    expect(m.files).toEqual([{ name: 'shot.png', size: 3, type: 'image/png' }, { name: 'notes.pdf', size: 5, type: 'text/plain' }]);
    const a = join(dir(), m.id, 'shot.png');
    const b2 = join(dir(), m.id, 'notes.pdf');
    await vi.waitFor(() => expect(typed()).toBe(`${APP_PREFIX} look at this (attached: ${a}, ${b2})\r`));
    expect(readFileSync(a, 'utf8')).toBe('png');
    if (process.platform !== 'win32') {
      expect(statSync(a).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir(), m.id)).mode & 0o777).toBe(0o700);
    }
    // In chat.json, so a restart keeps the bubble's files.
    expect(JSON.parse(readFileSync(join(CONFIG_DIR, 'chat.json'), 'utf8'))[0].files).toEqual(m.files);
  });

  it('sends files with no text', async () => {
    expect(await ownerSays('', { files: [file('a.txt')] })).toMatchObject({ ok: true });
    const [m] = chatMessages();
    expect(m.text).toBe('');
    await vi.waitFor(() => expect(typed()).toBe(`${APP_PREFIX} (attached: ${join(dir(), m.id, 'a.txt')})\r`));
  });

  it('answers a question with them, the paths on the same turn', async () => {
    await notifyOwner('Which logo?', { env: {}, now: now(), queue: false });
    const [q] = waitingItems();
    expect(await ownerSays('this one', { answers: q.id, files: [file('logo.svg', '<svg/>', 'image/svg+xml')] })).toMatchObject({ ok: true });
    const answer = chatMessages().at(-1);
    expect(answer).toMatchObject({ re: 1, text: 'this one', files: [{ name: 'logo.svg', type: 'image/svg+xml' }] });
    await vi.waitFor(() => expect(typed()).toBe(`${APP_PREFIX} Q1: this one (re: "Which logo?") (attached: ${join(dir(), answer.id, 'logo.svg')})\r`));
  });

  it('sanitises names and refuses what the job form refuses: too big, too many, unnamed, clashing', async () => {
    expect(await ownerSays('x', { files: [file('../../etc/passwd')] })).toMatchObject({ ok: true });
    expect(chatMessages()[0].files[0].name).toBe('.._.._etc_passwd');
    const big = { name: 'big.bin', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') };
    expect((await ownerSays('x', { files: [big] })).error).toMatch(/too large/);
    expect((await ownerSays('x', { files: Array.from({ length: 21 }, (_, i) => file(`f${i}.txt`)) })).error).toMatch(/At most 20/);
    expect((await ownerSays('x', { files: [file('...')] })).error).toMatch(/Unusable/);
    expect((await ownerSays('x', { files: [file('A.png'), file('a.png')] })).error).toMatch(/Two files/);
    expect((await ownerSays('x', { files: 'nope' })).error).toMatch(/not a list/);
    expect(chatMessages()).toHaveLength(1);
  });

  it('keeps nothing on disk when Billion cannot take the turn', async () => {
    b.exited = true;
    expect((await ownerSays('x', { files: [file('a.txt')] })).error).toMatch(/not running/);
    expect(existsSync(dir()) ? readdirSync(dir()) : []).toEqual([]);
  });

  it('finds a file only by a message that has it, never outside chat-files', async () => {
    await ownerSays('x', { files: [file('a.txt')] });
    const [m] = chatMessages();
    expect(chatFilePath(m.id, 'a.txt')).toBe(join(dir(), m.id, 'a.txt'));
    expect(chatFilePath(m.id, 'b.txt')).toBeNull();
    expect(chatFilePath('nope', 'a.txt')).toBeNull();
    // A hand-edited chat.json cannot point the route elsewhere.
    writeFileSync(join(CONFIG_DIR, 'chat.json'), JSON.stringify([{ id: '..', from: 'owner', text: '', files: [{ name: 'chat.json' }] }]));
    expect(chatFilePath('..', 'chat.json')).toBeNull();
  });

  it('deletes a message\'s files when the cap lets the message go', async () => {
    await ownerSays('x', { files: [file('a.txt')] });
    const [m] = chatMessages();
    const later = Array.from({ length: CHAT_CAP }, (_, i) => ({ id: `m${i}`, at: new Date(i).toISOString(), from: 'billion', text: `m${i}` }));
    writeFileSync(join(CONFIG_DIR, 'chat.json'), JSON.stringify([m, ...later]));
    await tellOwner('one more', { env: {}, now: now() });
    expect(chatMessages().some(x => x.id === m.id)).toBe(false);
    expect(existsSync(join(dir(), m.id))).toBe(false);
  });
});
