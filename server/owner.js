// Reaching the owner when they are away from the terminal: Billion's
// notify_owner tool, the "Waiting on you" tab it fills in the browser (where
// the owner can answer too), and a Telegram bot that carries both ways (docs/BILLION.md, "Telegram").
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
  chooseMode, voiceSetting, speechUnavailable, synthesize, sayVoice, whisperSetup, transcribe, MAX_NOTE_SECONDS, MAX_NOTE_BYTES,
} from './voice.js';

export const MAX_NOTIFY_CHARS = 3000;          // Telegram's own limit is 4096
export const NOTIFY_LIMIT = 5;                  // a burst of five, then...
export const NOTIFY_WINDOW_MS = 60 * 1000;      // ...five a minute at most
export const POLL_TIMEOUT_S = 30;
const MAX_BACKOFF_MS = 60 * 1000;
const WAITING_CAP = 50;
export const OWNER_PREFIX = '[Owner via Telegram]';
export const OWNER_VOICE_PREFIX = '[Owner via Telegram, voice]';
export const APP_PREFIX = '[Owner via app]';
export const MAX_CHOICES = 5;
export const MAX_CHOICE_CHARS = 40;
export const MAX_ANSWER_CHARS = 2000;
const CLOSED_KEPT = 30;   // answered and dismissed items kept; open ones always are

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
    body = await res.json().catch(() => ({ ok: false, error_code: res.status, description: `HTTP ${res.status}` }));
  } catch (err) {
    // reason: a short label for the poll loop's offline line.
    const reason = /ENOTFOUND|EAI_AGAIN/.test(err.cause?.code) ? 'DNS'
      : err.name === 'TimeoutError' || /timeout/i.test(err.message) ? 'timeout' : 'no network';
    throw Object.assign(new Error(redact(err.cause?.message || err.message, env)), { reason });
  }
  if (!body?.ok) {
    const status = body?.error_code;
    throw Object.assign(new Error(redact(body?.description || 'Telegram said no', env)), { status, reason: status ? `HTTP ${status}` : 'Telegram said no' });
  }
  return body.result;
}

