// Reaching the owner when they are away from the terminal: Billion's
// notify_owner tool (questions) and tell_owner (replies that need no answer), the "Billion" chat tab they fill in the browser (where
// the owner answers and talks to Billion too), and a Telegram bot that carries both ways (docs/BILLION.md, "Telegram").
//
// Telegram is optional: with TELEGRAM_BOT_TOKEN unset nothing here talks to
// the network and the list still works. Plain fetch against the Bot API, no
// library. The one gate on owner input is the chat id: a message from any
// other chat is dropped without a word, since anyone can find and message a
// bot. The token is a password to the bot, so it is never logged and never
// sent to a browser: every error that leaves this module goes through redact().

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, sep, basename } from 'path';
import { randomUUID } from 'crypto';
import { CONFIG_DIR, config } from './state.js';
import { liveBillion } from './billion.js';
import { sendText } from './messages.js';
import { roundSettings, roundState, saveRoundState, lastRound, comingRound, roundPayload, byPriority, appLink } from './rounds.js';
import { billionReplied, publishStatus, MAX_STEPS } from './billion-status.js';
import { uploadName, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENT_TOTAL_BYTES } from './jobs.js';
import {
  chooseMode, voiceSetting, speechUnavailable, synthesize, sayVoice, sayRate, whisperSetup, transcribe, MAX_NOTE_SECONDS, MAX_NOTE_BYTES,
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
// sendText's mark on the owner's own words: they reach Billion mid-introduction.
const OWNER = { owner: true };
export const MAX_CHOICES = 5;
export const MAX_CHOICE_CHARS = 40;
// No practical limit on what the owner types or pastes in the Billion tab: these
// are a ceiling against a runaway paste, far above anything typed. Telegram's
// own 4096 (message) and 1024 (caption) are met by splitting (splitForTelegram).
export const MAX_ANSWER_CHARS = 200000;
export const MAX_OWNER_CHARS = 200000;
export const TG_MESSAGE_CHARS = 4096;
export const TG_CAPTION_CHARS = 1024;
export const CHAT_CAP = 500;
const CLOSED_KEPT = 30;   // answered and dismissed items kept; open ones always are

// The chat id is TELEGRAM_CHAT_ID when set, else the chat the owner picked
// with "Use this chat" in the Billion tab (telegram-chat.json), read on every
// call so picking one applies without a restart.
export function telegramSettings(env = process.env) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim() || savedChatId();
  return { token, chatId };
}

const tgChatPath = () => join(CONFIG_DIR, 'telegram-chat.json');

const savedChat = () => { try { return JSON.parse(readFileSync(tgChatPath(), 'utf8')) || {}; } catch { return {}; } };
export const savedChatId = () => String(savedChat().chatId ?? '').trim();

// Who spoke, in a group chat: every member counts as the owner, and this says
// which one. '' in a private chat, so nothing changes there. It lands in
// Billion's prompt inside "(...)", so it is one short line with no brackets.
const GROUP_TYPES = ['group', 'supergroup'];
export const MAX_NAME_CHARS = 40;

export function cleanName(raw) {
  const flat = String(raw ?? '').replace(/[\p{C}\[\]()]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, MAX_NAME_CHARS).join('').trim();
}

const personName = (from) => cleanName([from?.first_name, from?.last_name].filter(Boolean).join(' '))
  || (from?.username ? cleanName(`@${from.username}`) : '');

export function senderName(chat, from) {
  return GROUP_TYPES.includes(chat?.type) ? personName(from) : '';
}

export const telegramPrefix = (name, voice = false) => (name
  ? `[Owner via Telegram (${name})${voice ? ', voice' : ''}]`
  : voice ? OWNER_VOICE_PREFIX : OWNER_PREFIX);

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

// Whether the bot token answers, for `agent-007 doctor`: { username }, or
// { rejected } when Telegram refuses the token (401/404), or null when it could
// not be reached or said anything else. Nothing from the error is passed on.
export async function telegramGetMe(env = process.env) {
  try {
    return { username: (await call('getMe', {}, { env, signal: AbortSignal.timeout(5000) }))?.username };
  } catch (err) {
    return err.status === 401 || err.status === 404 ? { rejected: true } : null;
  }
}

// Consecutive pieces of at most `limit` characters (code points) that join back
// into `text`, cut at a newline, else a space, else mid-word, so nothing is lost.
export function splitForTelegram(text, limit = TG_MESSAGE_CHARS) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= limit) return [chars.join('')];
  const out = [];
  let at = 0;
  while (chars.length - at > limit) {
    const window = chars.slice(at, at + limit);
    let cut = window.lastIndexOf('\n') + 1;
    if (cut < limit / 2) cut = window.lastIndexOf(' ') + 1;
    if (cut < limit / 2) cut = limit;
    out.push(chars.slice(at, at + cut).join(''));
    at += cut;
  }
  out.push(chars.slice(at).join(''));
  return out;
}

