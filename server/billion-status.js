// The Billion tab's status line and progress box: what Billion is doing, so a
// slow reply is never a blank screen (docs/BILLION.md, "Status line").
//
// Only explicitly user-facing set_status summaries enter this stream. Never
// inspect terminal output, tool arguments/results, transcripts or model analysis.
// Reply bindings and bounded summaries live in chat.json, so reconnects and
// server restarts reconstruct the same oldest-first queue.
import { redact, pendingOwnerMessages, updateOwnerProgress } from './owner.js';

export const MAX_STATUS_CHARS = 140;
export const STATUS_TTL_MS = 30 * 60 * 1000;
// A reply that never comes (Billion answered in its terminal only) stops
// saying "working on your message" after this.
export const AWAIT_REPLY_MS = 60 * 60 * 1000;

let said = null;            // { text, at }
export const MAX_STEPS = 3;
let facts = () => ({});     // server.js: { billion, workers, nextRoundAt }
let last = '';

export function setStatusFacts(fn) { facts = fn; }

// set_status. '' clears. { ok } or { error }.
export function setBillionStatus(text, now = Date.now()) {
  if (typeof text !== 'string') return { error: 'text must be a string ("" clears it).' };
  const body = redact(text).replace(/\s+/g, ' ').trim();
  if (body.length > MAX_STATUS_CHARS) return { error: `The status is ${body.length} characters; keep it to ${MAX_STATUS_CHARS}.` };
  said = body ? { text: body, at: now } : null;
  const first = pendingOwnerMessages()[0];
  if (first && body) updateOwnerProgress(first.id, body);
  return { ok: true, cleared: !body };
}

// A tell_owner answers the owner request it names (reply_to: the short id a
// voice turn carries, or any longer prefix of a message id), even after the
// activity indicator has timed out. The reply's persisted replyTo closes it.
// A reply_to that names no waiting message binds to nothing (a follow-up to a
// turn already answered must not become the next turn's spoken answer). With
// no reply_to, the oldest waiting typed or Telegram message, else nothing: a
// voice turn is answered only by a reply_to that names it, so an unrelated
// status note never takes its place. { id, missed }.
export const SHORT_ID_CHARS = 8;
export function billionReplied(replyTo) {
  const pending = pendingOwnerMessages();
  const wanted = typeof replyTo === 'string' ? replyTo.trim().replace(/^#/, '') : '';
  if (wanted) {
    const named = wanted.length >= SHORT_ID_CHARS && pending.find(m => m.id.startsWith(wanted));
    return named ? { id: named.id, missed: false } : { id: null, missed: true };
  }
  return { id: pending.find(m => !m.voice)?.id ?? null, missed: false };
}

export function statusPayload(now = Date.now()) {
  const { billion, workers = 0, nextRoundAt = null } = facts() || {};
  const running = !!billion && !billion.exited;
  const working = running && billion.state === 'WORKING';
  const awaiting = pendingOwnerMessages();
  const active = running ? awaiting.filter(m => now - Date.parse(m.at) < AWAIT_REPLY_MS) : [];
  const pending = active.map(m => m.id);
  return {
    type: 'billion-status',
    text: said && now - said.at < STATUS_TTL_MS ? said.text : '',
    running,
    working,
    workers,
    nextRoundAt,
    awaitingReply: pending.length > 0,
    // The owner's messages shown as pending, and what the progress box lists.
    pending,
    currentRequest: awaiting[0]?.id ?? null,
    steps: [], // Compatibility with older clients; raw screen steps are never sent.
    progress: Object.fromEntries(awaiting.map(m => [m.id, m.workDetails || []])),
  };
}

// Sent when it changed since the last one; the 10 s tick and every change call it.
export function publishStatus(broadcast, now = Date.now()) {
  const payload = statusPayload(now);
  const key = JSON.stringify(payload);
  if (key === last) return false;
  last = key;
  broadcast?.(payload);
  return true;
}

// For the tests: a fresh run.
export function _resetStatus() {
  said = null;
  facts = () => ({});
  last = '';
}
