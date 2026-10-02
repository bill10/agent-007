// Slash commands from the owner (server/owner.js, runCommand): "/model opus"
// in the Billion tab or the owner's private Telegram chat is typed bare into
// Billion's terminal, at its prompt only, with no reply awaited; "//" sends a
// literal "/" message; the settled screen comes back into the thread.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { ownerSays, chatMessages, handleUpdate, pendingOwnerMessages, slashCommand, APP_PREFIX } from '../server/owner.js';
import { dropMessages, flushMessages, sendText, COMMAND_SETTLE_MS } from '../server/messages.js';
import { sessions, CONFIG_DIR } from '../server/state.js';

const ENV = { TELEGRAM_BOT_TOKEN: '123456:SECRET-token', TELEGRAM_CHAT_ID: '42' };
let b;
const typed = () => b.pty.write.mock.calls.map(c => c[0]).join('').replace(/\x1b\[20[01]~/g, '');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) })));
  rmSync(join(CONFIG_DIR, 'chat.json'), { force: true });
  b = {
    id: 'slash-billion', name: 'Billion', isBillion: true, command: 'claude', state: 'WAITING', exited: false,
    ownerId: null, stateChangedAt: Date.now() - 5000, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
  };
  sessions.set(b.id, b);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessions.delete(b.id);
  dropMessages(b.id);
});

describe('routing what the owner types', () => {
  it('knows a command from a message', () => {
    expect(slashCommand('/model opus')).toBe('/model opus');
    for (const t of ['//model', 'hi /model', '/', '/ model', '/model\nopus', '/model\ropus', '/model\x1b[A']) expect(slashCommand(t)).toBeNull();
  });

  it('types a slash command bare, marks it a command, and awaits no reply', async () => {
    expect(await ownerSays('/model opus')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(typed()).toBe('/model opus\r');
    expect(chatMessages()).toEqual([expect.objectContaining({ from: 'owner', via: 'app', text: '/model opus', command: true })]);
    expect(chatMessages()[0].awaitsReply).toBeUndefined();
    expect(pendingOwnerMessages()).toEqual([]);
  });

  it('sends "//text" as an ordinary message starting with "/"', async () => {
    await ownerSays('//etc/hosts is wrong');
    await vi.advanceTimersByTimeAsync(200);
    expect(typed()).toBe(`${APP_PREFIX} /etc/hosts is wrong\r`);
    expect(chatMessages()[0]).toMatchObject({ text: '/etc/hosts is wrong', awaitsReply: true });
  });

  it('leaves an ordinary message as it was', async () => {
    await ownerSays('model opus please');
    await vi.advanceTimersByTimeAsync(200);
    expect(typed()).toBe(`${APP_PREFIX} model opus please\r`);
  });
});

describe('running it', () => {
  it('waits for Billion to rest at its prompt', async () => {
    b.state = 'WORKING';
    await ownerSays('/model opus');
    await vi.advanceTimersByTimeAsync(200);
    expect(b.pty.write).not.toHaveBeenCalled();
    b.state = 'WAITING';
    b.stateChangedAt = Date.now();
    expect(flushMessages(b)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(typed()).toBe('/model opus\r');
  });

  it('shows the settled screen, closes a picker, and holds the next message until then', async () => {
    await ownerSays('/model');
    await vi.advanceTimersByTimeAsync(200);
    b.recentStrippedLines = ['────────', 'Select model', '❯ 1. Default (Opus)', '  2. Sonnet', '────────'];
    sendText(b, 'next', Date.now(), { owner: true });
    b.stateChangedAt = Date.now();
    expect(flushMessages(b)).toBe(false);
    await vi.advanceTimersByTimeAsync(COMMAND_SETTLE_MS);
    expect(chatMessages().at(-1)).toMatchObject({ from: 'billion', screen: true, text: 'Select model\n❯ 1. Default (Opus)\n2. Sonnet' });
    expect(b.pty.write).toHaveBeenLastCalledWith('\x1b');
    expect(pendingOwnerMessages()).toEqual([]);
    b.stateChangedAt = Date.now() + 1;
    expect(flushMessages(b, Date.now() + 2)).toBe(true);
  });

  it('leaves a command that started a turn alone', async () => {
    await ownerSays('/review');
    await vi.advanceTimersByTimeAsync(200);
    b.lastOutputAt = Date.now() + COMMAND_SETTLE_MS;
    await vi.advanceTimersByTimeAsync(COMMAND_SETTLE_MS);
    expect(b.pty.write).not.toHaveBeenCalledWith('\x1b');
    expect(chatMessages().at(-1)).toMatchObject({ screen: true, text: 'Running in Billion\'s terminal.' });
  });
});

describe('from Telegram', () => {
  it('runs a command from the owner\'s private chat and sends the screen back', async () => {
    expect(await handleUpdate({ update_id: 1, message: { chat: { id: 42, type: 'private' }, text: '/model opus' } }, { env: ENV })).toBe('command');
    await vi.advanceTimersByTimeAsync(200);
    expect(typed()).toBe('/model opus\r');
    b.recentStrippedLines = ['Set model to opus'];
    await vi.advanceTimersByTimeAsync(COMMAND_SETTLE_MS);
    expect(fetch.mock.calls.some(([, o]) => String(o?.body).includes('Set model to opus'))).toBe(true);
  });

  it('takes nothing as a command from a group: its members are not the owner', async () => {
    expect(await handleUpdate({ update_id: 2, message: { chat: { id: 42, type: 'group' }, from: { first_name: 'Mallory' }, text: '/model opus' } }, { env: ENV })).toBe('delivered');
    await vi.advanceTimersByTimeAsync(200);
    expect(typed()).toMatch(/^\[Owner via Telegram[^\]]*\] \/model opus\r$/);
  });
});
