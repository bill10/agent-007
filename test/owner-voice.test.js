// Telegram voice both ways (server/voice.js, server/owner.js): when Billion
// speaks, the sendVoice upload, falling back to text, and the owner's voice
// notes transcribed by whisper.cpp. fetch, spawn and the PATH lookup are all
// mocked: nothing here talks to Telegram or runs say, ffmpeg or whisper.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tools = { available: new Set(), whisperOut: 'Yes, buy the domain.', exit: 0, calls: [], said: [] };

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn((cmd, args) => {
    tools.calls.push([cmd, args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (cmd === 'say') tools.said.push(readFileSync(args[3], 'utf8'));
      if (cmd === 'ffmpeg') writeFileSync(args[args.length - 1], 'OGGDATA');
      if (cmd.includes('whisper')) child.stdout.emit('data', `\n ${tools.whisperOut}\n`);
      child.emit('close', cmd.includes('whisper') ? tools.exit : 0);
    });
    return child;
  }),
}));
vi.mock('../server/command-path.js', async (importOriginal) => ({
  ...(await importOriginal()),
  commandExists: (file) => tools.available.has(file),
}));

const { notifyOwner, sendToOwner, handleUpdate, lastOwnerMode, OWNER_VOICE_PREFIX, NOTIFY_WINDOW_MS } = await import('../server/owner.js');
const { chooseMode, textOnlyReason, whisperSetup, MAX_NOTE_SECONDS, MAX_NOTE_BYTES } = await import('../server/voice.js');
const { sessions, CONFIG_DIR } = await import('../server/state.js');
const { dropMessages } = await import('../server/messages.js');

const TOKEN = '123456:SECRET-token';
const model = join(mkdtempSync(join(tmpdir(), 'a007-whisper-')), 'ggml-base.en.bin');
writeFileSync(model, 'model');
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', WHISPER_MODEL: model };
const reply = (result) => ({ ok: true, json: async () => ({ ok: true, result }), arrayBuffer: async () => new TextEncoder().encode('OPUS').buffer });
let fetchMock;
let clock = 2e12;
const now = () => (clock += 10 * NOTIFY_WINDOW_MS);
const setMode = (mode) => writeFileSync(join(CONFIG_DIR, 'telegram-voice.json'), JSON.stringify({ lastMode: mode }));

const billion = () => ({
  id: 'voice-billion', name: 'Billion', isBillion: true, command: 'claude',
  state: 'WAITING', exited: false, ownerId: null, stateChangedAt: Date.now() - 5000,
  recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
});
const typedInto = (b) => b.pty.write.mock.calls.map(c => c[0]).join('');
const methods = () => fetchMock.mock.calls.map(([url]) => url.split('/').pop());
const voiceUpdate = (chat, note) => ({ update_id: 1, message: { chat: { id: chat }, voice: { file_id: 'F1', duration: 4, ...note } } });