// extra: more sendMessage fields (reply_markup). Text over Telegram's 4096 goes
// as consecutive messages, the buttons on the last. messageId is the one
// carrying the buttons. Returns { ok, messageId } or { error }.
export async function sendTelegram(text, { env = process.env, extra } = {}) {
  const { token, chatId } = telegramSettings(env);
  if (!token || !chatId) return { error: 'Telegram is not configured' };
  try {
    const parts = splitForTelegram(text);
    let sent;
    for (const [i, part] of parts.entries()) {
      sent = await call('sendMessage', { chat_id: chatId, text: part, ...(i === parts.length - 1 ? extra : {}) }, { env });
    }
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
    // Voice is for texts of 900 or fewer; any more than a caption holds follows as text.
    const [caption, ...rest] = splitForTelegram(text, TG_CAPTION_CHARS);
    form.append('caption', caption);
    form.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'billion.ogg');
    if (extra?.reply_markup && !rest.length) form.append('reply_markup', JSON.stringify(extra.reply_markup));
    const sent = await call('sendVoice', form, { env });
    if (rest.length) {
      const more = await sendTelegram(rest.join(''), { env, extra });
      if (more.error) throw new Error(more.error);
      return { ok: true, messageId: more.messageId };
    }
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
// answeredAt?, answeredVia?, answeredBy?, tgMessageId?, tgVoice?, urgency, project, type }. answeredBy
// is the group member who answered on Telegram (senderName). urgency is
// blocking, normal or low; items written before it read as normal. project is
// a board repo's folder name or "general", which older items read as. type is
// one of QUESTION_TYPES; an older item has it read off its text (a name off
// the list reads as other) the first time it is read, and saved. answeredVia is app,
// telegram or terminal (resolve_question). n is the short number the owner sees (Q3). status is open, answered or dismissed. Items written
// before v0.10 have neither n nor status: they read as open, numbered in order.
// With rounds on (see "Rounds" below) there are two more: queued (asked by
// Billion, not shown to the owner until a round releases it) and consolidated
// (left open when the next round came: kept as history, off the open list).
// round: the round that released it (rounds.js ids); pos, its place there;
// outside: asked outside a round (blocking or telegram: true); rank: Billion's
// order among its queued questions, 1 first.

const waitingPath = () => join(CONFIG_DIR, 'waiting.json');

export function waitingItems() {
  let items;
  try { items = JSON.parse(readFileSync(waitingPath(), 'utf8')); } catch { return []; }
  if (!Array.isArray(items)) return [];
  const untyped = items.some(item => !QUESTION_TYPES.includes(item.type));
  items = items.map((item, i) => ({ ...item, n: item.n ?? i + 1, status: item.status || 'open', urgency: item.urgency || 'normal', project: item.project || 'general', type: questionType(item.type, item.text) }));
  if (untyped) try { saveWaiting(items); } catch {}
  return items;
}

function saveWaiting(items) {
  // The newest open questions, the newest queued ones (a cap of their own, so
  // a long queue never pushes an open question out), and of the rest the newest few.
  const over = { open: 0, queued: 0 };
  for (const status of ['open', 'queued']) over[status] = items.filter(item => item.status === status).length - WAITING_CAP;
  let closed = items.filter(item => !(item.status in over)).length - CLOSED_KEPT;
  const kept = items.filter(item => (item.status in over ? over[item.status]-- <= 0 : closed-- <= 0));
  const tmp = `${waitingPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept, null, 2));
  renameSync(tmp, waitingPath());
}

// A queued question is Billion's until a round releases it: never sent to a browser.
export const waitingPayload = () => ({ type: 'waiting-list', items: waitingItems().filter(item => item.status !== 'dismissed' && item.status !== 'queued') });

// --- The Billion chat: the thread the Billion tab shows, beside waiting.json ---
//
// A message: { id, at, from: 'owner' | 'billion', text, via?, name?, voice?, re?, q?, files? }.
// via is app or telegram (the owner's side); name, which group member wrote it. files: what the owner attached
// in the tab, [{ name, size, type }] (see "The chat's attachments"). re is the question number a typed
// answer went to. q is a notify_owner question, copied here with its state so
// the thread keeps it after the Waiting list lets it go: { id, n, urgency,
// project, type, choices?, recommended?, status, answer?, answeredVia?,
// answeredAt?, answeredBy? }. The newest CHAT_CAP
// are kept. Everything in it reaches a browser, so the bot token is redacted.

const chatPath = () => join(CONFIG_DIR, 'chat.json');

// --- The chat's attachments ---
//
// Files the owner pastes, drops or picks in the Billion tab arrive inline on
// chat-send as base64, like a card's attachments and under the same limits.
// They live in chat-files/<message id>/<name> under the config dir, owner-only
// on disk, and Billion reads them by the absolute paths its turn carries. The
// message keeps { name, size, type } per file; its id is the folder.
const chatFilesDir = () => resolve(CONFIG_DIR, 'chat-files');
const insideChatFiles = (path) => resolve(path).startsWith(chatFilesDir() + sep);

// The files a chat-send carried, decoded and checked, nothing written yet.
// { files: [{ name, type, buf }] } or { error }.
export function planChatFiles(list) {
  if (list === undefined || list === null) return { files: [] };
  if (!Array.isArray(list)) return { error: 'The attachments are not a list.' };
  if (list.length > MAX_ATTACHMENTS) return { error: `At most ${MAX_ATTACHMENTS} files per message` };
  const files = [];
  let total = 0;
  for (const item of list) {
    const checked = uploadName(item?.name, files);
    if (checked.error) return checked;
    if (typeof item.data !== 'string') return { error: `${checked.name} has no contents` };
    const buf = Buffer.from(item.data, 'base64');
    if (buf.length > MAX_ATTACHMENT_BYTES) return { error: `${checked.name} is too large (max 10MB)` };
    total += buf.length;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) return { error: 'Attachments add up to more than 50MB' };
    // Only says which bubble to draw (thumbnail or chip); the route serves by extension.
    const type = typeof item.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(item.type) ? item.type.slice(0, 100) : '';
    files.push({ name: checked.name, type, buf });
  }
  return { files };
}

// Written under the message's id: { paths, records } or { error }, nothing left behind.
function saveChatFiles(id, files) {
  const dir = join(chatFilesDir(), id);
  if (!insideChatFiles(dir)) return { error: 'Bad message id' };
  try {
    mkdirSync(chatFilesDir(), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    for (const f of files) writeFileSync(join(dir, f.name), f.buf, { mode: 0o600 });
  } catch (err) {
    removeChatFiles(id);
    return { error: `Could not save the attachments: ${err.message}` };
  }
  return {
    paths: files.map(f => join(dir, f.name)),
    records: files.map(f => ({ name: f.name, size: f.buf.length, type: f.type })),
  };
}

function removeChatFiles(id) {
  const dir = join(chatFilesDir(), String(id));
  if (insideChatFiles(dir)) rmSync(dir, { recursive: true, force: true });
}

// For the download route: the file's path, or null unless that message has it.
export function chatFilePath(id, name) {
  const message = chatMessages().find(m => m.id === id);
  if (!message || !(message.files || []).some(f => f.name === name)) return null;
  const path = join(chatFilesDir(), id, name);
  return insideChatFiles(path) ? path : null;
}

// One turn: the paths go on the end, so Billion reads them with its file tools.
const withFiles = (line, paths) => (paths.length ? `${line} (attached: ${paths.join(', ')})` : line);

export function chatMessages() {
  try {
    const messages = JSON.parse(readFileSync(chatPath(), 'utf8'));
    return Array.isArray(messages) ? messages : [];
  } catch (err) {
    // No thread yet (the first start with the Billion tab): it opens on the
    // questions already asked, so the open ones have a bubble to answer.
    if (err.code !== 'ENOENT') {
      // Kept aside, not overwritten by the next message.
      try { renameSync(chatPath(), `${chatPath()}.bad`); } catch {}
      console.error('The Billion chat could not be read; moved it to chat.json.bad and started a new one:', err.message);
      return [];
    }
    return waitingItems().filter(item => item.status !== 'dismissed' && item.status !== 'queued')
      .map(item => ({ id: `q-${item.id}`, at: item.at, from: 'billion', text: item.text, q: questionState(item) }));
  }
}

function saveChat(messages) {
  // Keep open questions and unanswered requests until their answer arrives.
  const answered = new Set(messages.filter(m => m.from === 'billion' && m.replyTo).map(m => m.replyTo));
  for (const m of messages) if (m.from === 'owner' && answered.has(m.id)) m.awaitsReply = false;
  let over = messages.length - CHAT_CAP;
  const kept = messages.filter(m => !(over > 0 && m.q?.status !== 'open' && !(m.from === 'owner' && m.awaitsReply === true) && over--));
  for (const m of messages) if (m.files && !kept.includes(m)) removeChatFiles(m.id);
  try {
    writeFileSync(`${chatPath()}.tmp`, JSON.stringify(kept));
    renameSync(`${chatPath()}.tmp`, chatPath());
  } catch (err) {
    console.error('Could not save the Billion chat:', err.message);
  }
}

// Only messages actually delivered to Billion enter the reply queue. Questions,
// round commands and worker/server notifications never consume owner replies.
export function pendingOwnerMessages() {
  const messages = chatMessages();
  const answered = new Set(messages.filter(m => m.from === 'billion' && m.replyTo).map(m => m.replyTo));
  return messages.filter(m => m.from === 'owner' && m.awaitsReply === true && !answered.has(m.id));
}

export function updateOwnerProgress(id, text) {
  const messages = chatMessages();
  const message = messages.find(m => m.id === id && m.from === 'owner' && m.awaitsReply);
  if (!message || message.workDetails?.at(-1) === text) return;
  message.workDetails = [...(message.workDetails || []), text].slice(-MAX_STEPS);
  saveChat(messages);
}

export const chatPayload = () => ({ type: 'chat-list', messages: chatMessages() });

export function addChat(message, broadcast, env = process.env) {
  const added = { id: randomUUID(), at: new Date().toISOString(), ...message, text: redact(message.text, env) };
  saveChat([...chatMessages(), added]);
  broadcast?.({ type: 'chat-message', message: added });
  return added;
}

const questionState = (item) => ({
  id: item.id, n: item.n, urgency: item.urgency, project: item.project, type: item.type, status: item.status,
  ...(item.round ? { round: item.round } : {}),
  ...(item.num ? { num: item.num, numRound: item.numRound ?? null } : {}),
  ...(item.done ? { done: true } : {}),
  ...(item.choices ? { choices: item.choices, recommended: item.recommended } : {}),
  ...(item.answer !== undefined ? { answer: item.answer, answeredVia: item.answeredVia, answeredAt: item.answeredAt, ...(item.answeredBy ? { answeredBy: item.answeredBy } : {}) } : {}),
});

// A question's bubble follows it: answered, dismissed.
function syncQuestion(item, broadcast) {
  const messages = chatMessages();
  const message = messages.find(m => m.q?.id === item.id);
  if (!message) return;
  message.q = questionState(item);
  saveChat(messages);
  broadcast?.({ type: 'chat-message', message });
}

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

export const URGENCIES = ['blocking', 'normal', 'low'];
const MAX_PROJECT_CHARS = 40;

// Which project a question is about: the board repo named (in any case), else
// the name as given, lower-cased and capped. Unnamed, it is read off the text:
// a GitHub URL whose repo is on the board, then a board repo's folder name
// mentioned as a word; else "general".
export function questionProject(project, text, repos = config.repos.map(r => basename(r.path))) {
  const find = (name) => repos.find(r => r.toLowerCase() === name.toLowerCase());
  const given = typeof project === 'string' ? project.trim() : '';
  if (given) return given.toLowerCase() === 'general' ? 'general' : find(given) || given.toLowerCase().slice(0, MAX_PROJECT_CHARS);
  for (const [, repo] of String(text).matchAll(/github\.com\/[\w.-]+\/([\w.-]+)/gi)) {
    const hit = find(repo.replace(/\.git$/i, ''));
    if (hit) return hit;
  }
  const words = String(text).toLowerCase();
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return repos.find(r => new RegExp(`(^|[^\\w.-])${escape(r.toLowerCase())}($|[^\\w-])`).test(words)) || 'general';
}

export const QUESTION_TYPES = ['engineering', 'marketing', 'outreach', 'finance', 'product', 'admin', 'other'];

// Read off the text when Billion names no type; the first rule that matches
// wins, so outreach (a reply to a post) beats marketing. X the platform is
// capitalised; a lowercase x is a variable or a times sign.
const TYPE_RULES = [
  ['finance', /\$|\b(money|prices?|priced|pricing|plans?|subscriptions?|renew(s|ed|al|als)?|pay(s|ing|ment|ments)?|paid)\b/i],
  ['engineering', /\b(PRs?|CI|merge[sd]?|merging|deploy(s|ed|ing|ment)?|bugs?|tests?|testing|releases?|released)\b/i],
  ['outreach', /\b(repl(y|ies|ied)|responded|linkedin|email from|DMs?|DM'd|outreach|inbound)\b/i],
  ['marketing', /\b(posts?|posted|posting|reddit|HN|newsletters?|tweets?|tweeted|changelog|launch(es|ed|ing)?)\b/i, /\bX\b/],
  ['admin', /\b(log ?in|logins?|tokens?|accounts?|access|credentials?|set ?up|install(s|ed|ing)?)\b/i],
  ['product', /\b(features?|design(s|ed|ing)?|UX|roadmap|direction)\b/i],
];

// A named type from the list stands (any case); any other name is "other";
// none at all, it is read off the text.
export function questionType(type, text) {
  if (type != null && type !== '') {
    const given = String(type).trim().toLowerCase();
    return QUESTION_TYPES.includes(given) ? given : 'other';
  }
  return TYPE_RULES.find(([, ...rules]) => rules.some(rule => rule.test(String(text ?? ''))))?.[0] || 'other';
}

// status: open (shown now), or queued for the next round, which neither the
// thread nor any browser sees until releaseRound opens it.
export function addWaiting(text, broadcast, now = Date.now(), { choices, recommended, urgency = 'normal', project, type, rank, status = 'open', outside = false, env = process.env } = {}) {
  const items = waitingItems();
  text = redact(text, env);   // shown in every browser, like the thread
  const item = { id: randomUUID(), n: Math.max(0, ...items.map(i => i.n)) + 1, text, at: new Date(now).toISOString(), status, urgency, project: questionProject(project, text), type: questionType(type, text) };
  if (choices) item.choices = choices.map(c => c.trim());
  if (recommended) item.recommended = recommended.trim();
  if (rank != null) item.rank = rank;
  if (outside) Object.assign(item, { outside: true, ...itemNumber(items) });
  if (status === 'queued') {
    saveWaiting([...items, item]);
    return item;
  }
  // The thread first: one not written yet starts from the list as it stands.
  addChat({ from: 'billion', text, q: questionState(item) }, broadcast, env);
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
  syncQuestion(updateWaiting(id, { status: 'dismissed' }), broadcast);
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

// What the owner's Telegram shows for a question; "! " marks a blocking one.
const urgentMark = (urgency) => (urgency === 'blocking' ? '! ' : '');
const questionText = (item) => `${urgentMark(item.urgency)}Q${item.n}: ${item.text}`;

// Where the owner's last message came from this server run: 'app', 'telegram',
// or null before any. tell_owner follows it to the phone only when it is not 'app'.
let ownerChannel = null;
export const lastOwnerChannel = () => ownerChannel;
export function setOwnerChannel(via) { ownerChannel = via; }

// An answer from the app or Telegram (via 'app' or 'telegram'): into Billion's
// terminal, then the item is answered everywhere. typed: the owner wrote it
// rather than tapped a choice, so it shows in the thread as their message too.
// { ok, item } or { error }; on an error the item stays open.
// Runs of spaces collapse, but a pasted answer keeps its line breaks.
const tidyAnswer = (answer) => (typeof answer === 'string'
  ? answer.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  : '');

// files: planChatFiles's, typed in the app; an answer of files alone is
// recorded as their names.
// name: which member of the owner's Telegram group answered (senderName).
export async function answerWaiting(id, answer, via, { broadcast, env = process.env, typed = false, files = [], name = '' } = {}) {
  const body = tidyAnswer(answer) || files.map(f => f.name).join(', ');
  if (!body) return { error: 'The answer is empty.' };
  if (body.length > MAX_ANSWER_CHARS) return { error: `The answer is over ${MAX_ANSWER_CHARS} characters; send it in parts.` };
  const item = waitingItems().find(i => i.id === id);
  if (!item || item.status === 'dismissed' || item.status === 'queued') return { error: 'That question is gone.' };
  if (item.status === 'answered') return { error: `Q${item.n} was answered already: ${item.answer}` };
  if (item.status === 'consolidated') return { error: `Q${item.n} was consolidated when the next round came; Billion asks it again if it still needs it.` };
  const billion = liveBillion();
  if (!billion) return { error: 'Billion is not running' };
  const messageId = randomUUID();
  const saved = files.length ? saveChatFiles(messageId, files) : { paths: [], records: [] };
  if (saved.error) return saved;
  if (!sendText(billion, withFiles(answerLine(via === 'app' ? APP_PREFIX : telegramPrefix(name), item, body), saved.paths), undefined, OWNER)) {
    if (files.length) removeChatFiles(messageId);
    return { error: 'Billion has too much waiting for it; try again in a while.' };
  }
  setOwnerChannel(via);
  const done = await markAnswered(id, body, via, { broadcast, env, name });
  if (typed) addChat({ id: messageId, from: 'owner', via, ...(name ? { name } : {}), text: tidyAnswer(answer), re: item.n, ...(files.length ? { files: saved.records } : {}) }, broadcast, env);
  return { ok: true, item: done };
}

// What the owner types in the Billion tab. With answers (a question's id) it
// answers that question; otherwise it goes into Billion's terminal as a turn
// of its own, like a Telegram message. Refused, never queued, while Billion is
// not running: the browser keeps the text in the box. files: the attachments
// as the browser sent them (planChatFiles); files alone, no text, is a message.
// { ok } or { error }.
export async function ownerSays(text, { answers, files: list, broadcast, env = process.env } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  const { files, error } = planChatFiles(list);
  if (error) return { error };
  if (!body && !files.length) return { error: 'The message is empty.' };
  if (answers) return answerWaiting(answers, body, 'app', { broadcast, env, typed: true, files });
  // Two things the server does itself, never a turn of Billion's: start the
  // round now, and "1d 3d". The words still show in the thread.
  const nums = !files.length && doneNumbers(body);
  if (!files.length && (nums || START_ROUND_RE.test(body))) {
    const result = nums ? await markDone(nums, 'app', { broadcast, env }) : await startRoundNow({ broadcast, env });
    if (result.error) return result;
    setOwnerChannel('app');
    addChat({ from: 'owner', via: 'app', text: body }, broadcast, env);
    return { ok: true, ...(result.missing?.length ? { note: `No open item ${result.missing.join(', ')}.` } : {}) };
  }
  if (body.length > MAX_OWNER_CHARS) return { error: `The message is over ${MAX_OWNER_CHARS} characters; send it in parts.` };
  const billion = liveBillion();
  if (!billion) return { error: 'Billion is not running; start it, then send again.' };
  const id = randomUUID();
  const saved = files.length ? saveChatFiles(id, files) : { paths: [], records: [] };
  if (saved.error) return saved;
  if (!sendText(billion, withFiles(body ? `${APP_PREFIX} ${body}` : APP_PREFIX, saved.paths), undefined, OWNER)) {
    if (files.length) removeChatFiles(id);
    return { error: 'Billion has too much waiting for it; try again in a while.' };
  }
  setOwnerChannel('app');
  addChat({ id, from: 'owner', via: 'app', text: body, awaitsReply: true, ...(files.length ? { files: saved.records } : {}) }, broadcast, env);
  // Pending, with the progress box under it, until a tell_owner answers it.
  publishStatus(broadcast);
  return { ok: true };
}

// Answered everywhere: the item moves to Answered in every browser, and the
// phone's copy shows the answer.
async function markAnswered(id, answer, via, { broadcast, env, name, done: finished = false }) {
  const done = updateWaiting(id, { status: 'answered', answer, answeredAt: new Date().toISOString(), answeredVia: via, answeredBy: name || undefined, ...(finished ? { done: true } : {}) });
  syncQuestion(done, broadcast);
  broadcast?.(waitingPayload());
  if (done.tgMessageId) await showAnswerOnPhone(done, env);
  return done;
}

// resolve_question: the owner answered somewhere else (typed in Billion's
// terminal), so Billion closes the item itself. Nothing goes back into Billion's
// terminal: it already has the answer. { ok, item } or { error }.
export async function resolveQuestion({ number, id } = {}, answer, { broadcast, env = process.env } = {}) {
  const body = tidyAnswer(answer);
  if (!body) return { error: 'The answer is empty.' };
  if (body.length > MAX_ANSWER_CHARS) return { error: `The answer is over ${MAX_ANSWER_CHARS} characters; send it in parts.` };
  const item = waitingItems().find(i => (id ? i.id === id : i.n === number));
  const name = id ? `question ${id}` : `Q${number}`;
  if (!item) return { error: `There is no ${name}.` };
  if (item.status === 'dismissed') return { error: `Q${item.n} was dismissed.` };
  if (item.status === 'answered') return { error: `Q${item.n} was answered already: ${item.answer}` };
  return { ok: true, item: await markAnswered(item.id, body, 'terminal', { broadcast, env }) };
}

// How long the owner's Undo stays under "you answered: ...".
export const UNDO_MS = 60 * 1000;

// An answer taken back: the question is open again, in every browser. From
// Billion (reopen_question) nothing more is said anywhere: it knows. From the
// owner's Undo (owner: true, within UNDO_MS), Billion hears that the answer it
// was given no longer stands. Telegram is left as it is. { ok, item } or { error }.
export async function reopenQuestion({ number, id } = {}, { broadcast, owner = false, now = Date.now() } = {}) {
  const item = waitingItems().find(i => (id ? i.id === id : i.n === number));
  const name = id ? `question ${id}` : `Q${number}`;
  if (!item) return { error: `There is no ${name}.` };
  if (item.status === 'open') return { error: `Q${item.n} is open already.` };
  if (item.status === 'dismissed') return { error: `Q${item.n} was dismissed.` };
  if (item.status === 'queued') return { error: `Q${item.n} is queued for the next round, not answered.` };
  if (item.status === 'consolidated') return { error: `Q${item.n} was consolidated; ask it again with notify_owner if it still matters.` };
  if (owner) {
    if (!(now - Date.parse(item.answeredAt) <= UNDO_MS)) return { error: `Too late to undo Q${item.n}; tell Billion instead.` };
    const billion = liveBillion();
    if (!billion) return { error: 'Billion is not running' };
    if (!sendText(billion, `${APP_PREFIX} Q${item.n}: undo my answer "${item.answer}"; the question is open again.`, undefined, OWNER)) {
      return { error: 'Billion has too much waiting for it; try again in a while.' };
    }
  }
  const done = updateWaiting(item.id, { status: 'open', answer: undefined, answeredAt: undefined, answeredVia: undefined, answeredBy: undefined });
  syncQuestion(done, broadcast);
  broadcast?.(waitingPayload());
  return { ok: true, item: done };
}

// The phone's copy of an answered question shows the answer, and loses its buttons.
async function showAnswerOnPhone(item, env) {
  const { chatId } = telegramSettings(env);
  const where = { app: ' in app', terminal: ' in terminal' }[item.answeredVia] || '';
  const by = item.answeredBy ? ` by ${item.answeredBy}` : '';
  const shown = `${questionText(item)}\n\nAnswered${by}${where}: ${item.answer}`;
  // The message is edited with what fits; the rest follows as messages of its own.
  const [first, ...rest] = splitForTelegram(shown, item.tgVoice ? TG_CAPTION_CHARS : TG_MESSAGE_CHARS);
  const edit = (item.tgVoice
    ? call('editMessageCaption', { chat_id: chatId, message_id: item.tgMessageId, caption: first }, { env })
    : call('editMessageText', { chat_id: chatId, message_id: item.tgMessageId, text: first }, { env })
  ).then(() => rest.length && sendTelegram(rest.join(''), { env }));
  await edit.catch(err => console.error('Telegram: could not mark a question answered:', redact(err.message, env)));
}

// --- notify_owner ---

let sent = [];   // times of recent notify_owner calls

// With rounds on (the default) a question is queued for the next round
// (releaseRound), and the answer is { ok, queued, n, project, position, of,
// max }. Only a question that cannot wait goes out at once: blocking (unless
// telegram: false keeps it for the round, first in its project's queue) or
// telegram: true. That one reaches the tab now and the phone too, unless
// telegram: false. { ok, n, telegram } (telegram: pushed to the phone; held:
// why not), or { pinned, n, error } when it was filed but the push could not happen.
// queue: false shows every question at once, as before rounds (rounds: [] in config.json).
// So does a new install until its first round comes due (or is started early):
// the introduction's questions and the first cycle's should not wait for 08:30.
const roundsStarted = () => !!roundState().current;
export async function notifyOwner(text, { choices, recommended, urgency = 'normal', project, type, telegram, rank, queue = roundSettings().on && roundsStarted(), broadcast, env = process.env, now = Date.now(), platform = process.platform } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { error: 'The message is empty.' };
  if (body.length > MAX_NOTIFY_CHARS) return { error: `The message is ${body.length} characters; keep it under ${MAX_NOTIFY_CHARS}.` };
  const bad = checkChoices(choices, recommended);
  if (bad) return { error: bad };
  urgency ??= 'normal';
  if (!URGENCIES.includes(urgency)) return { error: `urgency must be "blocking", "normal" or "low", not ${JSON.stringify(urgency)}.` };
  if (project != null && typeof project !== 'string') return { error: 'project must be a repo\'s folder name or "general".' };
  if (telegram != null && typeof telegram !== 'boolean') return { error: 'telegram must be true or false.' };
  if (rank != null && !(Number.isInteger(rank) && rank >= 1 && rank <= 99)) return { error: 'rank must be a whole number from 1 (most important) to 99.' };
  const outside = telegram === true || (urgency === 'blocking' && telegram !== false);
  if (queue && !outside) {
    // Not in front of the owner, so not under the per-minute limit.
    let item;
    try { item = addWaiting(body, broadcast, now, { choices, recommended, urgency, project, type, rank, status: 'queued', env }); } catch (err) {
      return { error: `Could not queue it: ${err.message}` };
    }
    broadcast?.(roundView(now));
    const mine = roundQueueFor(item.project);
    return { ok: true, queued: true, n: item.n, project: item.project, position: mine.findIndex(i => i.id === item.id) + 1, of: mine.length, max: roundSettings().max };
  }
  sent = sent.filter(t => now - t < NOTIFY_WINDOW_MS);
  if (sent.length >= NOTIFY_LIMIT) {
    return { error: `Not sent: you have notified the owner ${NOTIFY_LIMIT} times in the last minute. Put the rest in one message later, or under Waiting on you in STATE.md.` };
  }
  sent.push(now);
  let item;
  try { item = addWaiting(body, broadcast, now, { choices, recommended, urgency, project, type, rank, outside: queue, env }); } catch (err) {
    console.error('Could not save the Waiting list:', err.message);
  }
  const n = item ? ` as Q${item.n}` : '';
  // Held back only once it is safely filed: a question the tab lost still goes to the phone.
  if (item && !(telegram ?? urgency === 'blocking')) {
    return { ok: true, n: item?.n, telegram: false, held: telegram === false ? 'telegram: false' : `urgency ${urgency}` };
  }
  const { token, chatId } = telegramSettings(env);
  if (!token || !chatId) {
    return { pinned: true, n: item?.n, error: `Put in the owner's Billion tab${n}, but not sent to their phone: Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID). Say it in your terminal as well.` };
  }
  // A button per choice; callback_data is "<id>:<index>", 38 bytes of Telegram's 64.
  const keyboard = item?.choices && {
    reply_markup: { inline_keyboard: item.choices.map((c, i) => [{ text: c === item.recommended ? `${c} (recommended)` : c, callback_data: `${item.id}:${i}` }]) },
  };
  const result = await sendToOwner(item ? questionText(item) : `${urgentMark(urgency)}${body}`, { env, platform, extra: keyboard || undefined });
  if (result.error) return { pinned: true, n: item?.n, error: `Put in the owner's Billion tab${n}, but the Telegram send failed: ${result.error}` };
  // Kept so a reply to this message, or a tap on its buttons, finds the question.
  if (item && result.messageId) {
    let saved;
    try { saved = updateWaiting(item.id, { tgMessageId: result.messageId, ...(result.voice ? { tgVoice: true } : {}) }); } catch {}
    // Answered in the app while the send was on its way.
    if (saved?.status === 'answered') await showAnswerOnPhone(saved, env);
  }
  return { ok: true, n: item?.n, telegram: true };
}

