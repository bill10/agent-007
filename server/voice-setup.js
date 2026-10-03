// `agent007 install --voice`: whisper.cpp, ffmpeg and a ggml speech model, so
// "Talk to Billion" and Telegram voice notes work (docs/BILLION.md, "Voice").
// Nothing is installed or downloaded unless the person ran the command, and
// the download is confirmed first (--yes accepts it). Everything that touches
// the machine goes through ctx, so the tests stub brew, whisper and fetch and
// use a temp HOME.

import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { configDir, tilde } from './settings.js';

const REPO = 'ggerganov/whisper.cpp';
export const MODELS = [
  { file: 'ggml-base.en.bin', size: '~150 MB', about: 'English' },
  { file: 'ggml-small.bin', size: '~500 MB', about: 'multilingual, more accurate' },
];
const WHISPER_NAMES = ['whisper-cli', 'whisper-cpp', 'main'];
const modelUrl = (file) => `https://huggingface.co/${REPO}/resolve/main/${file}`;
const TEMPLATE = new URL('../.env.example', import.meta.url);

// 1 s of 16 kHz mono silence: enough to prove whisper loads the model.
function silentWav() {
  const data = Buffer.alloc(32000), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Sets one key (WHISPER_MODEL, ALLOWED_ORIGINS) in ~/.agent-007/.env and
// nothing else: replaces the live line, else the template's commented one,
// else appends. Owner-only when this makes the file. True when it changed it.
export function setEnvLine(file, key, value) {
  const line = `${key}=${value}`;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { text = readFileSync(TEMPLATE, 'utf8'); }
  const live = new RegExp(`^[ \\t]*${key}=.*$`, 'm'), commented = new RegExp(`^[ \\t]*#[ \\t]*${key}=.*$`, 'm');
  if (text.match(live)?.[0] === line) return false;
  text = live.test(text) ? text.replace(live, () => line)
    : commented.test(text) ? text.replace(commented, () => line)
    : `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  return true;
}

// The published size and sha256 of a model, or null.
async function published(ctx, file) {
  try {
    const res = await ctx.fetch(`https://huggingface.co/api/models/${REPO}/tree/main`);
    const hit = (await res.json()).find(f => f.path === file)?.lfs;
    return hit ? { size: hit.size, sha256: hit.oid } : null;
  } catch { return null; }
}