// extra: more sendMessage fields (reply_markup). Returns { ok, messageId } or { error }.
export async function sendTelegram(text, { env = process.env, extra } = {}) {
  const { token, chatId } = telegramSettings(env);
  if (!token || !chatId) return { error: 'Telegram is not configured' };
  try {
    const sent = await call('sendMessage', { chat_id: chatId, text, ...extra }, { env });
    return { ok: true, messageId: sent?.message_id };
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
export async function sendVoice(text, { env = process.env, extra } = {}) {
  const { chatId } = telegramSettings(env);
  try {
    const ogg = await synthesize(text, env);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', text);   // under Telegram's 1024: voice is for texts of 900 or fewer
    form.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'billion.ogg');
    if (extra?.reply_markup) form.append('reply_markup', JSON.stringify(extra.reply_markup));
    const sent = await call('sendVoice', form, { env });
    return { ok: true, messageId: sent?.message_id, voice: true };
  } catch (err) {
    return { error: redact(err.message, env) };
  }
}

let voiceOffLogged = false;

// A message to the owner, as voice or text by TELEGRAM_VOICE (docs/BILLION.md, "Voice").
export async function sendToOwner(text, { env = process.env, platform = process.platform, extra } = {}) {
  if (chooseMode(text, { env, lastMode: lastOwnerMode() }).mode === 'voice') {
    const off = speechUnavailable(env, platform);
    const result = off ? { error: off } : await sendVoice(text, { env, extra });
    if (!result.error) return result;
    if (!voiceOffLogged) {
      voiceOffLogged = true;
      console.log(`  Telegram: sending text, not voice: ${result.error}`);
    }
  }
  return sendTelegram(text, { env, extra });
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
//
// An item: { id, n, text, at, choices?, recommended?, status, answer?,
// answeredAt?, answeredVia?, tgMessageId?, tgVoice? }. n is the short number
// the owner sees (Q3). status is open, answered or dismissed. Items written
// before v0.10 have neither n nor status: they read as open, numbered in order.

const waitingPath = () => join(CONFIG_DIR, 'waiting.json');

export function waitingItems() {
  let items;
  try { items = JSON.parse(readFileSync(waitingPath(), 'utf8')); } catch { return []; }
  if (!Array.isArray(items)) return [];
  return items.map((item, i) => ({ ...item, n: item.n ?? i + 1, status: item.status || 'open' }));
}

function saveWaiting(items) {
  // The newest open questions, and of the rest the newest few.
  let open = items.filter(item => item.status === 'open').length - WAITING_CAP;
  let closed = items.length - (open + WAITING_CAP) - CLOSED_KEPT;
  const kept = items.filter(item => (item.status === 'open' ? open-- <= 0 : closed-- <= 0));
  const tmp = `${waitingPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept, null, 2));
  renameSync(tmp, waitingPath());
}

export const waitingPayload = () => ({ type: 'waiting-list', items: waitingItems().filter(item => item.status !== 'dismissed') });

// choices: 2-5 short distinct strings, or absent; recommended: one of them.
export function checkChoices(choices, recommended) {
  if (choices === undefined || choices === null) {
    return recommended === undefined || recommended === null ? null : 'recommended needs choices to pick from.';
  }
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > MAX_CHOICES) return `choices must be a list of 2 to ${MAX_CHOICES} options.`;
  if (choices.some(c => typeof c !== 'string' || !c.trim() || c.trim().length > MAX_CHOICE_CHARS)) return `Each choice must be text of 1 to ${MAX_CHOICE_CHARS} characters.`;
  if (new Set(choices.map(c => c.trim())).size !== choices.length) return 'The choices must all differ.';
  if (recommended !== undefined && recommended !== null && !(typeof recommended === 'string' && choices.map(c => c.trim()).includes(recommended.trim()))) return 'recommended must be one of the choices.';
  return null;
}

export function addWaiting(text, broadcast, now = Date.now(), { choices, recommended } = {}) {
  const items = waitingItems();
  const item = { id: randomUUID(), n: Math.max(0, ...items.map(i => i.n)) + 1, text, at: new Date(now).toISOString(), status: 'open' };
  if (choices) item.choices = choices.map(c => c.trim());
  if (recommended) item.recommended = recommended.trim();
  saveWaiting([...items, item]);
  broadcast?.(waitingPayload());
  return item;
}

function updateWaiting(id, change) {
  const items = waitingItems();
  const item = items.find(i => i.id === id);
  if (!item) return null;
  Object.assign(item, change);
  saveWaiting(items);
  return item;
}

export function dismissWaiting(id, broadcast) {
  if (!waitingItems().some(item => item.id === id && item.status !== 'dismissed')) return false;
  updateWaiting(id, { status: 'dismissed' });
  broadcast?.(waitingPayload());
  return true;
}

// The line Billion reads: who answered, which question, the answer, and the
// start of the question so it knows what "yes" is to.
export function answerLine(prefix, item, answer) {
  const flat = item.text.replace(/\s+/g, ' ').trim();
  const context = flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat;
  return `${prefix} Q${item.n}: ${answer} (re: "${context}")`;
}

// What the owner's Telegram shows for a question.
const questionText = (item) => `Billion (Q${item.n}): ${item.text}`;

// An answer from the app or Telegram (via 'app' or 'telegram'): into Billion's
// terminal, then the item is answered everywhere. { ok, item } or { error };
// on an error the item stays open.
export async function answerWaiting(id, answer, via, { broadcast, env = process.env } = {}) {
  const body = typeof answer === 'string' ? answer.replace(/\s+/g, ' ').trim() : '';
  if (!body) return { error: 'The answer is empty.' };
  if (body.length > MAX_ANSWER_CHARS) return { error: `Keep the answer under ${MAX_ANSWER_CHARS} characters.` };
  const item = waitingItems().find(i => i.id === id);
  if (!item || item.status === 'dismissed') return { error: 'That question is gone.' };
  if (item.status === 'answered') return { error: `Q${item.n} was answered already: ${item.answer}` };
  const billion = liveBillion();
  if (!billion) return { error: 'Billion is not running' };
  if (!sendText(billion, answerLine(via === 'app' ? APP_PREFIX : OWNER_PREFIX, item, body))) {
    return { error: 'Billion has too much waiting for it; try again in a while.' };
  }
  const done = updateWaiting(id, { status: 'answered', answer: body, answeredAt: new Date().toISOString(), answeredVia: via });
  broadcast?.(waitingPayload());
  if (done.tgMessageId) await showAnswerOnPhone(done, env);
  return { ok: true, item: done };
}

// The phone's copy of an answered question shows the answer, and loses its buttons.
async function showAnswerOnPhone(item, env) {
  const { chatId } = telegramSettings(env);
  const shown = `${questionText(item)}\n\nAnswered${item.answeredVia === 'app' ? ' in app' : ''}: ${item.answer}`;
  const edit = item.tgVoice
    ? call('editMessageCaption', { chat_id: chatId, message_id: item.tgMessageId, caption: shown.slice(0, 1024) }, { env })
    : call('editMessageText', { chat_id: chatId, message_id: item.tgMessageId, text: shown.slice(0, 4096) }, { env });
  await edit.catch(err => console.error('Telegram: could not mark a question answered:', redact(err.message, env)));
}

// --- notify_owner ---

let sent = [];   // times of recent notify_owner calls

export async function notifyOwner(text, { choices, recommended, broadcast, env = process.env, now = Date.now(), platform = process.platform } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { error: 'The message is empty.' };
  if (body.length > MAX_NOTIFY_CHARS) return { error: `The message is ${body.length} characters; keep it under ${MAX_NOTIFY_CHARS}.` };
  const bad = checkChoices(choices, recommended);
  if (bad) return { error: bad };
  sent = sent.filter(t => now - t < NOTIFY_WINDOW_MS);
  if (sent.length >= NOTIFY_LIMIT) {
    return { error: `Not sent: you have notified the owner ${NOTIFY_LIMIT} times in the last minute. Put the rest in one message later, or under Waiting on you in STATE.md.` };
  }
  sent.push(now);
  let item;
  try { item = addWaiting(body, broadcast, now, { choices, recommended }); } catch (err) {
    console.error('Could not save the Waiting on you list:', err.message);
  }
  const n = item ? ` as Q${item.n}` : '';
  const { token, chatId } = telegramSettings(env);
  if (!token || !chatId) {
    return { pinned: true, n: item?.n, error: `Pinned under "Waiting on you" in the owner's browser${n}, but not sent to their phone: Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID). Say it in your terminal as well.` };
  }
  // A button per choice; callback_data is "<id>:<index>", 38 bytes of Telegram's 64.
  const keyboard = item?.choices && {
    reply_markup: { inline_keyboard: item.choices.map((c, i) => [{ text: c === item.recommended ? `${c} (recommended)` : c, callback_data: `${item.id}:${i}` }]) },
  };
  const result = await sendToOwner(item ? questionText(item) : `Billion: ${body}`, { env, platform, extra: keyboard || undefined });
  if (result.error) return { pinned: true, n: item?.n, error: `Pinned under "Waiting on you" in the owner's browser${n}, but the Telegram send failed: ${result.error}` };
  // Kept so a reply to this message, or a tap on its buttons, finds the question.
  if (item && result.messageId) {
    let saved;
    try { saved = updateWaiting(item.id, { tgMessageId: result.messageId, ...(result.voice ? { tgVoice: true } : {}) }); } catch {}
    // Answered in the app while the send was on its way.
    if (saved?.status === 'answered') await showAnswerOnPhone(saved, env);
  }
  return { ok: true, n: item?.n };
}

// --- Replies: long-polling getUpdates ---

const discovered = new Set();   // chat ids already shown, so a stranger's first message cannot hide the owner's

// One update. Returns what happened, for the tests and the log.
export async function handleUpdate(update, { broadcast, env = process.env } = {}) {
  if (update?.callback_query) return handleButton(update.callback_query, { broadcast, env });
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
  // A typed reply to one of Billion's questions answers that question.
  const repliedTo = typed && msg.reply_to_message?.message_id;
  const question = repliedTo && waitingItems().find(i => i.tgMessageId === repliedTo && i.status === 'open');
  if (question) {
    const result = await answerWaiting(question.id, typed, 'telegram', { broadcast, env });
    if (result.error) {
      await sendTelegram(result.error, { env });
      return result.error === 'Billion is not running' ? 'not-running' : 'full';
    }
    return 'answered';
  }
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

// A tap on a question's button: "<item id>:<choice index>".
async function handleButton(query, { broadcast, env }) {
  const { chatId } = telegramSettings(env);
  // The owner's chat only, and nothing said to anyone else.
  if (!chatId || String(query.message?.chat?.id) !== chatId) return 'ignored';
  const [id, index] = String(query.data || '').split(':');
  const item = waitingItems().find(i => i.id === id);
  const choice = item?.choices?.[Number(index)];
  const ack = (text) => call('answerCallbackQuery', { callback_query_id: query.id, text }, { env })
    .catch(err => console.error('Telegram: could not answer a button:', redact(err.message, env)));
  if (!choice || item.status !== 'open') {
    await ack(item?.status === 'answered' ? `Already answered: ${item.answer}` : 'That question is gone.');
    return 'stale';
  }
  const result = await answerWaiting(id, choice, 'telegram', { broadcast, env });
  await ack(result.error || `Sent: ${choice}`);
  if (result.error) return result.error === 'Billion is not running' ? 'not-running' : 'full';
  return 'answered';
}

// One getUpdates round. Returns the next offset.
export async function pollOnce(offset, { broadcast, env = process.env, signal } = {}) {
  const params = { timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] };
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

// Failures that retrying will not fix, and what the owner should do about them.
const POLL_HINTS = {
  401: 'the bot token is wrong or revoked',
  409: 'another process is polling this bot',
};
const OFFLINE_AFTER_MS = 60 * 1000;
const OFFLINE_AFTER_FAILURES = 3;

const since = ms => ms < 120e3 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60e3)}m`;

const pause = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function startTelegram({ broadcast, env = process.env } = {}) {
  const { token, chatId } = telegramSettings(env);
  if (!token || stopper) return false;
  if (!chatId) console.log('  Telegram: send any message to your bot, then set TELEGRAM_CHAT_ID=<id> (the id is shown here when it arrives)');
  else console.log('  Telegram: on');
  if (voiceSetting(env) !== 'never' && !speechUnavailable(env)) {
    sayVoice(env).then(v => console.log(`  Telegram: speaking with ${v ? `the ${v} voice` : "say's default voice"}`));
  }
  const controller = new AbortController();
  stopper = controller;
  (async () => {
    let offset = 0;
    let backoff = 1000;
    // Sleep, wake and network changes fail a poll or two; log only going
    // offline and coming back, not every retry.
    let failures = 0, failingSince = 0, offline = false;
    while (!controller.signal.aborted) {
      try {
        offset = await pollOnce(offset, { broadcast, env, signal: controller.signal });
        if (offline) console.log(`Telegram: back online after ${since(Date.now() - failingSince)}`);
        failures = 0;
        offline = false;
        backoff = 1000;
      } catch (err) {
        if (controller.signal.aborted) break;
        if (!failures++) failingSince = Date.now();
        const hint = POLL_HINTS[err.status];
        // A hint logs even mid-outage: a token revoked while offline still needs saying.
        if (hint ? offline !== hint : !offline && (failures >= OFFLINE_AFTER_FAILURES || Date.now() - failingSince > OFFLINE_AFTER_MS)) {
          offline = hint || true;
          console.error(hint
            ? `Telegram: getUpdates failed (${err.message}): ${hint}; retrying quietly`
            : `Telegram: offline (${err.reason || 'no network'}), retrying quietly`);
        }
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
