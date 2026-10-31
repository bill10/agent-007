// A board worker whose turn died on a transient API error (429, 5xx,
// overloaded, a dropped connection) sits at its prompt until someone types
// "continue", often all night. The rounds tick (startRounds in server.js)
// does it for them: at most MAX_AUTO_CONTINUES per card, BACKOFF_MS after the
// error, the count reset by a turn that ends cleanly. Each one is logged on the card (read_job). Usage
// limits and logins are not this: billion-limit.js and account-rotation.js
// handle those, so a screen showing either is left alone.
//
// Idea from mattabate/life-distributable hub/internal/threads/retry.go.

import { screenTail, sendText } from './messages.js';
import { matchLimit } from './billion-limit.js';

export const MAX_AUTO_CONTINUES = 2;
export const BACKOFF_MS = 60_000;
const TAIL_LINES = 15;
const LOG_CAP = 20;

// The CLI's own error line, not prose about one: at the start of a line, past
// the transcript's own marks. Claude Code: "⎿ API Error: 529 {…overloaded…}",
// "API Error: Connection error.". Codex: "■ stream disconnected before
// completion", "unexpected status 503".
const ERROR_LINE = /^[ \t⎿●■⚠✗×│]*(?:API\s*Error|stream\s*(?:disconnected|error)|unexpected\s*status|error\s*sending\s*request)\b.*$/gim;
const TRANSIENT = /\b(?:429|5\d\d)\b|overloaded|connection\s*error|fetch\s*failed|ECONNRESET|ETIMEDOUT|socket\s*hang\s*up|timed?\s*out|disconnected/i;
// Anywhere on the tail: a login prompt need not sit on an error line. The
// status codes only on one.
const AUTH = /Please\s*run\s*\/login|OAuth\s*token|authentication_error|Invalid\s*API\s*key|Not\s*logged\s*in|access\s*token\s*could\s*not\s*be\s*refreshed/i;
const AUTH_STATUS = /\b40[13]\b/;
// Our own "continue" echoed in the transcript: what came before it is answered.
const ECHO = /^\s*[>›❯]\s*continue\s*$/gim;

// 'transient' | 'limit' | 'auth' | null, with the error line.
export function classifyTail(text) {
  const s = String(text ?? '');
  if (matchLimit(s)?.kind === 'hard') return { kind: 'limit' };
  const line = [...s.matchAll(ERROR_LINE)].pop()?.[0].trim().slice(0, 160);
  if (AUTH.test(s) || AUTH_STATUS.test(line || '')) return { kind: 'auth' };
  if (line && TRANSIENT.test(line)) return { kind: 'transient', line };
  return { kind: null };
}

// The tail after the last "continue" typed into it.
export function sinceContinue(text) {
  const s = String(text ?? '');
  const last = [...s.matchAll(ECHO)].pop();
  return last ? s.slice(last.index + last[0].length) : s;
}

/**
 * One look at one board worker. Mutates job.autoContinue ({ count, at, spent,
 * log }) and returns what it did: 'continued', 'reset', 'spent' or null. A
 * caller persists the card on anything but null.
 */
export function autoContinueTick(job, session, { now = Date.now(), send = sendText } = {}) {
  if (!session || session.exited || session.isBillion || session.state !== 'WAITING') return null;
  if (session.accountRotating || session.rotationResume) return null;
  const ac = job.autoContinue;
  // Typed, and the worker has not moved since: wait for it.
  if (ac?.at && !((session.stateChangedAt || 0) > ac.at)) return null;
  const hit = classifyTail(sinceContinue(screenTail(session.ringBuffer?.getAll().join('') || '', TAIL_LINES)));
  if (hit.kind !== 'transient') {
    // A clean turn since the last continue: the budget is back.
    if (hit.kind === null && ac?.count) { ac.count = 0; ac.spent = false; return 'reset'; }
    return null;
  }
  if (now - (session.lastOutputAt || 0) < BACKOFF_MS) return null;
  const state = job.autoContinue ||= { count: 0, at: 0, spent: false, log: [] };
  const note = (text) => { state.log.push({ at: new Date(now).toISOString(), text }); state.log.splice(0, state.log.length - LOG_CAP); };
  if (state.count >= MAX_AUTO_CONTINUES) {
    if (state.spent) return null;
    state.spent = true;
    note(`Not continued: ${MAX_AUTO_CONTINUES} auto-continues used, left stalled ("${hit.line}")`);
    return 'spent';
  }
  if (!send(session, 'continue', now)) return null;
  state.count++;
  state.at = now;
  note(`Auto-continue ${state.count}/${MAX_AUTO_CONTINUES} after a transient error ("${hit.line}")`);
  return 'continued';
}