beforeEach(() => {
  fetchMock = vi.fn(async (url) => reply(url.endsWith('/getFile') ? { file_path: 'voice/file_1.oga', file_size: 1000 } : true));
  vi.stubGlobal('fetch', fetchMock);
  tools.available = new Set(['say', 'ffmpeg', 'whisper-cli']);
  tools.calls = [];
  tools.said = [];
  tools.exit = 0;
  tools.whisperOut = 'Yes, buy the domain.';
  rmSync(join(CONFIG_DIR, 'telegram-voice.json'), { force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessions.delete('voice-billion');
  dropMessages('voice-billion');
});

describe('when Billion speaks', () => {
  it('TELEGRAM_VOICE: never is text, always is voice, mirror follows the owner\'s last message', () => {
    const say = 'Spend twenty dollars on the domain? I recommend yes.';
    expect(chooseMode(say, { env: { TELEGRAM_VOICE: 'never' }, lastMode: 'voice' }).mode).toBe('text');
    expect(chooseMode(say, { env: { TELEGRAM_VOICE: 'always' }, lastMode: 'text' }).mode).toBe('voice');
    expect(chooseMode(say, { env: {}, lastMode: 'voice' }).mode).toBe('voice');
    expect(chooseMode(say, { env: {}, lastMode: 'text' }).mode).toBe('text');
    expect(chooseMode(say, { env: { TELEGRAM_VOICE: 'mirror' } }).mode).toBe('text');   // before the owner has said anything
  });

  it('keeps long messages and ones that are mostly links, code or paths as text, even with always', () => {
    const always = { env: { TELEGRAM_VOICE: 'always' } };
    expect(chooseMode('word '.repeat(200), always)).toEqual({ mode: 'text', reason: 'long' });
    expect(textOnlyReason('PR: https://github.com/bill10/agent-007/pull/114')).toBe('mostly links, code or paths');
    expect(textOnlyReason('Run `npm ci && npm test` in ~/src/agent-007/server')).toBe('mostly links, code or paths');
    expect(textOnlyReason('```\nconst x = 1;\n```')).toBe('mostly links, code or paths');
    // A sentence that happens to carry a link is still spoken.
    expect(textOnlyReason('The landing page is live and the signups look good so far, have a look: https://x.co/a')).toBeNull();
    expect(textOnlyReason('Should I buy the domain? I recommend yes.')).toBeNull();
    expect(textOnlyReason('yes/no? and/or 24/7')).toBeNull();   // one slash is prose
    expect(textOnlyReason('see server/owner.js')).toBe('mostly links, code or paths');
  });

  it('sends voice as multipart sendVoice with the text as its caption, the text never on a command line', async () => {
    setMode('voice');
    expect(await notifyOwner('Buy the domain? See https://x.co/d for the price, I recommend yes.', { env: ENV, now: now(), platform: 'darwin' })).toMatchObject({ ok: true });
    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendVoice`);
    expect(init.headers).toBeUndefined();   // fetch sets the multipart boundary itself
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('chat_id')).toBe('42');
    expect(init.body.get('caption')).toMatch(/^Billion \(Q\d+\): Buy the domain\? See https:\/\/x\.co\/d for the price, I recommend yes\.$/);
    const voice = init.body.get('voice');
    expect(voice.type).toBe('audio/ogg');
    expect(voice.name).toBe('billion.ogg');
    expect(Buffer.from(await voice.arrayBuffer()).toString()).toBe('OGGDATA');
    const [say, ffmpeg] = tools.calls;
    expect(say[0]).toBe('say');
    expect(say[1]).toEqual(['-o', expect.stringMatching(/say\.aiff$/), '-f', expect.stringMatching(/say\.txt$/)]);
    expect(ffmpeg[1]).toEqual(expect.arrayContaining(['-c:a', 'libopus', '-b:a', '32k']));
    expect(tools.calls.flatMap(c => c[1]).join(' ')).not.toContain('domain');
    expect(tools.said).toEqual([expect.stringMatching(/^Billion \(Q\d+\): Buy the domain\? See link for the price, I recommend yes\.$/)]);
  });

  it('sends text, and says why once, when say or ffmpeg is missing or this is not macOS', async () => {
    setMode('voice');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    tools.available.delete('ffmpeg');
    expect(await sendToOwner('Billion: hello there', { env: ENV, platform: 'darwin' })).toEqual({ ok: true });
    expect(await sendToOwner('Billion: hello again', { env: ENV, platform: 'linux' })).toEqual({ ok: true });
    expect(methods()).toEqual(['sendMessage', 'sendMessage']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chat_id: '42', text: 'Billion: hello there' });
    expect(tools.calls).toEqual([]);
    expect(log.mock.calls.filter(c => /not voice/.test(c[0]))).toEqual([[expect.stringMatching(/ffmpeg is not installed/)]]);
  });

  it('falls back to text when the upload fails, with the token kept out of the error', async () => {
    setMode('voice');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendVoice`));
    expect(await sendToOwner('Billion: hi', { env: ENV, platform: 'darwin' })).toEqual({ ok: true });
    expect(methods()).toEqual(['sendVoice', 'sendMessage']);
  });
});

