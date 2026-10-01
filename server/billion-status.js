// The Billion tab's status line and progress box: what Billion is doing, so a
// slow reply is never a blank screen (docs/BILLION.md, "Status line").
//
// Billion's own words come from set_status and fade after STATUS_TTL_MS
// without an update. The rest the server knows: whether Billion's terminal is
// mid-turn, the last few steps on its screen while it is, how many workers on
// its cards are running, when the next round is, and which of the owner's
// messages still wait for a reply (each until a tell_owner of its own, oldest
// first).

import { screenTail } from './messages.js';
import { redact } from './owner.js';

export const MAX_STATUS_CHARS = 140;
export const STATUS_TTL_MS = 30 * 60 * 1000;
// A reply that never comes (Billion answered in its terminal only) stops
// saying "working on your message" after this.
export const AWAIT_REPLY_MS = 60 * 60 * 1000;

let said = null;            // { text, at }
let awaiting = [];          // the owner's unanswered messages: { id, at }, oldest first
export const MAX_STEPS = 3;
const MAX_STEP_CHARS = 60;
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

const fresh = (now) => { awaiting = awaiting.filter(a => now - a.at < AWAIT_REPLY_MS); };

// id: the owner's chat message, which the tab shows as pending.
export function ownerAwaitsReply(id, now = Date.now()) {
  fresh(now);
  awaiting.push({ id: id ?? null, at: now });
}

// A tell_owner: it answers the oldest message still waiting, whose id it returns.
export function billionReplied(now = Date.now()) {
  fresh(now);
  return awaiting.shift()?.id ?? null;
}

// The steps Billion's CLI is taking, read off the end of its screen: Claude
// Code's "⏺ Bash(gh pr merge 178)" and Codex's "• Ran gh pr merge 178", as
// "Bash gh pr merge 178", newest last, each cut short. A summary of activity
// only: the owner sees it, so the token is redacted and nothing is kept.
export function screenSteps(raw, max = MAX_STEPS) {
  const steps = [];
  for (const line of screenTail(raw, 120).split('\n')) {
    const claude = line.match(/^\s*⏺\s+([A-Za-z][\w.-]*(?:\s-\s[\w.-]+)?)(?:\s*\(MCP\))?\((.*?)\)?\s*$/);
    const codex = line.match(/^\s*•\s+(Ran|Running|Edited|Explored|Read|Searched|Updated|Called)\s+(.*)$/);
    const hit = claude && claude[2] !== undefined ? [claude[1], claude[2]] : codex ? [codex[1], codex[2]] : null;
    if (!hit) continue;
    const step = redact(`${hit[0]} ${hit[1]}`).replace(/\s+/g, ' ').trim();
    steps.push(step.length > MAX_STEP_CHARS ? `${step.slice(0, MAX_STEP_CHARS - 1)}…` : step);
  }
  return [...new Set(steps)].slice(-max);
}

export function statusPayload(now = Date.now()) {
  const { billion, workers = 0, nextRoundAt = null } = facts() || {};
  const running = !!billion && !billion.exited;
  const working = running && billion.state === 'WORKING';
  fresh(now);
  const pending = running ? awaiting.map(a => a.id).filter(Boolean) : [];
  return {
    type: 'billion-status',
    text: said && now - said.at < STATUS_TTL_MS ? said.text : '',
    running,
    working,
    workers,
    nextRoundAt,
    awaitingReply: running && awaiting.length > 0,
    // The owner's messages shown as pending, and what the progress box lists.
    pending,
    steps: working && pending.length ? screenSteps(billion.ringBuffer?.getAll?.().join('') || '') : [],
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
  awaiting = [];
  facts = () => ({});
  last = '';
}
