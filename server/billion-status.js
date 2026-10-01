// The Billion tab's status line: one line saying what Billion is doing, so a
// slow reply is never a blank screen (docs/BILLION.md, "Status line").
//
// Billion's own words come from set_status and fade after STATUS_TTL_MS
// without an update. The rest the server knows: whether Billion's terminal is
// mid-turn, how many workers on its cards are running, when the next round is,
// and whether the owner's last message is still waiting on a reply (from their
// message until Billion's next tell_owner).

export const MAX_STATUS_CHARS = 140;
export const STATUS_TTL_MS = 30 * 60 * 1000;
// A reply that never comes (Billion answered in its terminal only) stops
// saying "working on your message" after this.
export const AWAIT_REPLY_MS = 60 * 60 * 1000;

let said = null;            // { text, at }
let awaitingSince = null;   // when the owner's unanswered message arrived
let facts = () => ({});     // server.js: { billion, workers, nextRoundAt }
let last = '';

export function setStatusFacts(fn) { facts = fn; }

// set_status. '' clears. { ok } or { error }.
export function setBillionStatus(text, now = Date.now()) {
  if (typeof text !== 'string') return { error: 'text must be a string ("" clears it).' };
  const body = text.replace(/\s+/g, ' ').trim();
  if (body.length > MAX_STATUS_CHARS) return { error: `The status is ${body.length} characters; keep it to ${MAX_STATUS_CHARS}.` };
  said = body ? { text: body, at: now } : null;
  return { ok: true, cleared: !body };
}

export function ownerAwaitsReply(now = Date.now()) { awaitingSince = now; }
export function billionReplied() { awaitingSince = null; }

export function statusPayload(now = Date.now()) {
  const { billion, workers = 0, nextRoundAt = null } = facts() || {};
  const running = !!billion && !billion.exited;
  return {
    type: 'billion-status',
    text: said && now - said.at < STATUS_TTL_MS ? said.text : '',
    running,
    working: running && billion.state === 'WORKING',
    workers,
    nextRoundAt,
    awaitingReply: running && awaitingSince !== null && now - awaitingSince < AWAIT_REPLY_MS,
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
  awaitingSince = null;
  facts = () => ({});
  last = '';
}
