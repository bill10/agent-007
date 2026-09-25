// Reaching the owner when they are away from the terminal: Billion's
// notify_owner tool, the "Waiting on you" list it pins in the browser, and a
// Telegram bot that carries both ways (docs/BILLION.md, "Telegram").
//
// Telegram is optional: with TELEGRAM_BOT_TOKEN unset nothing here talks to
// the network and the list still works. Plain fetch against the Bot API, no
// library. The one gate on owner input is the chat id: a message from any
// other chat is dropped without a word, since anyone can find and message a
// bot. The token is a password to the bot, so it is never logged and never
// sent to a browser: every error that leaves this module goes through redact().

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { CONFIG_DIR } from './state.js';
import { liveBillion } from './billion.js';
import { sendText } from './messages.js';
import {
  chooseMode, speechUnavailable, synthesize, whisperSetup, transcribe, MAX_NOTE_SECONDS, MAX_NOTE_BYTES,
} from './voice.js';

export const MAX_NOTIFY_CHARS = 3000;          // Telegram's own limit is 4096
export const NOTIFY_LIMIT = 5;                  // a burst of five, then...
export const NOTIFY_WINDOW_MS = 60 * 1000;      // ...five a minute at most
export const POLL_TIMEOUT_S = 30;
const MAX_BACKOFF_MS = 60 * 1000;
const WAITING_CAP = 50;
export const OWNER_PREFIX = '[Owner via Telegram]';
export const OWNER_VOICE_PREFIX = '[Owner via Telegram, voice]';

export function telegramSettings(env = process.env) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  return { token, chatId };
}

export function redact(text, env = process.env) {
  const { token } = telegramSettings(env);
  let out = String(text);
  // Raw, and as a URL would carry it (the colon escaped).
  for (const form of token ? [token, encodeURIComponent(token)] : []) out = out.split(form).join('<token>');
  return out;
}

// One Bot API call. Returns the result, or throws an Error whose message is
// already redacted. params is JSON, or FormData for an upload.
async function call(method, params, { env = process.env, signal } = {}) {
  const { token } = telegramSettings(env);
  const form = params instanceof FormData;
  let body;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      ...(form ? { body: params } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }),
      signal,
    });
    body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  } catch (err) {
    throw new Error(redact(err.cause?.message || err.message, env));
  }
  if (!body?.ok) throw new Error(redact(body?.description || 'Telegram said no', env));
  return body.result;
}

export async function sendTelegram(text, { env = process.env } = {}) {
  const { token, chatId } = telegramSettings(env);
  if (!token || !chatId) return { error: 'Telegram is not configured' };
  try {
    await call('sendMessage', { chat_id: chatId, text }, { env });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// --- Voice (server/voice.js does the audio) ---

// The mode of the owner's last message, kept next to waiting.json so mirror
// survives a restart.
const voiceStatePath = () => join(CONFIG_DIR, 'telegram-voice.json');

export function lastOwnerMode() {
  try { return JSON.parse(readFileSync(voiceStatePath(), 'utf8')).lastMode; } catch { return undefined; }
}

function saveOwnerMode(mode) {
  if (lastOwnerMode() === mode) return;
  try {
    writeFileSync(`${voiceStatePath()}.tmp`, JSON.stringify({ lastMode: mode }));
    renameSync(`${voiceStatePath()}.tmp`, voiceStatePath());
  } catch (err) {
    console.error('Telegram: could not save the last message mode:', err.message);
  }
}

// text spoken, with text as the caption so links stay tappable. Returns
// { ok } or { error }; the caller sends text instead on an error.
export async function sendVoice(text, { env = process.env } = {}) {
  const { chatId } = telegramSettings(env);
  try {
    const ogg = await synthesize(text);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', text);   // under Telegram's 1024: voice is for texts of 900 or fewer
    form.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'billion.ogg');
    await call('sendVoice', form, { env });
    return { ok: true };
  } catch (err) {
    return { error: redact(err.message, env) };
  }
}

let voiceOffLogged = false;

// A message to the owner, as voice or text by TELEGRAM_VOICE (docs/BILLION.md, "Voice").
export async function sendToOwner(text, { env = process.env, platform = process.platform } = {}) {
  if (chooseMode(text, { env, lastMode: lastOwnerMode() }).mode === 'voice') {
    const off = speechUnavailable(env, platform);
    const result = off ? { error: off } : await sendVoice(text, { env });
    if (!result.error) return result;
    if (!voiceOffLogged) {
      voiceOffLogged = true;
      console.log(`  Telegram: sending text, not voice: ${result.error}`);
    }
  }
  return sendTelegram(text, { env });
}

// A voice note's bytes, or throws a redacted Error.
async function downloadFile(fileId, env) {
  const file = await call('getFile', { file_id: fileId }, { env });
  if (file?.file_size > MAX_NOTE_BYTES) throw new Error('too big');
  const { token } = telegramSettings(env);
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60 * 1000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_NOTE_BYTES) throw new Error('too big');
    return bytes;
  } catch (err) {
    throw new Error(redact(err.cause?.message || err.message, env));
  }
}