describe('when the owner speaks', () => {
  it('transcribes the owner\'s voice note locally and types it into Billion, marked as voice', async () => {
    const b = billion();
    sessions.set(b.id, b);
    expect(await handleUpdate(voiceUpdate(42), { env: ENV })).toBe('delivered');
    expect(typedInto(b)).toContain(`${OWNER_VOICE_PREFIX} Yes, buy the domain.`);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.telegram.org/bot${TOKEN}/getFile`,
      `https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`,
    ]);
    const [ffmpeg, whisper] = tools.calls;
    expect(ffmpeg[1]).toEqual(expect.arrayContaining(['-ar', '16000', '-ac', '1']));
    expect(whisper).toEqual(['whisper-cli', ['-m', model, '-f', expect.stringMatching(/note\.wav$/), '-nt', '-np']]);
    // Mirror remembers it, on disk, so Billion's next message is spoken.
    expect(lastOwnerMode()).toBe('voice');
    expect(JSON.parse(readFileSync(join(CONFIG_DIR, 'telegram-voice.json'), 'utf8'))).toEqual({ lastMode: 'voice' });
    await handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: 'and one more thing' } }, { env: ENV });
    expect(lastOwnerMode()).toBe('text');
  });

  it('takes an audio file the same way', async () => {
    const b = billion();
    sessions.set(b.id, b);
    expect(await handleUpdate({ update_id: 1, message: { chat: { id: 42 }, audio: { file_id: 'A1', duration: 10 } } }, { env: ENV })).toBe('delivered');
    expect(typedInto(b)).toContain(OWNER_VOICE_PREFIX);
  });

  it('finds whisper.cpp by WHISPER_CPP_BIN or its other names, and needs ffmpeg too', () => {
    tools.available = new Set(['ffmpeg', 'whisper-cpp', '/opt/w/bin/whisper-cli']);
    expect(whisperSetup(ENV)).toEqual({ bin: 'whisper-cpp', model });
    expect(whisperSetup({ ...ENV, WHISPER_CPP_BIN: '/opt/w/bin/whisper-cli' })).toEqual({ bin: '/opt/w/bin/whisper-cli', model });
    tools.available.delete('ffmpeg');
    expect(whisperSetup(ENV).missing).toMatch(/ffmpeg/);
  });

  it('answers a note with no words in it, or a failed transcription, and delivers nothing', async () => {
    const b = billion();
    sessions.set(b.id, b);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tools.whisperOut = '[BLANK_AUDIO]';
    expect(await handleUpdate(voiceUpdate(42), { env: ENV })).toBe('empty');
    tools.whisperOut = 'hello';
    tools.exit = 1;
    expect(await handleUpdate(voiceUpdate(42), { env: ENV })).toBe('failed');
    expect(b.pty.write).not.toHaveBeenCalled();
  });

  it('says Billion is not running without transcribing', async () => {
    expect(await handleUpdate(voiceUpdate(42), { env: ENV })).toBe('not-running');
    expect(methods()).toEqual(['sendMessage']);
    expect(tools.calls).toEqual([]);
  });

  it('keeps a caption the owner typed on the note', async () => {
    const b = billion();
    sessions.set(b.id, b);
    const update = voiceUpdate(42);
    update.message.caption = 'about the domain';
    expect(await handleUpdate(update, { env: ENV })).toBe('delivered');
    expect(typedInto(b)).toContain(`${OWNER_VOICE_PREFIX} Yes, buy the domain. (caption: about the domain)`);
  });

  it('ignores a voice note from any other chat: no download, no transcription, no reply', async () => {
    const b = billion();
    sessions.set(b.id, b);
    expect(await handleUpdate(voiceUpdate(43), { env: ENV })).toBe('ignored');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tools.calls).toEqual([]);
    expect(b.pty.write).not.toHaveBeenCalled();
    expect(lastOwnerMode()).toBeUndefined();
  });

  it('without whisper.cpp or a model, says how to enable it and delivers nothing', async () => {
    const b = billion();
    sessions.set(b.id, b);
    tools.available.delete('whisper-cli');
    expect(await handleUpdate(voiceUpdate(42), { env: ENV })).toBe('no-whisper');
    tools.available.add('whisper-cli');
    expect(await handleUpdate(voiceUpdate(42), { env: { ...ENV, WHISPER_MODEL: '/no/such/model.bin' } })).toBe('no-whisper');
    const replies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).text);
    expect(replies[0]).toMatch(/brew install whisper-cpp.*send text instead/);
    expect(replies[1]).toMatch(/WHISPER_MODEL.*send text instead/);
    expect(methods()).toEqual(['sendMessage', 'sendMessage']);
    expect(b.pty.write).not.toHaveBeenCalled();
    expect(tools.calls).toEqual([]);
  });

  it('refuses notes over 5 minutes or 20 MB, before or after asking Telegram for the file', async () => {
    const b = billion();
    sessions.set(b.id, b);
    expect(await handleUpdate(voiceUpdate(42, { duration: MAX_NOTE_SECONDS + 1 }), { env: ENV })).toBe('too-big');
    expect(await handleUpdate(voiceUpdate(42, { file_size: MAX_NOTE_BYTES + 1 }), { env: ENV })).toBe('too-big');
    expect(methods()).toEqual(['sendMessage', 'sendMessage']);
    fetchMock.mockResolvedValueOnce(reply({ file_path: 'voice/big.oga', file_size: MAX_NOTE_BYTES + 1 }));
    expect(await handleUpdate(voiceUpdate(42, { file_size: undefined }), { env: ENV })).toBe('too-big');
    expect(methods().slice(2)).toEqual(['getFile', 'sendMessage']);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).text).toMatch(/up to 5 minutes and 20 MB/);
    expect(tools.calls).toEqual([]);
    expect(b.pty.write).not.toHaveBeenCalled();
  });

  it('keeps the token out of the log and the reply when the download fails', async () => {
    const b = billion();
    sessions.set(b.id, b);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith('/getFile')) return reply({ file_path: 'voice/x.oga', file_size: 10 });
      if (url.includes('/file/')) throw new Error(`fetch failed: ${url}`);
      return reply(true);
    });
    expect(await handleUpdate(voiceUpdate(42), { env: ENV })).toBe('failed');
    const logged = errors.mock.calls.flat().join(' ');
    expect(logged).toContain('<token>');
    expect(logged).not.toContain(TOKEN);
    expect(JSON.stringify(fetchMock.mock.calls.at(-1)[1].body)).not.toContain(TOKEN);
    expect(b.pty.write).not.toHaveBeenCalled();
  });
});
