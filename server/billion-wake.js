// Billion's operating loop, driven by the server (docs/BILLION.md).
//
// Claude Code's /loop and ScheduleWakeup have no Codex equivalent, so neither
// CLI paces itself: the server types the cycle prompt into Billion's terminal,
// the way mail is typed. One loop for both CLIs, and the charter tells Billion
// not to start one of its own, so a Claude Billion is never driven twice.
//
// When: every WAKE_QUIET_MIN minutes, every WAKE_BUSY_MIN while one of its
// cards is In progress or in Review, or when Billion said with set_next_wake.
// Only while it rests at its prompt (canDeliver, which message delivery uses),
// with its inbox open, no mail waiting (that is a turn of its own) and the
// owner quiet in its terminal for OWNER_QUIET_MS: a conversation with the
// owner is not interrupted by a cycle.

import { canDeliver, pendingMessages, sendText } from './messages.js';

export const WAKE_PROMPT = 'Run one operating cycle as defined in CHARTER.md.';
export const WAKE_QUIET_MIN = 30;
export const WAKE_BUSY_MIN = 3;
export const WAKE_MIN_MIN = 3;
export const WAKE_MAX_MIN = 60;
export const OWNER_QUIET_MS = 2 * 60_000;
export const WAKE_TICK_MS = 10_000;
const MIN = 60_000;

// When the next cycle is due. Measured from the last wake, or the start (whose
// own prompt runs a cycle); set_next_wake's time instead, when there is one.
export function nextWakeAt(session, busy) {
  if (session.wakeAt) return session.wakeAt;
  return (session.lastWakeAt || session.createdAt || 0) + (busy ? WAKE_BUSY_MIN : WAKE_QUIET_MIN) * MIN;
}

export function wakeDue(session, { now = Date.now(), busy = false } = {}) {
  if (!session || session.exited || session.messagesHeld) return false;
  if (now < nextWakeAt(session, busy)) return false;
  if (now - (session.lastUserInputAt || 0) < OWNER_QUIET_MS) return false;
  if (pendingMessages(session.id)) return false;
  return canDeliver(session, now);
}

// Types the prompt when a cycle is due; returns whether it did.
export function wakeTick(session, { now = Date.now(), busy = false, send = sendText } = {}) {
  if (!wakeDue(session, { now, busy })) return false;
  session.lastWakeAt = now;
  session.wakeAt = null;
  return send(session, WAKE_PROMPT, now);
}

// set_next_wake: the next cycle only; after it the server's own pace returns.
export function setNextWake(session, minutes, now = Date.now()) {
  if (!Number.isInteger(minutes) || minutes < WAKE_MIN_MIN || minutes > WAKE_MAX_MIN) {
    return { error: `minutes must be a whole number from ${WAKE_MIN_MIN} to ${WAKE_MAX_MIN}.` };
  }
  session.wakeAt = now + minutes * MIN;
  return { at: session.wakeAt };
}