// --- tell_owner: a reply or status update, no Waiting item, no badge ---
// Always a bubble in the Billion tab; on the phone too when Telegram is set up
// and the owner's last message did not come from the tab (none yet counts as
// the phone, so a status update still reaches someone away from the browser).
// { ok, telegram } (telegram: sent there too), { ok, note } when only the
// Telegram send failed, or { error }.

// notice: the server's own words (an account switch, say), which answer none
// of the owner's messages, so a pending one stays pending.
export async function tellOwner(text, { broadcast, env = process.env, now = Date.now(), platform = process.platform, notice = false } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { error: 'The message is empty.' };
  if (body.length > MAX_NOTIFY_CHARS) return { error: `The message is ${body.length} characters; keep it under ${MAX_NOTIFY_CHARS}.` };
  // Shares notify_owner's limit: both land on the same phone.
  sent = sent.filter(t => now - t < NOTIFY_WINDOW_MS);
  if (sent.length >= NOTIFY_LIMIT) {
    return { error: `Not sent: you have messaged the owner ${NOTIFY_LIMIT} times in the last minute. Put the rest in one message later.` };
  }
  sent.push(now);
  // Each of the owner's messages gets its own reply, oldest first.
  const replyTo = notice ? null : billionReplied();
  const workDetails = replyTo ? pendingOwnerMessages()[0]?.workDetails : null;
  addChat({ from: 'billion', text: body, ...(notice ? { notice: true } : {}), ...(replyTo ? { replyTo, ...(workDetails?.length ? { workDetails } : {}) } : {}) }, broadcast, env);
  publishStatus(broadcast);
  const { token, chatId } = telegramSettings(env);
  if (!token || !chatId) return { ok: true, telegram: false };
  if (ownerChannel === 'app') return { ok: true, telegram: false, tabOnly: true };
  const result = await sendToOwner(body, { env, platform });
  if (result.error) return { ok: true, note: `The Telegram send failed: ${result.error}` };
  return { ok: true, telegram: true };
}