async function download(ctx, file, dest) {
  const part = `${dest}.part`;
  mkdirSync(join(dest, '..'), { recursive: true });
  try {
    const want = await published(ctx, file);
    const res = await ctx.fetch(modelUrl(file));
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = want?.size || Number(res.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    let got = 0, shown = -1;
    async function* count(src) {
      for await (const chunk of src) {
        hash.update(chunk); got += chunk.length;
        const pct = total ? Math.floor(got / total * 10) * 10 : -1;
        if (ctx.tty && pct !== shown) { shown = pct; ctx.write(`\r  ${pct < 0 ? `${Math.round(got / 1e6)} MB` : `${pct}%`}`); }
        yield chunk;
      }
    }
    await pipeline(Readable.fromWeb(res.body), count, createWriteStream(part));
    if (ctx.tty) ctx.write('\n');
    if (total && got !== total) throw new Error(`got ${got} of ${total} bytes`);
    if (want && hash.digest('hex') !== want.sha256) throw new Error('checksum does not match the one Hugging Face publishes');
    renameSync(part, dest);
    return want ? 'size and sha256 verified' : 'size checked (no checksum published to verify)';
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

// Step 1. Returns the whisper binary name found (or null).
async function tools(ctx) {
  const bin = () => (ctx.env.WHISPER_CPP_BIN || '').trim() || WHISPER_NAMES.find(n => ctx.has(n));
  const missing = () => [!bin() && 'whisper-cpp', !ctx.has('ffmpeg') && 'ffmpeg'].filter(Boolean);
  if (!missing().length) { ctx.log(`✓ whisper.cpp (${bin()}) and ffmpeg are installed; skipping.`); return bin(); }
  if (ctx.platform === 'darwin') {
    if (!ctx.has('brew')) {
      ctx.err('! Homebrew is not installed, so whisper.cpp and ffmpeg cannot be installed here. Install it from https://brew.sh, then run this again.');
      return bin() || null;
    }
    const need = missing();
    ctx.log(`Installing ${need.join(' and ')} with Homebrew: brew install ${need.join(' ')}`);
    const r = await ctx.run('brew', ['install', ...need], { timeout: 20 * 60_000 });
    if (r.code) ctx.err(`! brew install failed (${(r.stderr || '').trim().split('\n').pop()}). Run it yourself: brew install ${need.join(' ')}`);
  } else if (ctx.platform === 'win32') {
    ctx.log(`Windows: install whisper.cpp and ffmpeg yourself (nothing is installed for you).
  whisper.cpp: download a release zip from https://github.com/ggml-org/whisper.cpp/releases and put whisper-cli.exe on PATH
               (or set WHISPER_CPP_BIN to its full path in ${tilde(join(configDir(ctx.env), '.env'))})
  ffmpeg:      winget install ffmpeg`);
  } else {
    const need = missing();
    if (need.includes('whisper-cpp')) ctx.log(`Linux: whisper.cpp is not on PATH. Build it (nothing is built for you):
  git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
  cmake -B build && cmake --build build -j --config Release
  sudo cp build/bin/whisper-cli /usr/local/bin/   # or set WHISPER_CPP_BIN to it`);
    if (need.includes('ffmpeg')) ctx.log('ffmpeg: sudo apt install ffmpeg   (Debian/Ubuntu)   or   sudo dnf install ffmpeg   (Fedora; needs RPM Fusion)');
  }
  return bin() || null;
}

// Step 2: the model's path once it is on disk, or null.
async function model(ctx, dir) {
  const have = MODELS.find(m => existsSync(join(dir, m.file)));
  if (have) { ctx.log(`✓ Model ${tilde(join(dir, have.file))} is already there; skipping the download.`); return join(dir, have.file); }
  let pick = MODELS[0];
  if (!ctx.yes) {
    if (!ctx.tty) { ctx.err(`! Not downloading without a confirmation. Run this in a terminal, or add --yes to take ${pick.file} (${pick.size}).`); return null; }
    const a = (await ctx.ask(`Which speech model?\n${MODELS.map((m, i) => `  ${i + 1}) ${m.file} ${m.size}, ${m.about}`).join('\n')}\n[1]: `)).trim();
    pick = MODELS[Number(a) - 1] || MODELS[0];
    const ok = (await ctx.ask(`Download ${pick.file} (${pick.size}) from ${modelUrl(pick.file)} to ${tilde(dir)}? [Y/n] `)).trim().toLowerCase();
    if (ok.startsWith('n')) { ctx.log('Skipped the download.'); return null; }
  }
  ctx.log(`Downloading ${pick.file} (${pick.size}) from ${modelUrl(pick.file)}`);
  const dest = join(dir, pick.file);
  try {
    ctx.log(`✓ Downloaded to ${tilde(dest)}: ${await download(ctx, pick.file, dest)}.`);
    return dest;
  } catch (err) {
    ctx.err(`✗ Download failed: ${err.message}. Nothing was kept; run ${ctx.cmd('install --voice')} again.`);
    return null;
  }
}

// Step 4: say a sentence (macOS) or feed silence to the model, and print what whisper heard.
async function verify(ctx, bin, modelPath) {
  const dir = join(configDir(ctx.env), 'whisper');
  const wav = join(dir, 'verify.wav');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(wav, silentWav());
    let said = false;
    if (ctx.platform === 'darwin' && ctx.has('say')) said = !(await ctx.run('say', ['-o', wav, '--data-format=LEI16@16000', 'Testing one two three.'])).code;
    const r = await ctx.run(bin, ['-m', modelPath, '-f', wav, '-nt', '-np'], { timeout: 120_000 });
    if (r.code) throw new Error((r.stderr || '').trim().split('\n').pop() || `exit ${r.code}`);
    const text = r.stdout.replace(/\[[^\]]*\]/g, ' ').split('\n').map(l => l.trim()).filter(Boolean).join(' ');
    ctx.log(`✓ whisper.cpp ran the model${said ? ` and heard: "${text}"` : ' (on a silent test clip, so no words expected)'}.`);
    return true;
  } catch (err) {
    ctx.err(`✗ whisper.cpp could not run the model: ${err.message}. Check the model file is a complete ggml .bin (delete it and run ${ctx.cmd('install --voice')} again) and that ${bin} runs by itself.`);
    return false;
  } finally { rmSync(wav, { force: true }); }
}

// ctx: platform, env, run, fetch, has(name), tty, yes, ask(q), log, err, write, cmd.
// server: { running(), restart() } for step 5. Resolves 0 when voice works.
export async function setupVoice(ctx, server = {}) {
  ctx.log('Setting up voice (whisper.cpp, ffmpeg, a speech model).');
  const bin = await tools(ctx);
  const dir = join(configDir(ctx.env), 'whisper');
  const path = await model(ctx, dir);
  if (!path) {
    ctx.err(`! Voice is not set up yet: no model. Run ${ctx.cmd('install --voice')} again.`);
    return 1;
  }
  if (setEnvLine(join(configDir(ctx.env), '.env'), 'WHISPER_MODEL', path)) ctx.log(`✓ Set WHISPER_MODEL=${tilde(path)} in ${tilde(join(configDir(ctx.env), '.env'))}.`);
  else ctx.log('✓ WHISPER_MODEL is already set to it; skipping.');
  if (!bin) {
    ctx.err(`✗ Voice is not working yet: whisper.cpp is not installed (see above). The model and setting are in place; run ${ctx.cmd('install --voice')} again after installing it.`);
    return 1;
  }
  if (!(await verify(ctx, bin, path))) return 1;
  if (await server.running?.()) {
    const now = ctx.yes || (ctx.tty && !(await ctx.ask('Agent 007 is running; restart it now so voice takes effect? [Y/n] ')).trim().toLowerCase().startsWith('n'));
    if (now) await server.restart();
    else ctx.log(`Agent 007 is running; restart it so voice takes effect: ${ctx.cmd('restart')}`);
  }
  return 0;
}
