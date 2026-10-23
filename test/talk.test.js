// Talk to Billion, the server side (server/talk.js, its routes in
// server/http.js): an utterance's audio transcribed by a stub whisper.cpp and
// sent to Billion once as [Owner via app, voice], a retry or revised
// transcript never a second message, Billion's own voice dropped as echo, and
// a stub `say` speaking only a tell_owner reply bound to a voice turn.
// spawn and the PATH lookup are mocked: nothing runs say, ffmpeg or whisper.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';

const tools = { available: new Set(), whisperOut: 'How is the launch going?', calls: [], said: [], delay: 0 };

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn((cmd, args) => {
    tools.calls.push([cmd, args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      if (cmd === 'say' && args[1] === '?') child.stdout.emit('data', '');
      else if (cmd === 'say') tools.said.push(readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
      if (cmd === 'ffmpeg') writeFileSync(args[args.length - 1], 'AUDIO');
      if (cmd.includes('whisper')) child.stdout.emit('data', `\n ${tools.whisperOut}\n`);
      child.emit('close', 0);
    }, cmd.includes('whisper') ? tools.delay : 0);
    return child;
  }),
}));
vi.mock('../server/command-path.js', async (importOriginal) => ({
  ...(await importOriginal()),
  commandExists: (file) => tools.available.has(file),
}));

const { ownerSays, tellOwner, notifyOwner, chatMessages, pendingOwnerMessages, addChat, NOTIFY_WINDOW_MS } = await import('../server/owner.js');
const { talkSetup, voiceUtterance, voiceSegment, voiceSays, voiceAudio, voiceAudioBuffer, looksLikeEcho, speechPieces, ACKS, _resetTalk, MAX_UTTERANCE_BYTES, UTTERANCE_LIMIT } = await import('../server/talk.js');
const { _resetEleven } = await import('../server/elevenlabs.js');
const { setupRoutes } = await import('../server/http.js');
const { setBillionStatus, _resetStatus } = await import('../server/billion-status.js');
const { sessions, CONFIG_DIR } = await import('../server/state.js');
const { dropMessages, flushMessages } = await import('../server/messages.js');

