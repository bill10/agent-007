// Cancel on the owner's queued message (server/owner.js cancelOwnerMessage,
// server/messages.js cancelQueuedText): taken out of Billion's queue so it is
// never typed, marked cancelled in chat.json (so a reload or restart shows it
// cancelled and redelivers nothing), idempotent, and the delivery race won by
// whichever runs first. Typed, voice, attachments and Telegram alike.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { ownerSays, chatMessages, cancelOwnerMessage, handleUpdate, pendingOwnerMessages, requeueOwnerMessages } from '../server/owner.js';
import { dropMessages, flushMessages, pendingMessages, takeMessages, restoreMessages } from '../server/messages.js';
import { sessions, CONFIG_DIR } from '../server/state.js';

const ENV = { TELEGRAM_BOT_TOKEN: '123456:SECRET-token', TELEGRAM_CHAT_ID: '42' };
let b;
const typed = () => b.pty.write.mock.calls.map(c => c[0]).join('').replace(/\x1b\[20[01]~/g, '');
const saved = () => JSON.parse(readFileSync(join(CONFIG_DIR, 'chat.json'), 'utf8'));
const busy = () => { b.state = 'WORKING'; };
const rest = () => { b.state = 'WAITING'; b.stateChangedAt = Date.now() + 1; b.messageDeliveredAt = 0; };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) })));
  rmSync(join(CONFIG_DIR, 'waiting.json'), { force: true });
  rmSync(join(CONFIG_DIR, 'chat.json'), { force: true });
  rmSync(join(CONFIG_DIR, 'chat-files'), { recursive: true, force: true });
  b = {
    id: 'cancel-billion', name: 'Billion', isBillion: true, command: 'claude', state: 'WAITING', exited: false,
    ownerId: null, stateChangedAt: Date.now() - 5000, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
  };
  sessions.set(b.id, b);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessions.delete(b.id);
  dropMessages(b.id);
});

describe('cancelling a queued message', () => {
  it('marks a message queued while Billion is busy, and unmarks it the moment it is typed', async () => {
    busy();
    const broadcast = vi.fn();
    const { id } = await ownerSays('first', { broadcast });
    expect(chatMessages()[0]).toMatchObject({ id, queued: true, awaitsReply: true });
    rest();
    expect(flushMessages(b)).toBe(true);
    expect(chatMessages()[0].queued).toBeUndefined();
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'chat-message', message: expect.not.objectContaining({ queued: true }) });
  });

  it('a message typed at once is never marked queued', async () => {
    await ownerSays('now');
    expect(chatMessages()[0].queued).toBeUndefined();
    expect(cancelOwnerMessage(chatMessages()[0].id)).toMatchObject({ delivered: true, error: 'Already sent to Billion.' });
  });

  it('takes it out of the queue so Billion never gets it, and leaves the rest in order', async () => {
    busy();
    const broadcast = vi.fn();
    const one = await ownerSays('one');
    const two = await ownerSays('two');
    const three = await ownerSays('three');
    expect(pendingMessages(b.id)).toBe(3);
    expect(cancelOwnerMessage(two.id, { broadcast })).toMatchObject({ ok: true });
    expect(pendingMessages(b.id)).toBe(2);
    const m = chatMessages().find(x => x.id === two.id);
    expect(m).toMatchObject({ cancelled: true, awaitsReply: false });
    expect(m.queued).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith({ type: 'chat-message', message: expect.objectContaining({ id: two.id, cancelled: true }) });
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'billion-status' }));
    expect(pendingOwnerMessages().map(x => x.id)).toEqual([one.id, three.id]);
    for (let i = 0; i < 3; i++) { rest(); flushMessages(b); await vi.waitFor(() => expect(b.messageTyping).toBeFalsy()); }
    expect(typed()).toContain('one');
    expect(typed()).toContain('three');
    expect(typed()).not.toContain('two');
  });

  it('is idempotent: a second Cancel is ok and changes nothing', async () => {
    busy();
    const { id } = await ownerSays('again');
    expect(cancelOwnerMessage(id)).toMatchObject({ ok: true });
    const at = chatMessages()[0].cancelledAt;
    expect(cancelOwnerMessage(id)).toMatchObject({ ok: true });
    expect(chatMessages()[0].cancelledAt).toBe(at);
  });

  it('loses the race to delivery: once typing starts the message stands, as "Already sent"', async () => {
    busy();
    const { id } = await ownerSays('racing');
    rest();
    flushMessages(b);            // typing starts first...
    expect(cancelOwnerMessage(id)).toEqual({ delivered: true, error: 'Already sent to Billion.' });   // ...so delivery wins
    expect(chatMessages()[0]).toMatchObject({ awaitsReply: true });
    expect(chatMessages()[0].cancelled).toBeUndefined();
  });

  it('wins the race when it comes first: the flush then types nothing', async () => {
    busy();
    const { id } = await ownerSays('racing');
    rest();
    expect(cancelOwnerMessage(id)).toMatchObject({ ok: true });
    expect(flushMessages(b)).toBe(false);
    expect(b.pty.write).not.toHaveBeenCalled();
  });

  it('keeps the cancel through a reload or restart: chat.json says cancelled, and nothing is redelivered', async () => {
    busy();
    const { id } = await ownerSays('persist me');
    cancelOwnerMessage(id);
    expect(saved().find(m => m.id === id)).toMatchObject({ cancelled: true, awaitsReply: false });
    dropMessages(b.id);          // a restart: the queue is gone, the thread is what is left
    rest();
    expect(flushMessages(b)).toBe(false);
    expect(chatMessages().find(m => m.id === id).cancelled).toBe(true);
    expect(pendingOwnerMessages()).toEqual([]);
  });

  it('cancels a message still marked queued whose queue a restart emptied: it never reached Billion', async () => {
    busy();
    const { id } = await ownerSays('lost in a restart');
    dropMessages(b.id);
    expect(cancelOwnerMessage(id)).toMatchObject({ ok: true });
    expect(chatMessages()[0].cancelled).toBe(true);
  });

  it('a message cancelled while Billion moves to the other CLI is not carried to the new session', async () => {
    busy();
    const { id } = await ownerSays('mid-switch');
    const carried = takeMessages(b.id);
    expect(cancelOwnerMessage(id)).toMatchObject({ ok: true });
    restoreMessages(b.id, carried);
    expect(pendingMessages(b.id)).toBe(0);
  });

  it('works for a voice turn and a message with attachments', async () => {
    busy();
    const voice = await ownerSays('spoken words', { voice: true, utterance: 'u-1' });
    const files = await ownerSays('see this', { files: [{ name: 'a.txt', data: Buffer.from('hi').toString('base64') }] });
    expect(cancelOwnerMessage(voice.id)).toMatchObject({ ok: true });
    expect(cancelOwnerMessage(files.id)).toMatchObject({ ok: true });
    expect(pendingMessages(b.id)).toBe(0);
  });

  it('works for a Telegram message waiting in the same queue', async () => {
    busy();
    expect(await handleUpdate({ message: { chat: { id: 42, type: 'private' }, text: 'from my phone' } }, { env: ENV })).toBe('delivered');
    const m = chatMessages().at(-1);
    expect(m).toMatchObject({ via: 'telegram', queued: true });
    expect(cancelOwnerMessage(m.id)).toMatchObject({ ok: true });
    expect(pendingMessages(b.id)).toBe(0);
  });

  it('refuses an id that is not the owner\'s message', () => {
    expect(cancelOwnerMessage('nope')).toEqual({ error: 'That message is gone.' });
  });
});