// --- Rounds: the owner is come to twice a day (docs/BILLION.md, "Rounds") ---
//
// notify_owner queues; at each round time (server/rounds.js) releaseRound
// opens the top `max` queued questions of each project, in byPriority order,
// and consolidates whatever the previous round left open. The rest stay
// queued for Billion to re-rank: never shown as a pile.

// A project's queued questions, first to go first.
export function roundQueueFor(project) {
  return waitingItems().filter(i => i.status === 'queued' && i.project === project).sort(byPriority);
}

// list_round_queue: { projects: [{ project, items }], max, open } where open
// counts the questions on the owner's screen now.
export function roundQueue(settings = roundSettings()) {
  const items = waitingItems();
  const projects = [...new Set(items.filter(i => i.status === 'queued').map(i => i.project))].sort()
    .map(project => ({ project, items: roundQueueFor(project) }));
  return { projects, max: settings.max, open: items.filter(i => i.status === 'open').length };
}

// drop_queued: a queued question Billion no longer needs. { ok, item } or { error }.
export function dropQueued({ number, id } = {}) {
  const item = waitingItems().find(i => (id ? i.id === id : i.n === number));
  const name = id ? `question ${id}` : `Q${number}`;
  if (!item) return { error: `There is no ${name}.` };
  if (item.status !== 'queued') return { error: `Q${item.n} is not queued (it is ${item.status}).` };
  return { ok: true, item: updateWaiting(item.id, { status: 'dismissed', dropped: true }) };
}

