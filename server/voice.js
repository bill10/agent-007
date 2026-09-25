// Local audio for the Telegram bot (docs/BILLION.md, "Voice"): Billion's
// messages spoken with macOS `say` and encoded to OGG/Opus with ffmpeg, and the
// owner's voice notes transcribed with whisper.cpp. Everything runs on this
// machine; only the finished file, or the owner's note, crosses Telegram.
// Every tool is spawned with an args array, text goes in through a file, and
// temp files are removed whatever happens.

import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commandExists } from './command-path.js';

export const MAX_VOICE_CHARS = 900;             // about a minute of speech
export const MAX_NOTE_SECONDS = 5 * 60;
export const MAX_NOTE_BYTES = 20 * 1024 * 1024; // also getFile's own limit
const WHISPER_NAMES = ['whisper-cli', 'whisper-cpp', 'main'];

// TELEGRAM_VOICE: mirror (default), always or never.
export function voiceSetting(env = process.env) {
  const v = (env.TELEGRAM_VOICE || '').trim().toLowerCase();
  return v === 'always' || v === 'never' ? v : 'mirror';
}

const URL_RE = /https?:\/\/\S+/g;
// Code blocks, inline code, URLs, and path-like words (a slash in them, or ~/).
const TECHNICAL_RE = /```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|\S*[/\\]\S*|~\S*/g;

// Why this text should stay text, or null when it can be spoken.
// ponytail: a character ratio, not a parser; good enough to keep links, code
// and paths out of the owner's ears.
export function textOnlyReason(text) {
  if (text.length > MAX_VOICE_CHARS) return 'long';
  const solid = s => s.replace(/\s/g, '').length;
  const all = solid(text);
  if (all && solid(text.replace(TECHNICAL_RE, ' ')) < all / 2) return 'mostly links, code or paths';
  return null;
}

// Voice or text for one message to the owner. lastMode is the mode of the
// owner's last message ('voice' | 'text' | undefined).
export function chooseMode(text, { env = process.env, lastMode } = {}) {
  const setting = voiceSetting(env);
  if (setting === 'never') return { mode: 'text', reason: 'TELEGRAM_VOICE=never' };
  const reason = textOnlyReason(text);
  if (reason) return { mode: 'text', reason };
  if (setting === 'always' || lastMode === 'voice') return { mode: 'voice' };
  return { mode: 'text', reason: 'the owner last wrote text' };
}

// Runs one tool. Resolves with its output, rejects with a short reason.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { err += d; });
    child.on('error', e => reject(new Error(`${cmd}: ${e.message}`)));
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').pop() || ''}`)));
  });
}

async function inTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent007-voice-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Why Billion cannot speak here, or null.
export function speechUnavailable(env = process.env, platform = process.platform) {
  if (platform !== 'darwin') return 'speaking needs macOS `say`';
  if (!commandExists('say', env)) return '`say` is not on PATH';
  if (!commandExists('ffmpeg', env)) return 'ffmpeg is not installed (brew install ffmpeg)';
  return null;
}

// text → OGG/Opus bytes. URLs are said as "link"; the caption carries them.
export function synthesize(text) {
  return inTempDir(async dir => {
    const txt = join(dir, 'say.txt'), aiff = join(dir, 'say.aiff'), ogg = join(dir, 'say.ogg');
    await writeFile(txt, text.replace(URL_RE, 'link'));
    await run('say', ['-o', aiff, '-f', txt]);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-c:a', 'libopus', '-b:a', '32k', ogg]);
    return readFile(ogg);
  });
}

// { bin, model } when whisper.cpp is set up, else { missing: one line on how }.
export function whisperSetup(env = process.env) {
  const bin = (env.WHISPER_CPP_BIN || '').trim() || WHISPER_NAMES.find(n => commandExists(n, env));
  const model = (env.WHISPER_MODEL || '').trim();
  if (!bin || !commandExists(bin, env)) return { missing: 'Voice notes need whisper.cpp on the computer running Agent 007 (brew install whisper-cpp, then WHISPER_MODEL); send text instead.' };
  if (!model || !existsSync(model)) return { missing: 'Voice notes need a whisper.cpp model: set WHISPER_MODEL to a ggml model file (e.g. ggml-base.en.bin); send text instead.' };
  if (!commandExists('ffmpeg', env)) return { missing: 'Voice notes need ffmpeg (brew install ffmpeg) to convert them; send text instead.' };
  return { bin, model };
}

// OGG (or any audio ffmpeg reads) bytes → transcript text.
export function transcribe(audio, { bin, model }) {
  return inTempDir(async dir => {
    const input = join(dir, 'note.ogg'), wav = join(dir, 'note.wav');
    await writeFile(input, audio);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const out = await run(bin, ['-m', model, '-f', wav, '-nt', '-np']);
    return out.split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  });
}