// A restart empties Billion's queue but not chat.json: a message still marked
// queued was never typed, and nothing would ever type it. The new session
// gets it again (server.js, when Billion starts).
describe('requeueing what a restart dropped', () => {
  it('types a message a restart dropped into the new session, and unmarks it', async () => {
    busy();
    const { id } = await ownerSays('check out this repo');
    dropMessages(b.id);          // the old server's queue, gone
    expect(flushMessages(b)).toBe(false);
    const broadcast = vi.fn();
    expect(requeueOwnerMessages(b, { broadcast })).toBe(1);
    expect(pendingMessages(b.id)).toBe(1);
    rest();
    expect(flushMessages(b)).toBe(true);
    await vi.waitFor(() => expect(b.messageTyping).toBeFalsy());
    expect(typed()).toContain('[Owner via app] check out this repo');
    expect(chatMessages().find(m => m.id === id).queued).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith({ type: 'chat-message', message: expect.objectContaining({ id }) });
  });

  it('lets a held inbox take it, as it takes any owner message', async () => {
    busy();
    await ownerSays('while held');
    dropMessages(b.id);
    b.messagesHeld = true;
    requeueOwnerMessages(b);
    rest();
    expect(flushMessages(b)).toBe(true);
    await vi.waitFor(() => expect(b.messageTyping).toBeFalsy());
    expect(typed()).toContain('while held');
  });

  it('keeps the order, rebuilds voice, Telegram and attachment lines, and leaves cancelled and delivered ones out', async () => {
    busy();
    const first = await ownerSays('first');
    const gone = await ownerSays('cancelled');
    const voice = await ownerSays('spoken', { voice: true, utterance: 'u-r' });
    const files = await ownerSays('see this', { files: [{ name: 'a.txt', data: Buffer.from('hi').toString('base64') }] });
    expect(await handleUpdate({ message: { chat: { id: 42, type: 'private' }, text: 'from my phone' } }, { env: ENV })).toBe('delivered');
    cancelOwnerMessage(gone.id);
    dropMessages(b.id);
    expect(requeueOwnerMessages(b)).toBe(4);
    for (let i = 0; i < 4; i++) { rest(); flushMessages(b); await vi.waitFor(() => expect(b.messageTyping).toBeFalsy()); }
    const out = typed();
    expect(out).not.toContain('cancelled');
    expect(out).toContain(`[Owner via app, voice #${voice.id.slice(0, 8)}] spoken`);
    expect(out).toMatch(new RegExp(`see this \\(attached: .*${files.id}.a\\.txt\\)`));
    expect(out).toContain('from my phone');
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('spoken'));
    expect(out.indexOf('spoken')).toBeLessThan(out.indexOf('see this'));
    expect(out.indexOf('see this')).toBeLessThan(out.indexOf('from my phone'));
    expect(chatMessages().filter(m => m.queued)).toEqual([]);
    expect(chatMessages().find(m => m.id === first.id).queued).toBeUndefined();
    expect(requeueOwnerMessages(b)).toBe(0);
  });

  it('does not queue twice what a queue still holds, and Cancel reaches a requeued one', async () => {
    busy();
    const { id } = await ownerSays('still waiting');
    expect(requeueOwnerMessages(b)).toBe(0);
    expect(pendingMessages(b.id)).toBe(1);
    dropMessages(b.id);
    requeueOwnerMessages(b);
    expect(cancelOwnerMessage(id)).toMatchObject({ ok: true });
    expect(pendingMessages(b.id)).toBe(0);
  });
});
