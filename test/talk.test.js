// Talk to Billion, the server side (server/talk.js, its routes in
// server/http.js): an utterance's audio transcribed by a stub whisper.cpp and
// sent to Billion once as [Owner via app, voice], a retry or revised
// transcript never a second message, Billion's own voice dropped as echo, and
// a stub `say` speaking only a tell_owner reply bound to a voice turn.
// spawn and the PATH lookup are mocked: nothing runs say, ffmpeg or whisper.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'fs';
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
const { talkSetup, voiceUtterance, voiceSays, voiceAudio, looksLikeEcho, speechPieces, _resetTalk, MAX_UTTERANCE_BYTES, UTTERANCE_LIMIT } = await import('../server/talk.js');
const { setupRoutes } = await import('../server/http.js');
const { setBillionStatus, _resetStatus } = await import('../server/billion-status.js');
const { sessions, CONFIG_DIR } = await import('../server/state.js');
const { dropMessages } = await import('../server/messages.js');

const model = join(mkdtempSync(join(tmpdir(), 'a007-talk-')), 'ggml-base.en.bin');
writeFileSync(model, 'model');
const ENV = { WHISPER_MODEL: model };
const WAV = Buffer.from('RIFF....WAVEfmt ');
let clock = 4e12;
const now = () => (clock += 10 * NOTIFY_WINDOW_MS);
let b;
const typed = () => b.pty.write.mock.calls.map(c => c[0]).join('').replace(/\x1b\[20[01]~/g, '');
const id = (n) => `utt-${n}-0123456789`;

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
    const first = await voiceAudio(reply.id, 0, { env: ENV, platform: 'darwin' });
    expect(first).toEqual({ audio: Buffer.from('AUDIO'), count: pieces.length });
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
    expect(talkSetup(ENV, 'darwin')).toEqual({ stt: 'whisper', tts: 'say' });
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