// A line for Billion's terminal, kept in rounds.json until Billion runs.
function noteForBillion(line) {
  const state = roundState();
  state.note = state.note ? `${state.note}\n${line}` : line;
  saveRoundState(state);
  deliverRoundNote();
}

export function deliverRoundNote() {
  const state = roundState();
  const billion = state.note && liveBillion();
  if (!billion || !sendText(billion, state.note)) return false;
  delete state.note;
  saveRoundState(state);
  return true;
}

const qList = (items) => items.map(i => `Q${i.n}`).join(', ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const topWords = (max) => (max === 2 ? 'top two' : `top ${max}`);

// round: rounds.js's { id, label, name, at }. Returns { released, consolidated, left }.
export async function releaseRound(round, { broadcast, env = process.env, settings = roundSettings(), now = Date.now(), early = false } = {}) {
  const items = waitingItems();
  const iso = new Date(now).toISOString();
  const consolidated = items.filter(i => i.status === 'open' && i.round && i.round !== round.id);
  for (const item of consolidated) Object.assign(item, { status: 'consolidated', consolidatedAt: iso, consolidatedBy: round.id });
  const taken = new Map();
  const released = [];
  for (const item of items.filter(i => i.status === 'queued').sort(byPriority)) {
    const count = taken.get(item.project) || 0;
    if (count >= settings.max) continue;
    taken.set(item.project, count + 1);
    Object.assign(item, { status: 'open', round: round.id, pos: released.length, releasedAt: iso });
    released.push(item);
  }
  // The owner's short numbers for this round (1, 2, 3…), in the order the tab
  // shows them: what still needs them from outside a round first, then each
  // project in the order of its first question.
  const firstPos = new Map();
  for (const item of released) if (!firstPos.has(item.project)) firstPos.set(item.project, item.pos);
  const shown = [
    ...items.filter(i => i.status === 'open' && i.outside).sort((a, b) => String(a.at).localeCompare(String(b.at))),
    ...[...released].sort((a, b) => firstPos.get(a.project) - firstPos.get(b.project) || a.pos - b.pos),
  ];
  shown.forEach((item, i) => Object.assign(item, { num: i + 1, numRound: round.id }));
  // The thread first, as addWaiting does: one not written yet starts from the list as it stands.
  for (const item of released) addChat({ from: 'billion', text: item.text, q: questionState(item) }, broadcast, env);
  saveWaiting(items);
  for (const item of consolidated) syncQuestion(item, broadcast);
  const state = roundState();
  const brief = state.brief;
  delete state.brief;
  state.lastAt = new Date(round.at).toISOString();
  state.current = { id: round.id, label: round.label, name: round.name, at: state.lastAt, releasedAt: iso, ...(brief ? { brief } : {}), ...(early ? { early: true } : {}) };
  saveRoundState(state);
  broadcast?.(waitingPayload());
  broadcast?.(roundView(now, settings));
  const left = items.filter(i => i.status === 'queued').length;
  if (released.length || consolidated.length || left || early) {
    noteForBillion(`[Owner round] Round ${round.label}${early ? ' (started early by the owner)' : ''} released ${released.length}${released.length ? ` (${released.map(i => `item ${i.num} = Q${i.n}`).join(', ')})` : ''}`
      + `${consolidated.length ? `; consolidated ${qList(consolidated)}: re-queue only if still ${topWords(settings.max)}` : ''}`
      + `${left ? `; ${left} still queued for later rounds (list_round_queue to re-rank or drop)` : ''}.`);
  }
  // One message for the whole round, never one per question.
  if (released.length) {
    const link = appLink(env);
    const said = await sendTelegram(`${round.name}: ${plural(released.length, 'item')} across ${plural(taken.size, 'department')}`
      + `${brief ? `\n\n${brief}` : ''}${link ? `\n${link}` : ''}`, { env });
    if (said.error && said.error !== 'Telegram is not configured') console.error('Telegram: could not announce the round:', said.error);
  }
  return { released, consolidated, left };
}

// The first start with rounds: every open question but a blocking one is
// consolidated, so the owner starts from a clean round. Once (rounds.json's
// migratedAt). Returns the consolidated questions.
export function migrateToRounds({ broadcast, now = Date.now(), settings = roundSettings() } = {}) {
  const state = roundState();
  if (state.migratedAt) return null;
  const items = waitingItems();
  const iso = new Date(now).toISOString();
  const moved = items.filter(i => i.status === 'open' && i.urgency !== 'blocking');
  for (const item of moved) Object.assign(item, { status: 'consolidated', consolidatedAt: iso, consolidatedBy: 'rounds-start' });
  if (moved.length) saveWaiting(items);
  for (const item of moved) syncQuestion(item, broadcast);
  // The round already past today is not released on the spot: the next one is.
  saveRoundState({ ...state, migratedAt: iso, lastAt: state.lastAt || iso });
  if (moved.length) broadcast?.(waitingPayload());
  const next = comingRound(now, settings);
  noteForBillion(`[Owner round] Rounds are on: from the first round${next ? ` (${next.label})` : ''} the owner sees your questions only at ${settings.slots.join(' and ')}, at most ${settings.max} per project; notify_owner queues them (see Escalate in CHARTER.md). Until then a question shows at once.`
    + `${moved.length ? ` Consolidated ${plural(moved.length, 'open question')} (${qList(moved)}): re-queue only the ones still in a project's ${topWords(settings.max)}.` : ''}`);
  return moved;
}

// The tab's round-state: rounds.js's payload with how many questions wait.
export const roundView = (now = Date.now(), settings = roundSettings()) =>
  roundPayload(now, settings, waitingItems().filter(i => i.status === 'queued').length);

// The next number in the round on screen (or before the first round), for a
// question that arrives outside a round: { num, numRound }.
function itemNumber(items) {
  const numRound = roundState().current?.id ?? null;
  return { num: Math.max(0, ...items.filter(i => (i.numRound ?? null) === numRound && i.num).map(i => i.num)) + 1, numRound };
}

// "Start the round now" (the tab's button, or the owner saying so): the next
// round, released now under the same rules. Its time is then taken, so the
// clock does not release it again. { ok, released, consolidated, left } or { error }.
export async function startRoundNow({ broadcast, env = process.env, now = Date.now(), settings = roundSettings() } = {}) {
  if (!settings.on) return { error: 'Rounds are off (rounds: [] in config.json), so every question already shows at once.' };
  migrateToRounds({ broadcast, now, settings });
  const next = comingRound(now, settings);
  if (!next) return { error: 'No round is scheduled.' };
  return { ok: true, ...await releaseRound(next, { broadcast, env, settings, now, early: true }) };
}

// What the owner types to start it: "start the round now", "start round", "release the round".
export const START_ROUND_RE = /^\s*(please\s+)?(start|begin|release|open)\s+(the\s+)?(next\s+)?round(\s+now)?(\s+please)?\s*[.!]?\s*$/i;

// "1d", "1d 3d", "1d, 3d": the items of the round the owner marks done. The numbers, or null.
export function doneNumbers(text) {
  const body = String(text ?? '').trim();
  if (!/^(\d{1,3}\s?d)([\s,]+\d{1,3}\s?d)*$/i.test(body)) return null;
  return [...new Set(body.match(/\d{1,3}/g).map(Number))];
}

// "1d" or Done: the item is done and leaves the owner's list (it folds as
// done), and Billion reads "[Owner via app] item 1 done (Q12: "…")". Every
// number in one line. { ok, done, missing } or { error }.
export async function markDone(nums, via = 'app', { broadcast, env = process.env, name = '' } = {}) {
  const numRound = roundState().current?.id ?? null;
  const items = waitingItems();
  const found = nums.map(n => [n, items.find(i => (i.numRound ?? null) === numRound && i.num === n && i.status === 'open')]);
  const done = found.filter(([, item]) => item).map(([, item]) => item);
  const missing = found.filter(([, item]) => !item).map(([n]) => n);
  if (!done.length) return { error: `No open item ${missing.join(', ')} in this round.` };
  const billion = liveBillion();
  if (!billion) return { error: 'Billion is not running' };
  const prefix = via === 'app' ? APP_PREFIX : telegramPrefix(name);
  const context = (item) => {
    const flat = item.text.replace(/\s+/g, ' ').trim();
    return flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat;
  };
  const line = `${prefix} ${done.map(item => `item ${item.num} done (Q${item.n}: "${context(item)}")`).join('; ')}`;
  if (!sendText(billion, line, undefined, OWNER)) return { error: 'Billion has too much waiting for it; try again in a while.' };
  setOwnerChannel(via);
  for (const item of done) await markAnswered(item.id, 'done', via, { broadcast, env, name, done: true });
  return { ok: true, done, missing };
}

// From the server's 10 s tick: the first-start migration, a note waiting for
// Billion, and the round that has come due. Returns releaseRound's result, or null.
export async function roundTick({ broadcast, env = process.env, now = Date.now(), settings = roundSettings() } = {}) {
  if (!settings.on) return null;
  migrateToRounds({ broadcast, now, settings });
  deliverRoundNote();
  const due = lastRound(now, settings);
  const { lastAt } = roundState();
  if (!due || due.at <= (Date.parse(lastAt) || 0)) return null;
  return releaseRound(due, { broadcast, env, settings, now });
}

// --- Connecting a chat: "Use this chat" in the Billion tab ---
//
// With no chat id yet, a message from any chat becomes an offer in the owner's
// browser (ws.js sends these to the owner's pages only). Nothing is adopted
// until the owner accepts one, so a stranger who finds the bot is just an
// offer to ignore. Each new chat is offered, up to OFFER_CAP a run, so a
// stranger messaging first cannot hide the owner's.

const OFFER_CAP = 20;
const seenChats = new Set();
const offers = new Map();   // chat id (string) -> { chatId, name }
let connectedNow = '';      // the chat just picked, for "Telegram connected"

const chatName = (msg) => cleanName(msg.chat.title) || personName(msg.from) || 'an unnamed chat';

// chat: the connected one, for the Settings panel; fromEnv when TELEGRAM_CHAT_ID set it.
export const telegramPayload = (env = process.env) => {
  const { token, chatId } = telegramSettings(env);
  const fromEnv = !!(env.TELEGRAM_CHAT_ID || '').trim();
  return {
    type: 'telegram-state', on: !!token, connected: !!chatId,
    ...(chatId ? { chat: { chatId, name: fromEnv ? '' : cleanName(savedChat().name), fromEnv } } : {}),
    ...(connectedNow && chatId ? { connectedTo: connectedNow } : {}),
    offers: chatId ? [] : [...offers.values()],
  };
};

function offerChat(msg, broadcast, env) {
  const id = String(msg.chat.id);
  if (seenChats.has(id) || seenChats.size >= OFFER_CAP) return;
  seenChats.add(id);
  const name = chatName(msg);
  offers.set(id, { chatId: id, name });
  // For a headless setup, where no browser shows the offer.
  console.log(`  Telegram: a message came from ${name} (chat ${id}). If that was you, press "Use this chat" in the Billion tab, or set TELEGRAM_CHAT_ID=${id} in ~/.agent-007/.env and restart.`);
  broadcast?.(telegramPayload(env));
}

// The owner pressed "Use this chat" (ws.js checks it is the owner). Only a
// chat that messaged the bot and is on offer can be picked. { ok } or { error }.
export async function useTelegramChat(chatId, { broadcast, env = process.env } = {}) {
  const offer = offers.get(String(chatId));
  if ((env.TELEGRAM_CHAT_ID || '').trim()) return { error: 'TELEGRAM_CHAT_ID is set in the environment; it wins over a chat picked here.' };
  if (!offer) return { error: 'That chat is no longer on offer; send the bot a message again.' };
  try {
    writeFileSync(`${tgChatPath()}.tmp`, JSON.stringify({ chatId: offer.chatId, name: offer.name }), { mode: 0o600 });
    renameSync(`${tgChatPath()}.tmp`, tgChatPath());
  } catch (err) {
    return { error: `Could not save the chat: ${err.message}` };
  }
  offers.clear();
  connectedNow = offer.name;
  console.log(`  Telegram: connected to ${offer.name} (chat ${offer.chatId}), picked in the browser`);
  broadcast?.(telegramPayload(env));
  const said = await sendTelegram('Connected to Agent 007.', { env });
  if (said.error) console.error('Telegram: could not say hello in the new chat:', said.error);
  return { ok: true };
}

// "Change" in Settings: forget the picked chat, so the next message to the bot
// is offered again (every chat, even one seen before). { ok } or { error }.
export function forgetTelegramChat({ broadcast, env = process.env } = {}) {
  if ((env.TELEGRAM_CHAT_ID || '').trim()) return { error: 'TELEGRAM_CHAT_ID is set in the environment; remove it from .env and restart to change the chat.' };
  try { rmSync(tgChatPath(), { force: true }); } catch (err) { return { error: `Could not forget the chat: ${err.message}` }; }
  seenChats.clear();
  offers.clear();
  connectedNow = '';
  console.log('  Telegram: chat forgotten in the browser; the next chat to message the bot is offered');
  broadcast?.(telegramPayload(env));
  return { ok: true };
}

export function dismissTelegramChat(chatId, { broadcast, env = process.env } = {}) {
  if (!offers.delete(String(chatId))) return false;
  broadcast?.(telegramPayload(env));
  return true;
}

// For the tests: a fresh run.
export function _resetTelegramChats() {
  seenChats.clear();
  offers.clear();
  connectedNow = '';
  groupPlain = false;
  groupRestricted = 0;
}

// A group with the bot's privacy mode on delivers only commands and replies
// to the bot, so members' plain messages never arrive. Seen only those a few
// times and never a plain one: say how to fix it, once.
let groupPlain = false;
let groupRestricted = 0;
const PRIVACY_HINT_AFTER = 3;

function watchPrivacy(msg) {
  if (!GROUP_TYPES.includes(msg.chat?.type) || groupPlain) return;
  const restricted = /^\//.test(msg.text || '') || msg.reply_to_message?.from?.is_bot;
  if (!restricted) { groupPlain = true; return; }
  if (++groupRestricted === PRIVACY_HINT_AFTER) {
    console.log('  Telegram: the group only sends the bot commands and replies so far. If members\' plain messages are not reaching Billion, turn the bot\'s privacy mode off: /setprivacy in @BotFather, Disable, then remove and re-add the bot.');
  }
}

// --- Replies: long-polling getUpdates ---

// One update. Returns what happened, for the tests and the log.
export async function handleUpdate(update, { broadcast, env = process.env } = {}) {
  if (update?.callback_query) return handleButton(update.callback_query, { broadcast, env });
  const msg = update?.message;
  const chat = msg?.chat?.id;
  if (chat === undefined || chat === null) return 'ignored';
  const { chatId } = telegramSettings(env);
  if (!chatId) {
    // Setting up: offer the chat to the owner, and use nothing else from it.
    offerChat(msg, broadcast, env);
    return 'discovery';
  }
  if (String(chat) !== chatId) return 'ignored';
  watchPrivacy(msg);
  const note = (msg.voice || msg.audio)?.file_id ? (msg.voice || msg.audio) : null;
  const typed = typeof msg.text === 'string' && msg.text.trim() ? msg.text : null;
  if (!note && !typed) return 'ignored';
  saveOwnerMode(note ? 'voice' : 'text');
  setOwnerChannel('telegram');
  const name = senderName(msg.chat, msg.from);
  // A typed reply to one of Billion's questions answers that question.
  const repliedTo = typed && msg.reply_to_message?.message_id;
  const question = repliedTo && waitingItems().find(i => i.tgMessageId === repliedTo && i.status === 'open');
  if (question) {
    const result = await answerWaiting(question.id, typed, 'telegram', { broadcast, env, typed: true, name });
    if (result.error) {
      await sendTelegram(result.error, { env });
      return result.error === 'Billion is not running' ? 'not-running' : 'full';
    }
    return 'answered';
  }
  const nums = typed && doneNumbers(typed);
  if (nums || (typed && START_ROUND_RE.test(typed))) {
    const result = nums ? await markDone(nums, 'telegram', { broadcast, env, name }) : await startRoundNow({ broadcast, env });
    await sendTelegram(result.error || (nums ? `Done: ${result.done.map(i => `item ${i.num}`).join(', ')}${result.missing.length ? `; no open item ${result.missing.join(', ')}` : ''}.`
      : `Round started: ${plural(result.released.length, 'item')}.`), { env });
    addChat({ from: 'owner', via: 'telegram', ...(name ? { name } : {}), text: typed }, broadcast, env);
    return result.error ? 'refused' : nums ? 'done' : 'round';
  }
  const billion = liveBillion();
  if (!billion) {
    await sendTelegram('Billion is not running', { env });
    return 'not-running';
  }
  const who = name ? { name } : {};
  let line = `${telegramPrefix(name)} ${typed}`;
  let said = { from: 'owner', via: 'telegram', ...who, text: typed };
  if (note) {
    const heard = await transcribeNote(note, env);
    if (heard.reply) {
      await sendTelegram(heard.reply, { env });
      return heard.result;
    }
    const caption = typeof msg.caption === 'string' && msg.caption.trim() ? ` (caption: ${msg.caption.trim()})` : '';
    line = `${telegramPrefix(name, true)} ${heard.transcript}${caption}`;
    said = { from: 'owner', via: 'telegram', ...who, voice: true, text: `${heard.transcript}${caption}` };
  }
  if (!sendText(billion, line, undefined, OWNER)) {
    await sendTelegram('Billion has too much waiting for it; try again in a while.', { env });
    return 'full';
  }
  addChat({ ...said, awaitsReply: true }, broadcast, env);
  publishStatus(broadcast);
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
    await ack(item?.status === 'answered' ? `Already answered: ${item.answer}`
      : item?.status === 'consolidated' ? 'That question was consolidated into a later round.' : 'That question is gone.');
    return 'stale';
  }
  const result = await answerWaiting(id, choice, 'telegram', { broadcast, env, name: senderName(query.message?.chat, query.from) });
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
  if (!chatId) console.log('  Telegram: send any message to your bot, then press "Use this chat" in the Billion tab (the chat id is shown here too when it arrives)');
  else console.log('  Telegram: on');
  if (voiceSetting(env) !== 'never' && !speechUnavailable(env)) {
    sayVoice(env).then(v => {
      const rate = sayRate(env);
      console.log(`  Telegram: speaking with ${v ? `the ${v} voice` : "say's default voice"} at ${rate ? `${rate} wpm` : 'the system default speed'}`);
    });
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