const model = join(mkdtempSync(join(tmpdir(), 'a007-talk-')), 'ggml-base.en.bin');
writeFileSync(model, 'model');
const ENV = { WHISPER_MODEL: model };
const WAV = Buffer.from('RIFF....WAVEfmt ');
let clock = 4e12;
const now = () => (clock += 10 * NOTIFY_WINDOW_MS);
let b;
const typed = () => b.pty.write.mock.calls.map(c => c[0]).join('').replace(/\x1b\[20[01]~/g, '');
const id = (n) => `utt-${n}-0123456789`;
// Billion idle again, so what waits in its queue is typed.
const deliver = () => { b.state = 'WAITING'; b.stateChangedAt = Date.now() + 1; b.messageDeliveredAt = 0; b.messageTyping = false; flushMessages(b); };

beforeEach(() => {
  rmSync(join(CONFIG_DIR, 'chat.json'), { force: true });
  rmSync(join(CONFIG_DIR, 'waiting.json'), { force: true });
  tools.available = new Set(['say', 'ffmpeg', 'whisper-cli']);
  tools.calls = [];
  tools.said = [];
  tools.delay = 0;
  tools.whisperOut = 'How is the launch going?';
  _resetTalk();
  b = {
    id: 'talk-billion', name: 'Billion', isBillion: true, command: 'claude', state: 'WAITING', exited: false,
    ownerId: null, stateChangedAt: Date.now() - 5000, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
  };
  sessions.set(b.id, b);
});
afterEach(() => {
  sessions.delete(b.id);
  dropMessages(b.id);
});

describe('an utterance', () => {
  it('is transcribed by whisper.cpp here and reaches Billion once, marked as an app voice turn', async () => {
    const result = await voiceUtterance(WAV, { utterance: id(1), env: ENV });
    expect(result).toMatchObject({ ok: true, transcript: 'How is the launch going?' });
    expect(result.id).toEqual(expect.any(String));
    expect(tools.calls.map(([cmd]) => cmd)).toEqual(['ffmpeg', 'whisper-cli']);
    expect(typed()).toContain(`[Owner via app, voice #${result.id.slice(0, 8)}] How is the launch going?`);
    const msg = chatMessages().find(m => m.id === result.id);
    expect(msg).toMatchObject({ from: 'owner', via: 'app', voice: true, utterance: id(1), awaitsReply: true, text: 'How is the launch going?' });
  });

  it('sent again, at once or later, or revised, is the same message: one transcription, one turn', async () => {
    tools.delay = 30;
    const [first, second] = await Promise.all([
      voiceUtterance(WAV, { utterance: id(2), env: ENV }),
      voiceUtterance(WAV, { utterance: id(2), env: ENV }),
    ]);
    expect(second.id).toBe(first.id);
    expect(tools.calls.filter(([cmd]) => cmd === 'whisper-cli')).toHaveLength(1);
    const later = await voiceUtterance(WAV, { utterance: id(2), env: ENV });
    expect(later).toMatchObject({ ok: true, id: first.id, duplicate: true });
    // The browser's recogniser revising its words under the same id.
    expect(await voiceSays('How is the launch doing?', { utterance: id(2), env: ENV })).toMatchObject({ id: first.id, duplicate: true });
    expect(typed().split('[Owner via app, voice #')).toHaveLength(2);
    expect(chatMessages().filter(m => m.utterance === id(2))).toHaveLength(1);
  });

  it('survives a restart: the id is kept with the message, not only in memory', async () => {
    const first = await voiceUtterance(WAV, { utterance: id(3), env: ENV });
    _resetTalk();
    expect(await voiceUtterance(WAV, { utterance: id(3), env: ENV })).toMatchObject({ id: first.id, duplicate: true });
    expect(tools.calls.filter(([cmd]) => cmd === 'whisper-cli')).toHaveLength(1);
  });

  it('is never a round shortcut or an answer: a misheard "start the round" is a turn of Billion\'s', async () => {
    const result = await voiceSays('Start the round now', { utterance: id(4), env: ENV });
    expect(result.id).toEqual(expect.any(String));
    expect(typed()).toContain(`[Owner via app, voice #${result.id.slice(0, 8)}] Start the round now`);
  });

  it('refuses a bad id, no audio, too much audio, no whisper.cpp, and a flood', async () => {
    expect((await voiceUtterance(WAV, { utterance: 'x', env: ENV })).error).toMatch(/id/);
    expect((await voiceUtterance(Buffer.alloc(0), { utterance: id(5), env: ENV })).error).toMatch(/No audio/);
    expect((await voiceUtterance(Buffer.alloc(MAX_UTTERANCE_BYTES + 1), { utterance: id(5), env: ENV })).error).toMatch(/5 minutes/);
    tools.available.delete('whisper-cli');
    const none = await voiceUtterance(WAV, { utterance: id(5), env: ENV });
    expect(none).toMatchObject({ noWhisper: true });
    expect(none.error).toMatch(/brew install whisper-cpp/);
    tools.available.add('whisper-cli');
    for (let i = 0; i < UTTERANCE_LIMIT; i++) await voiceUtterance(WAV, { utterance: id(100 + i), env: ENV, now: 1 });
    expect((await voiceUtterance(WAV, { utterance: id(999), env: ENV, now: 2 })).error).toMatch(/Too many/);
  });

  it('with no words heard sends nothing', async () => {
    tools.whisperOut = '[BLANK_AUDIO]';
    expect(await voiceUtterance(WAV, { utterance: id(6), env: ENV })).toMatchObject({ empty: true });
    expect(b.pty.write).not.toHaveBeenCalled();
  });
});

describe('echo', () => {
  it('drops Billion\'s own reply heard back through the speakers, but never a short barge-in', async () => {
    const asked = await voiceSays('Remind me what we shipped', { utterance: id(7), env: ENV });
    await tellOwner('We shipped the background service and the whisper check.', { env: {}, now: now(), replyTo: asked.id.slice(0, 8) });
    const reply = chatMessages().at(-1);
    expect(reply.replyTo).toBe(asked.id);
    const writes = b.pty.write.mock.calls.length;
    expect(await voiceSays('shipped the background service and the', { utterance: id(8), echoOf: reply.id, env: ENV })).toEqual({ ok: true, echo: true });
    expect(b.pty.write.mock.calls.length).toBe(writes);
    expect((await voiceSays('stop', { utterance: id(9), echoOf: reply.id, env: ENV })).id).toEqual(expect.any(String));
    expect((await voiceSays('No, what about the phone app?', { utterance: id(10), echoOf: reply.id, env: ENV })).id).toEqual(expect.any(String));
  });

  it('looksLikeEcho needs six of the reply\'s words in a row, so a confirmation said back is the owner\'s', () => {
    const said = 'Shall I merge PR 196 now? It is green and reviewed.';
    expect(looksLikeEcho('merge PR 196 now', said)).toBe(false);
    expect(looksLikeEcho('yes merge PR 196 now please', said)).toBe(false);
    expect(looksLikeEcho('I merge PR 196 now it is green', said)).toBe(true);
    expect(looksLikeEcho('wait stop', 'wait, stop, we shipped it')).toBe(false);
  });
});

describe('reply_to', () => {
  it('binds tell_owner to the voice turn it names, not the oldest waiting message', async () => {
    const typedTurn = await ownerSays('typed and left waiting', { env: {} });
    const asked = await voiceSays('What is my favourite colour?', { utterance: id(30), env: ENV });
    // The id Billion sees after # (the first voice turn's line is checked above).
    const short = asked.id.slice(0, 8);
    expect(await tellOwner('Teal.', { env: {}, now: now(), replyTo: short })).toMatchObject({ ok: true });
    expect(chatMessages().at(-1).replyTo).toBe(asked.id);
    // The typed one still waits; without reply_to the oldest is answered, as before.
    await tellOwner('About the typed one.', { env: {}, now: now() });
    expect(chatMessages().at(-1).replyTo).toBe(typedTurn.id);
  });

  it('naming no waiting message (a follow-up to a turn already answered) binds to nothing, and says so', async () => {
    const first = await voiceSays('First question here', { utterance: id(31), env: ENV });
    const second = await voiceSays('Second question here', { utterance: id(32), env: ENV });
    await tellOwner('First answer.', { env: {}, now: now(), replyTo: first.id.slice(0, 8) });
    const result = await tellOwner('More on the first.', { env: {}, now: now(), replyTo: first.id.slice(0, 8) });
    expect(result.note).toMatch(/answers none of them/);
    expect(chatMessages().at(-1).replyTo).toBeUndefined();
    expect(chatMessages().find(m => m.replyTo === second.id)).toBeUndefined();
    expect((await tellOwner('Short id.', { env: {}, now: now(), replyTo: second.id.slice(0, 4) })).note).toMatch(/answers none/);
  });

  it('without reply_to, a pending voice turn stays pending and the note answers nothing', async () => {
    const voice = await voiceSays('Spoken question', { utterance: id(33), env: ENV });
    await tellOwner('Job 12 is done.', { env: {}, now: now() });
    expect(chatMessages().at(-1).replyTo).toBeUndefined();
    expect(pendingOwnerMessages().map(m => m.id)).toContain(voice.id);
    await tellOwner('The real answer.', { env: {}, now: now(), replyTo: voice.id.slice(0, 8) });
    expect(chatMessages().at(-1).replyTo).toBe(voice.id);
    expect(pendingOwnerMessages().map(m => m.id)).not.toContain(voice.id);
  });

  it('without reply_to, a pending Telegram voice note (it has no #id) is still answered', async () => {
    addChat({ from: 'owner', via: 'telegram', voice: true, text: 'spoken on the phone', awaitsReply: true }, undefined, {});
    const note = pendingOwnerMessages().at(-1);
    await tellOwner('Got it.', { env: {}, now: now() });
    expect(chatMessages().at(-1).replyTo).toBe(note.id);
  });

  it('without reply_to, a typed message waiting is answered, even when a voice turn is older', async () => {
    const voice = await voiceSays('Spoken question', { utterance: id(34), env: ENV });
    const typedTurn = await ownerSays('typed after it', { env: {} });
    await tellOwner('Job 12 is done.', { env: {}, now: now() });
    expect(chatMessages().at(-1).replyTo).toBe(typedTurn.id);
    expect(pendingOwnerMessages().map(m => m.id)).toContain(voice.id);
  });
});

describe('a reply\'s audio', () => {
  async function voiceTurnAnswered(text) {
    const asked = await voiceSays('What is next?', { utterance: id(Math.random().toString(36).slice(2, 8)), env: ENV });
    await tellOwner(text, { env: {}, now: now(), replyTo: asked.id.slice(0, 8) });
    return { asked, reply: chatMessages().at(-1) };
  }

  it('is a tell_owner reply bound to the voice turn, spoken by say in pieces, as M4A', async () => {
    const long = 'First, the release. '.repeat(20) + 'Second, the [docs](https://example.com/x) are **done**.';
    const { reply } = await voiceTurnAnswered(long);
    const pieces = speechPieces(reply.text);
    expect(pieces.length).toBeGreaterThan(1);
    const first = await voiceAudioBuffer(reply.id, 0, { env: ENV, platform: 'darwin' });
    expect(first).toEqual({ type: 'audio/mp4', audio: Buffer.from('AUDIO'), count: pieces.length });
    expect(tools.said[0]).toBe(pieces[0]);
    const ffmpeg = tools.calls.find(([cmd]) => cmd === 'ffmpeg')[1];
    expect(ffmpeg).toEqual(expect.arrayContaining(['-c:a', 'aac']));
    expect(ffmpeg.at(-1)).toMatch(/say\.m4a$/);
    await voiceAudio(reply.id, pieces.length - 1, { env: ENV, platform: 'darwin' });
    expect(tools.said.at(-1)).toContain('Second, the docs are done.');
    expect(tools.said.join(' ')).not.toMatch(/https|\*\*/);
    // Fetched again (a retry, a prefetch): synthesized once.
    await voiceAudio(reply.id, 0, { env: ENV, platform: 'darwin' });
    expect(tools.said).toHaveLength(2);
    expect((await voiceAudio(reply.id, pieces.length, { env: ENV, platform: 'darwin' })).status).toBe(404);
  });

  it('is never served for a typed message\'s reply, a question, a server notice or an unknown id', async () => {
    const typedTurn = await ownerSays('typed question', { env: {} });
    await tellOwner('A reply to the typed one.', { env: {}, now: now() });
    const toTyped = chatMessages().at(-1);
    expect(toTyped.replyTo).toBe(typedTurn.id);
    expect((await voiceAudio(toTyped.id, 0, { env: ENV, platform: 'darwin' })).status).toBe(404);
    await voiceSays('A spoken one', { utterance: id(11), env: ENV });
    await tellOwner('Account switched.', { env: {}, now: now(), notice: true });
    expect((await voiceAudio(chatMessages().at(-1).id, 0, { env: ENV, platform: 'darwin' })).status).toBe(404);
    await notifyOwner('Spend twenty dollars?', { env: {}, now: now(), queue: false });
    expect((await voiceAudio(chatMessages().at(-1).id, 0, { env: ENV, platform: 'darwin' })).status).toBe(404);
    expect((await voiceAudio('nope', 0, { env: ENV, platform: 'darwin' })).status).toBe(404);
    expect(tools.said).toEqual([]);
  });

  it('without say (Linux, Windows) is a 503, so the page speaks it itself', async () => {
    const { reply } = await voiceTurnAnswered('Done.');
    expect(await voiceAudio(reply.id, 0, { env: ENV, platform: 'linux' })).toMatchObject({ status: 503 });
    expect(talkSetup(ENV, 'linux')).toMatchObject({ stt: 'whisper', tts: null, ttsMissing: expect.stringMatching(/macOS/) });
    expect(talkSetup(ENV, 'darwin')).toEqual({ stt: 'whisper', tts: 'say', acks: ACKS });
    expect(talkSetup({}, 'darwin')).toMatchObject({ stt: null, sttMissing: expect.stringMatching(/^Talking needs a whisper\.cpp model/) });
  });


  it('a progress update ("status") is Billion\'s status line now, cut short; none without one', async () => {
    _resetStatus();
    expect((await voiceAudio('status', 0, { env: ENV, platform: 'darwin' })).status).toBe(404);
    setBillionStatus('Reading server/talk.js and the progress box code');
    expect(await voiceAudio('status', 0, { env: ENV, platform: 'darwin' })).toMatchObject({ count: 1 });
    expect((await voiceAudio('status', 1, { env: ENV, platform: 'darwin' })).status).toBe(404);
    setBillionStatus('Running the tests');
    await voiceAudio('status', 0, { env: ENV, platform: 'darwin' });
    expect(tools.said).toEqual(['Reading and the progress box code', 'Running the tests']);
    _resetStatus();
  });

  it('a transcript that is the progress phrase just spoken is dropped; a real sentence is not', async () => {
    _resetStatus();
    setBillionStatus('Running the tests');
    const t = Date.now();
    await voiceAudio('status', 0, { env: ENV, platform: 'darwin', now: t });
    expect(await voiceSays('Running the tests.', { utterance: id(30), env: ENV, now: t + 1000 })).toEqual({ ok: true, echo: true });
    expect(await voiceSays('the tests', { utterance: id(31), env: ENV, now: t + 1000 })).toEqual({ ok: true, echo: true });
    expect((await voiceSays('Stop and merge the pull request', { utterance: id(32), env: ENV, now: t + 1000 })).id).toEqual(expect.any(String));
    expect((await voiceSays('Running the tests', { utterance: id(33), env: ENV, now: t + 11000 })).id).toEqual(expect.any(String));
    _resetStatus();
  });

  it('a short mishearing of the heading just spoken is dropped; a different request is not', async () => {
    _resetStatus();
    setBillionStatus('Running the tests');
    const t = Date.now();
    await voiceAudio('status', 0, { env: ENV, platform: 'darwin', now: t });
    expect(await voiceSays('Running the best.', { utterance: id(34), env: ENV, now: t + 1000 })).toEqual({ ok: true, echo: true });
    for (const [n, said] of [[35, 'work on the README'], [36, 'stop'], [37, 'what about groceries?']]) {
      expect((await voiceSays(said, { utterance: id(n), env: ENV, now: t + 1000 })).id).toEqual(expect.any(String));
    }
    _resetStatus();
  });
});

describe('a turn gathered from segments', () => {
  it('a segment is transcribed here and sent nowhere; the turn goes to Billion once', async () => {
    tools.whisperOut = 'Check the release';
    expect(await voiceSegment(WAV, { segment: id(40), env: ENV })).toMatchObject({ text: 'Check the release' });
    expect(chatMessages()).toEqual([]);
    expect(typed()).toBe('');
    expect((await voiceSegment(WAV, { segment: 'bad', env: ENV })).error).toMatch(/Bad segment/);
    expect((await voiceSegment(Buffer.alloc(0), { segment: id(41), env: ENV })).error).toMatch(/No audio/);
    const sent = await voiceSays('Check the release and then merge it.', { utterance: id(42), env: ENV });
    expect(typed()).toContain(`[Owner via app, voice #${sent.id.slice(0, 8)}] Check the release and then merge it.`);
  });

  it('a segment that is the acknowledgment playing, or the reply playing, comes back empty as echo', async () => {
    tools.whisperOut = 'Got it, one sec.';
    expect(await voiceSegment(WAV, { segment: id(43), echoOf: 'ack-0', env: ENV })).toMatchObject({ text: '', echo: true });
    // The owner's own "got it" with no acknowledgment playing is theirs.
    tools.whisperOut = 'Got it';
    expect(await voiceSegment(WAV, { segment: id(44), env: ENV })).toMatchObject({ text: 'Got it' });
    tools.whisperOut = 'Something else entirely about the board';
    expect(await voiceSegment(WAV, { segment: id(45), echoOf: 'ack-0', env: ENV })).toMatchObject({ text: 'Something else entirely about the board' });
    // Sharing words with the acknowledgment is not being it.
    tools.whisperOut = 'No, give me a second.';
    expect(await voiceSegment(WAV, { segment: id(46), echoOf: 'ack-7', env: ENV })).toMatchObject({ text: 'No, give me a second.' });
    tools.whisperOut = 'me a second';
    expect(await voiceSegment(WAV, { segment: id(47), echoOf: 'ack-7', env: ENV })).toMatchObject({ text: '', echo: true });
  });

  it('a fragment of the owner\'s turn that shares words with a progress phrase is kept; the whole turn is checked', async () => {
    _resetStatus();
    setBillionStatus('Running the tests');
    const t = Date.now();
    await voiceAudio('status', 0, { env: ENV, platform: 'darwin', now: t });
    tools.whisperOut = 'the tests';
    expect(await voiceSegment(WAV, { segment: id(48), env: ENV, now: t + 1000 })).toMatchObject({ text: 'the tests' });
    expect(await voiceSays('Stop running the tests and merge.', { utterance: id(49), env: ENV, now: t + 1000 })).toMatchObject({ ok: true, id: expect.any(String) });
    expect(await voiceSays('Running the tests.', { utterance: id(56), env: ENV, now: t + 1000 })).toEqual({ ok: true, echo: true });
    _resetStatus();
  });

  it('words added while the turn still waits in Billion\'s queue join it: one turn, typed once', async () => {
    b.state = 'WORKING';
    const broadcast = vi.fn();
    const first = await voiceSays('Can you check the release', { utterance: id(50), env: ENV, broadcast });
    expect(chatMessages()[0]).toMatchObject({ queued: true });
    const more = await voiceSays('and the open pull requests.', { utterance: id(51), continues: first.id, env: ENV, broadcast });
    expect(more).toEqual({ ok: true, id: first.id, merged: true });
    expect(chatMessages()).toHaveLength(1);
    expect(chatMessages()[0].text).toBe('Can you check the release and the open pull requests.');
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'chat-message', message: expect.objectContaining({ text: 'Can you check the release and the open pull requests.' }) });
    // A retry of the added words is the same turn.
    expect(await voiceSays('and the open pull requests.', { utterance: id(51), continues: first.id, env: ENV })).toMatchObject({ id: first.id, duplicate: true });
    deliver();
    expect(typed().split('[Owner via app, voice #')).toHaveLength(2);
    expect(typed()).toContain(`[Owner via app, voice #${first.id.slice(0, 8)}] Can you check the release and the open pull requests.`);
  });

  it('words added after Billion has the turn are sent naming it, and one answer closes both', async () => {
    const first = await voiceSays('Can you check the release', { utterance: id(52), env: ENV });
    const more = await voiceSays('and the open pull requests', { utterance: id(53), continues: first.id, env: ENV });
    deliver();
    expect(more.id).not.toBe(first.id);
    expect(more.merged).toBeUndefined();
    expect(typed()).toContain(`[Owner via app, voice #${more.id.slice(0, 8)}, adds to #${first.id.slice(0, 8)}] and the open pull requests`);
    expect(chatMessages().at(-1)).toMatchObject({ continues: first.id });
    expect(pendingOwnerMessages().map(m => m.id)).toEqual([first.id, more.id]);
    await tellOwner('The release is out and two PRs are open.', { env: {}, now: now(), replyTo: more.id.slice(0, 8) });
    expect(pendingOwnerMessages()).toEqual([]);
    expect(chatMessages().find(m => m.id === first.id).awaitsReply).toBe(false);
  });

  it('a segment retried while it is transcribed is one transcription; no whisper.cpp and a flood are refused', async () => {
    tools.delay = 30;
    const [one, two] = await Promise.all([voiceSegment(WAV, { segment: id(46), env: ENV }), voiceSegment(WAV, { segment: id(46), env: ENV })]);
    expect(two).toEqual(one);
    expect(tools.calls.filter(([cmd]) => cmd === 'whisper-cli')).toHaveLength(1);
    tools.delay = 0;
    tools.available.delete('whisper-cli');
    expect(await voiceSegment(WAV, { segment: id(47), env: ENV })).toMatchObject({ noWhisper: true, error: expect.stringMatching(/^Talking needs/) });
    tools.available.add('whisper-cli');
    for (let i = 0; i < UTTERANCE_LIMIT; i++) await voiceSegment(WAV, { segment: id(200 + i), env: ENV, now: 1 });
    expect((await voiceSegment(WAV, { segment: id(299), env: ENV, now: 2 })).error).toMatch(/Too many/);
    expect(chatMessages()).toEqual([]);
  });

  it('a chain of additions: one answer to the last closes every turn it adds to', async () => {
    const a = await voiceSays('Check the release', { utterance: id(56), env: ENV });
    const bb = await voiceSays('and the open PRs', { utterance: id(57), continues: a.id, env: ENV });
    deliver();
    const c = await voiceSays('and the board', { utterance: id(58), continues: bb.id, env: ENV });
    expect(chatMessages().at(-1)).toMatchObject({ id: c.id, continues: bb.id });
    expect(pendingOwnerMessages()).toHaveLength(3);
    await tellOwner('All fine.', { env: {}, now: now(), replyTo: c.id.slice(0, 8) });
    expect(pendingOwnerMessages()).toEqual([]);
  });

  it('continuing a typed message or an unknown id is a turn of its own', async () => {
    const typedMsg = await ownerSays('A typed question', { env: ENV });
    const next = await voiceSays('Then ship it', { utterance: id(59), continues: typedMsg.id, env: ENV });
    expect(next.merged).toBeUndefined();
    expect(chatMessages().at(-1).continues).toBeUndefined();
    const other = await voiceSays('Something else', { utterance: id(61), continues: 'no-such-message', env: ENV });
    expect(chatMessages().find(m => m.id === other.id).continues).toBeUndefined();
    expect(typed()).not.toContain('adds to');
  });

  it('a turn already answered is not continued: the words are a turn of their own', async () => {
    const first = await voiceSays('Is the build green', { utterance: id(54), env: ENV });
    await tellOwner('Yes.', { env: {}, now: now(), replyTo: first.id.slice(0, 8) });
    const next = await voiceSays('Then ship it', { utterance: id(55), continues: first.id, env: ENV });
    deliver();
    expect(typed()).toContain(`[Owner via app, voice #${next.id.slice(0, 8)}] Then ship it`);
    expect(chatMessages().at(-1).continues).toBeUndefined();
  });
});