// The owner's voice note → its transcript, or a reply for the owner.
async function transcribeNote(note, env) {
  const setup = whisperSetup(env);
  if (setup.missing) return { reply: setup.missing, result: 'no-whisper' };
  const limit = `Voice notes can be up to ${MAX_NOTE_SECONDS / 60} minutes and ${MAX_NOTE_BYTES / 1024 / 1024} MB; send a shorter one or text.`;
  if (note.duration > MAX_NOTE_SECONDS || note.file_size > MAX_NOTE_BYTES) return { reply: limit, result: 'too-big' };
  try {
    const transcript = await transcribe(await downloadFile(note.file_id, env), setup);
    if (!transcript) return { reply: 'I could not make out any words in that voice note; send it again or as text.', result: 'empty' };
    return { transcript };
  } catch (err) {
    if (err.message === 'too big') return { reply: limit, result: 'too-big' };
    console.error('Telegram: could not transcribe a voice note:', redact(err.message, env));
    return { reply: 'I could not transcribe that voice note; send it as text instead.', result: 'failed' };
  }
}

// --- The "Waiting on you" list, in the config dir so it survives restarts ---

const waitingPath = () => join(CONFIG_DIR, 'waiting.json');

export function waitingItems() {
  try {
    const items = JSON.parse(readFileSync(waitingPath(), 'utf8'));
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

function saveWaiting(items) {
  const tmp = `${waitingPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2));
  renameSync(tmp, waitingPath());
}

export const waitingPayload = () => ({ type: 'waiting-list', items: waitingItems() });

export function addWaiting(text, broadcast, now = Date.now()) {
  const items = [...waitingItems(), { id: randomUUID(), text, at: new Date(now).toISOString() }].slice(-WAITING_CAP);
  saveWaiting(items);
  broadcast?.(waitingPayload());
}

export function dismissWaiting(id, broadcast) {
  const items = waitingItems();
  const kept = items.filter(item => item.id !== id);
  if (kept.length === items.length) return false;
  saveWaiting(kept);
  broadcast?.(waitingPayload());
  return true;
}

// --- notify_owner ---

let sent = [];   // times of recent notify_owner calls

export async function notifyOwner(text, { broadcast, env = process.env, now = Date.now(), platform = process.platform } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { error: 'The message is empty.' };
  if (body.length > MAX_NOTIFY_CHARS) return { error: `The message is ${body.length} characters; keep it under ${MAX_NOTIFY_CHARS}.` };
  sent = sent.filter(t => now - t < NOTIFY_WINDOW_MS);
  if (sent.length >= NOTIFY_LIMIT) {
    return { error: `Not sent: you have notified the owner ${NOTIFY_LIMIT} times in the last minute. Put the rest in one message later, or under Waiting on you in STATE.md.` };
  }
  sent.push(now);
  try { addWaiting(body, broadcast, now); } catch (err) {
    console.error('Could not save the Waiting on you list:', err.message);
  }
  const { token, chatId } = telegramSettings(env);
  if (!token || !chatId) {
    return { pinned: true, error: 'Pinned under "Waiting on you" in the owner\'s browser, but not sent to their phone: Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID). Say it in your terminal as well.' };
  }
  const result = await sendToOwner(`Billion: ${body}`, { env, platform });
  if (result.error) return { pinned: true, error: `Pinned under "Waiting on you" in the owner's browser, but the Telegram send failed: ${result.error}` };
  return { ok: true };
}

// --- Replies: long-polling getUpdates ---

const discovered = new Set();   // chat ids already shown, so a stranger's first message cannot hide the owner's

// One update. Returns what happened, for the tests and the log.
export async function handleUpdate(update, { broadcast, env = process.env } = {}) {
  const msg = update?.message;
  const chat = msg?.chat?.id;
  if (chat === undefined || chat === null) return 'ignored';
  const { chatId } = telegramSettings(env);
  if (!chatId) {
    // Setting up: say whose chat this was, and use nothing else from it. Every
    // new chat is shown, not only the first.
    if (!discovered.has(chat) && discovered.size < 20) {
      discovered.add(chat);
      const line = `Telegram: a message came from chat ${chat}. If that was you, set TELEGRAM_CHAT_ID=${chat} in ~/.agent-007/.env and restart.`;
      console.log(`  ${line}`);
      broadcast?.({ type: 'notification', level: 'info', message: line });
    }
    return 'discovery';
  }
  if (String(chat) !== chatId) return 'ignored';
  const note = (msg.voice || msg.audio)?.file_id ? (msg.voice || msg.audio) : null;
  const typed = typeof msg.text === 'string' && msg.text.trim() ? msg.text : null;
  if (!note && !typed) return 'ignored';
  saveOwnerMode(note ? 'voice' : 'text');
  const billion = liveBillion();
  if (!billion) {
    await sendTelegram('Billion is not running', { env });
    return 'not-running';
  }
  let line = `${OWNER_PREFIX} ${typed}`;
  if (note) {
    const heard = await transcribeNote(note, env);
    if (heard.reply) {
      await sendTelegram(heard.reply, { env });
      return heard.result;
    }
    const caption = typeof msg.caption === 'string' && msg.caption.trim() ? ` (caption: ${msg.caption.trim()})` : '';
    line = `${OWNER_VOICE_PREFIX} ${heard.transcript}${caption}`;
  }
  if (!sendText(billion, line)) {
    await sendTelegram('Billion has too much waiting for it; try again in a while.', { env });
    return 'full';
  }
  return 'delivered';
}

// One getUpdates round. Returns the next offset.
export async function pollOnce(offset, { broadcast, env = process.env, signal } = {}) {
  const params = { timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] };
  if (offset) params.offset = offset;
  // Longer than Telegram's own wait, so a dead connection still gives up.
  const deadline = AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1000);
  const updates = await call('getUpdates', params, { env, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  let next = offset;
  for (const update of updates || []) {
    // Past it before handling, so an update that throws is not fetched again for ever.
    next = Math.max(next || 0, update.update_id + 1);
    try { await handleUpdate(update, { broadcast, env }); } catch (err) {
      console.error('Telegram: could not handle a message:', redact(err.message, env));
    }
  }
  return next;
}

let stopper = null;

const pause = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function startTelegram({ broadcast, env = process.env } = {}) {
  const { token, chatId } = telegramSettings(env);
  if (!token || stopper) return false;
  if (!chatId) console.log('  Telegram: send any message to your bot, then set TELEGRAM_CHAT_ID=<id> (the id is shown here when it arrives)');
  else console.log('  Telegram: on');
  const controller = new AbortController();
  stopper = controller;
  (async () => {
    let offset = 0;
    let backoff = 1000;
    while (!controller.signal.aborted) {
      try {
        offset = await pollOnce(offset, { broadcast, env, signal: controller.signal });
        backoff = 1000;
      } catch (err) {
        if (controller.signal.aborted) break;
        console.error(`Telegram: getUpdates failed (${err.message}); retrying in ${backoff / 1000}s`);
        await pause(backoff, controller.signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  })();
  return true;
}

export function stopTelegram() {
  stopper?.abort();
  stopper = null;
}