describe('ElevenLabs', () => {
  const ELEVEN = { ...ENV, ELEVENLABS_API_KEY: 'xi-secret-key' };
  const realFetch = globalThis.fetch;
  let calls, tts;
  // ElevenLabs stands in; anything else (the routes' own requests) is real.
  function stubEleven() {
    calls = [];
    tts = (body) => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(`MP3[${body.text}]`)); c.enqueue(new TextEncoder().encode('MORE')); c.close(); },
    }), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (!String(url).startsWith('https://api.elevenlabs.io/')) return realFetch(url, init);
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/voices')) return Response.json({ voices: [{ voice_id: 'R'.repeat(20), name: 'Roger - Laid-Back' }] });
      return tts(JSON.parse(init.body));
    }));
  }
  beforeEach(() => {
    stubEleven();
    _resetEleven();
    rmSync(join(CONFIG_DIR, 'talk-voice'), { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('speaks with Eric on Flash by default, streamed as MP3, and the page is told', async () => {
    expect(talkSetup(ELEVEN, 'linux')).toMatchObject({ tts: 'elevenlabs', voice: 'Eric' });
    expect(talkSetup(ELEVEN, 'linux').ttsMissing).toBeUndefined();
    const asked = await voiceSays('What is next?', { utterance: id(60), env: ENV });
    await tellOwner('The release is out.', { env: {}, now: now(), replyTo: asked.id.slice(0, 8) });
    const reply = chatMessages().at(-1);
    const got = await voiceAudio(reply.id, 0, { env: ELEVEN, platform: 'linux' });
    expect(got).toMatchObject({ type: 'audio/mpeg', count: 1 });
    const chunks = [];
    for await (const c of got.stream) chunks.push(c.toString());
    expect(chunks).toEqual(['MP3[The release is out.]', 'MORE']);
    const call = calls.find(c => c.url.includes('/text-to-speech/'));
    expect(call.url).toMatch(/\/text-to-speech\/cjVigY5qzO86Huf0OWal\/stream\?output_format=mp3_/);
    expect(JSON.parse(call.init.body)).toEqual({ text: 'The release is out.', model_id: 'eleven_flash_v2_5' });
    expect(call.init.headers['xi-api-key']).toBe('xi-secret-key');
    expect(tools.said).toEqual([]);
  });

  it('ELEVENLABS_VOICE names a voice on the account (or is its id); ELEVENLABS_MODEL picks the model', async () => {
    const env = { ...ELEVEN, ELEVENLABS_VOICE: 'Roger', ELEVENLABS_MODEL: 'eleven_turbo_v2_5' };
    const got = await voiceAudioBuffer('ack-1', 0, { env, platform: 'linux' });
    expect(got.audio.toString()).toBe(`MP3[${ACKS[1]}]MORE`);
    const call = calls.find(c => c.url.includes('/text-to-speech/'));
    expect(call.url).toContain(`/text-to-speech/${'R'.repeat(20)}/stream`);
    expect(JSON.parse(call.init.body).model_id).toBe('eleven_turbo_v2_5');
  });

  it('an acknowledgment is made once per voice and kept on disk across restarts', async () => {
    await voiceAudioBuffer('ack-2', 0, { env: ELEVEN, platform: 'linux' });
    await new Promise(r => setTimeout(r, 10));
    _resetTalk();
    const again = await voiceAudioBuffer('ack-2', 0, { env: ELEVEN, platform: 'linux' });
    expect(again.audio.toString()).toBe(`MP3[${ACKS[2]}]MORE`);
    expect(calls.filter(c => c.url.includes('/text-to-speech/'))).toHaveLength(1);
    expect((await voiceAudio('ack-99', 0, { env: ELEVEN, platform: 'linux' })).status).toBe(404);
  });

  it('an acknowledgment that came out far too long (a phrase said twice) is not kept', async () => {
    const said = ACKS[0];
    tts = () => new Response(new Uint8Array(40000));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await voiceAudioBuffer('ack-0', 0, { env: ELEVEN, platform: 'linux' });
    await new Promise(r => setTimeout(r, 10));
    expect(log.mock.calls.join(' ')).toMatch(/came out too long/);
    tts = (body) => new Response(`MP3[${body.text}]`);
    expect((await voiceAudioBuffer('ack-0', 0, { env: ELEVEN, platform: 'linux' })).audio.toString()).toBe(`MP3[${said}]`);
    expect(calls.filter(c => c.url.includes('/text-to-speech/'))).toHaveLength(2);
    log.mockRestore();
  });

  it('ELEVENLABS_VOICE as an id is used as is; a name not on the account, or a failed lookup, is Eric', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await voiceAudioBuffer('ack-0', 0, { env: { ...ELEVEN, ELEVENLABS_VOICE: 'A'.repeat(20) }, platform: 'linux' });
    expect(calls.map(c => c.url)).toEqual([expect.stringContaining(`/text-to-speech/${'A'.repeat(20)}/stream`)]);
    calls.length = 0;
    await voiceAudioBuffer('ack-1', 0, { env: { ...ELEVEN, ELEVENLABS_VOICE: 'Nobody' }, platform: 'linux' });
    expect(calls.find(c => c.url.includes('/text-to-speech/')).url).toContain('/text-to-speech/cjVigY5qzO86Huf0OWal/');
    expect(log.mock.calls.join(' ')).toMatch(/"Nobody" is not on this account; using Eric/);
    // The voice list cannot be had: Eric, not an error.
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/voices')) return new Response('down', { status: 500 });
      return tts(JSON.parse(init.body));
    }));
    calls.length = 0;
    const got = await voiceAudioBuffer('ack-2', 0, { env: { ...ELEVEN, ELEVENLABS_VOICE: 'Someone' }, platform: 'linux' });
    expect(got.audio.toString()).toBe(`MP3[${ACKS[2]}]MORE`);
    expect(calls.find(c => c.url.includes('/text-to-speech/')).url).toContain('/text-to-speech/cjVigY5qzO86Huf0OWal/');
    expect(log.mock.calls.join(' ')).not.toMatch(/"Someone" is not on this account/);
    // ElevenLabs is back: the name is looked up again, not pinned to Eric.
    stubEleven();
    await voiceAudioBuffer('ack-3', 0, { env: { ...ELEVEN, ELEVENLABS_VOICE: 'Roger' }, platform: 'linux' });
    _resetTalk();
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/voices')) return new Response('down', { status: 500 });
      return tts(JSON.parse(init.body));
    }));
    _resetEleven();
    await voiceAudioBuffer('ack-4', 0, { env: { ...ELEVEN, ELEVENLABS_VOICE: 'Roger' }, platform: 'linux' });
    stubEleven();
    await voiceAudioBuffer('ack-6', 0, { env: { ...ELEVEN, ELEVENLABS_VOICE: 'Roger' }, platform: 'linux' });
    expect(calls.find(c => c.url.includes('/text-to-speech/')).url).toContain(`/text-to-speech/${'R'.repeat(20)}/`);
    log.mockRestore();
  });

  it('no audio back, or an error with no detail, falls back to say', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    tts = () => new Response(new ReadableStream({ start(c) { c.close(); } }));
    expect(await voiceAudioBuffer('ack-5', 0, { env: ELEVEN, platform: 'darwin' })).toMatchObject({ type: 'audio/mp4', audio: Buffer.from('AUDIO') });
    expect(errors.mock.calls.join(' ')).toMatch(/no audio came back/);
    _resetTalk();
    tts = () => new Response('<html>oops</html>', { status: 500 });
    expect(await voiceAudioBuffer('ack-6', 0, { env: ELEVEN, platform: 'darwin' })).toMatchObject({ type: 'audio/mp4' });
    expect(errors.mock.calls.join(' ')).toMatch(/ElevenLabs HTTP 500(?! \()/);
    errors.mockRestore();
  });

  it('audio that breaks off after it started throws to the reader, and is made again next time', async () => {
    let n = 0;
    tts = (body) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`MP3[${body.text}]`));
        if (n++ === 0) setTimeout(() => c.error(new Error('connection reset')), 5);
        else c.close();
      },
    }));
    const got = await voiceAudio('ack-7', 0, { env: ELEVEN, platform: 'linux' });
    expect(got).toMatchObject({ type: 'audio/mpeg' });
    await expect((async () => { for await (const _ of got.stream); })()).rejects.toThrow(/connection reset/);
    await new Promise(r => setTimeout(r, 10));
    expect(existsSync(join(CONFIG_DIR, 'talk-voice'))).toBe(false);
    const again = await voiceAudioBuffer('ack-7', 0, { env: ELEVEN, platform: 'linux' });
    expect(again.audio.toString()).toBe(`MP3[${ACKS[7]}]`);
    expect(calls.filter(c => c.url.includes('/text-to-speech/'))).toHaveLength(2);
  });

  it('falls back to say when ElevenLabs refuses, and never shows the key', async () => {
    tts = () => Response.json({ detail: { status: 'quota_exceeded' } }, { status: 401 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got = await voiceAudioBuffer('ack-3', 0, { env: ELEVEN, platform: 'darwin' });
    expect(got).toMatchObject({ type: 'audio/mp4', audio: Buffer.from('AUDIO') });
    expect(tools.said).toEqual([ACKS[3]]);
    expect(errors.mock.calls.join(' ')).toMatch(/so say does: ElevenLabs HTTP 401 \(quota_exceeded\)/);
    // No say either (Linux): a 503 for the page to speak it itself.
    expect(await voiceAudio('ack-4', 0, { env: ELEVEN, platform: 'linux' })).toMatchObject({ status: 503 });
    expect(errors.mock.calls.join(' ')).not.toContain('xi-secret-key');
    errors.mockRestore();
  });
});

describe('the routes', () => {
  let base, server;
  beforeAll(async () => {
    const app = express();
    setupRoutes(app, mkdtempSync(join(tmpdir(), 'a007-talk-static-')), { broadcast: () => {} });
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const H = { 'X-Agent007-Talk': '1' };

  it('need the tab\'s own header, which a page elsewhere cannot send without a preflight', async () => {
    expect((await fetch(`${base}/api/talk`)).status).toBe(403);
    expect((await fetch(`${base}/api/talk`, { headers: H })).status).toBe(200);
    expect((await fetch(`${base}/api/talk/utterance`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Utterance-Id': id(20) }, body: WAV })).status).toBe(403);
    expect((await fetch(`${base}/api/talk/audio/status/0`)).status).toBe(403);
    expect((await fetch(`${base}/api/talk`, { headers: { ...H, Origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('take an utterance once and a browser transcript once, under the same id', async () => {
    const send = () => fetch(`${base}/api/talk/text`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ utterance: id(21), text: 'Any news on the job?' }) }).then(r => r.json());
    const first = await send();
    expect(await send()).toMatchObject({ id: first.id, duplicate: true });
    expect(typed().split('[Owner via app, voice #')).toHaveLength(2);
  });

  it('transcribe a segment without sending it, and stream a reply\'s audio with its type', async () => {
    tools.whisperOut = 'Is it done';
    vi.stubEnv('WHISPER_MODEL', model);
    const seg = await fetch(`${base}/api/talk/segment`, { method: 'POST', headers: { ...H, 'Content-Type': 'audio/wav', 'X-Segment-Id': id(70) }, body: WAV }).then(r => r.json());
    expect(seg, JSON.stringify(seg)).toMatchObject({ text: 'Is it done' });
    expect(typed()).toBe('');
    // ElevenLabs stands in, streaming two chunks.
    vi.stubEnv('ELEVENLABS_API_KEY', 'k');
    rmSync(join(CONFIG_DIR, 'talk-voice'), { recursive: true, force: true });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url, init) => (String(url).startsWith('https://api.elevenlabs.io/')
      ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('ID3')); c.enqueue(new TextEncoder().encode('MP3')); c.close(); } }))
      : realFetch(url, init)));
    const res = await fetch(`${base}/api/talk/audio/ack-0/0`, { headers: H });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('X-Pieces')).toBe('1');
    expect(await res.text()).toBe('ID3MP3');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuse a segment with a bad id or no audio with a 400', async () => {
    const post = (headers, body) => fetch(`${base}/api/talk/segment`, { method: 'POST', headers: { ...H, 'Content-Type': 'audio/wav', ...headers }, body });
    const bad = await post({ 'X-Segment-Id': 'x' }, WAV);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Bad segment/);
    expect((await post({}, WAV)).status).toBe(400);
    expect(typed()).toBe('');
  });

  it('refuse an utterance over the size limit', async () => {
    const res = await fetch(`${base}/api/talk/utterance`, { method: 'POST', headers: { ...H, 'Content-Type': 'audio/wav', 'X-Utterance-Id': id(22) }, body: Buffer.alloc(MAX_UTTERANCE_BYTES + 10) });
    expect(res.status).toBe(413);
  });

  it('serve the voice detector from this app, and nothing else from its packages', async () => {
    const vad = await fetch(`${base}/vendor/vad/bundle.min.js`);
    expect(vad.status).toBe(200);
    expect((await fetch(`${base}/vendor/ort/ort-wasm-simd-threaded.wasm`)).status).toBe(200);
    expect((await fetch(`${base}/vendor/vad/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/vendor/ort/..%2F..%2Fpackage.json`)).status).toBe(404);
  });
});
