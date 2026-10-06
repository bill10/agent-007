// Rounds: when the owner sees Billion's questions (docs/BILLION.md, "Rounds").
//
// The owner asked to be come to twice a day, not whenever a question occurs to
// Billion: notify_owner queues a question per project (the department), and at
// each round time the server releases the top few of each project and
// consolidates whatever the previous round left open (server/owner.js
// releaseRound). This module is the clock and the bookkeeping: the round times
// from config.json, the next and last round in the owner's time zone, and
// rounds.json (the last round released, its brief, a note waiting for Billion).
// Nothing here touches the questions themselves.

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR, config, PORT, parsePublicUrl } from './state.js';

export const DEFAULT_ROUNDS = ['08:30', '15:30'];
export const DEFAULT_MAX_PER_PROJECT = 2;
export const MAX_BRIEF_CHARS = 600;
const SLOT = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const validZone = (zone) => {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
};

// config.json: rounds (["08:30", "15:30"]; [] turns rounds off and questions
// show at once, as before), roundMaxPerProject (2), roundsTimeZone (an IANA
// name; the server's own zone when unset). Read on every call, so an edit
// applies at the next restart's loadConfig without anything cached here.
export function roundSettings(cfg = config) {
  const given = cfg?.rounds;
  let slots = DEFAULT_ROUNDS;
  if (Array.isArray(given)) {
    const valid = given.filter(s => typeof s === 'string' && SLOT.test(s.trim()))
      .map(s => s.trim().replace(/^(\d):/, '0$1:'));
    // [] is a choice (off); a list of nothing valid is a typo, so the default.
    slots = given.length === 0 ? [] : valid.length ? [...new Set(valid)].sort() : DEFAULT_ROUNDS;
  }
  const max = Number.isInteger(cfg?.roundMaxPerProject) && cfg.roundMaxPerProject >= 1 && cfg.roundMaxPerProject <= 10
    ? cfg.roundMaxPerProject : DEFAULT_MAX_PER_PROJECT;
  const timeZone = validZone(cfg?.roundsTimeZone) ? cfg.roundsTimeZone.trim() : undefined;
  return { on: slots.length > 0, slots, max, timeZone };
}

// --- Wall-clock time in the owner's zone ---

function wallParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find(p => p.type === type)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

// The zone's offset from UTC at that instant, in ms.
function offsetAt(ms, timeZone) {
  const p = wallParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time happens in the zone (the later reading across a DST jump).
function wallToUtc(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

// The slots of the day `days` after the wall date of `ms`, in time order.
function slotsOfDay(ms, days, slots, timeZone) {
  const p = wallParts(ms, timeZone);
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + days));
  const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
  return slots.map(slot => {
    const [h, mi] = slot.split(':').map(Number);
    return { at: wallToUtc(y, mo, d, h, mi, timeZone), slot, y, mo, d, h };
  });
}

const roundOf = ({ at, slot, y, mo, d, h }) => ({
  id: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${slot}`,
  at,
  // "10/1 am": what Billion and the round's heading call it.
  label: `${mo}/${d} ${h < 12 ? 'am' : 'pm'}`,
  name: h < 12 ? 'Morning briefing' : h < 17 ? 'Afternoon briefing' : 'Evening briefing',
});

// The first round strictly after `now`, or null with rounds off.
export function nextRound(now = Date.now(), settings = roundSettings()) {
  if (!settings.on) return null;
  for (let days = 0; days <= 2; days++) {
    const hit = slotsOfDay(now, days, settings.slots, settings.timeZone).find(s => s.at > now);
    if (hit) return roundOf(hit);
  }
  return null;
}

// The round the owner should expect next: the first after `now` and after
// the last one released, since a round the owner started early has already
// gone (its time is still ahead, so the clock alone would name it again).
export function comingRound(now = Date.now(), settings = roundSettings()) {
  return nextRound(Math.max(now, Date.parse(roundState().lastAt) || 0), settings);
}

// The latest round at or before `now`.
export function lastRound(now = Date.now(), settings = roundSettings()) {
  if (!settings.on) return null;
  for (let days = 0; days >= -2; days--) {
    const hit = slotsOfDay(now, days, settings.slots, settings.timeZone).reverse().find(s => s.at <= now);
    if (hit) return roundOf(hit);
  }
  return null;
}

// --- Which queued question goes first ---
//
// Blocking, normal, low; then Billion's rank (1 first; a ranked question
// before an unranked one); then the newest, since Billion's latest thinking
// is what it most wants answered.
const URGENCY_ORDER = { blocking: 0, normal: 1, low: 2 };
export function byPriority(a, b) {
  return (URGENCY_ORDER[a.urgency] ?? 1) - (URGENCY_ORDER[b.urgency] ?? 1)
    || (a.rank ?? Infinity) - (b.rank ?? Infinity)
    || String(b.at).localeCompare(String(a.at));
}

// --- rounds.json: { lastAt, current, brief, note, migratedAt } ---
//
// lastAt: the time of the last round released (ISO). current: that round,
// { id, label, name, at, brief }, which the tab shows. brief: what Billion set
// for the next round. note: a line for Billion that could not be typed yet.

const roundsPath = () => join(CONFIG_DIR, 'rounds.json');

export function roundState() {
  try {
    const state = JSON.parse(readFileSync(roundsPath(), 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

export function saveRoundState(state) {
  try {
    writeFileSync(`${roundsPath()}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${roundsPath()}.tmp`, roundsPath());
  } catch (err) {
    console.error('Could not save rounds.json:', err.message);
  }
}

// What the Billion tab draws above the round: the round on screen, when the
// next one is, and how many questions wait for it (a count only: what they
// are stays Billion's until a round shows them). queued comes from owner.js.
export function roundPayload(now = Date.now(), settings = roundSettings(), queued = 0) {
  const { current } = roundState();
  return {
    type: 'round-state',
    on: settings.on,
    max: settings.max,
    current: current || null,
    next: comingRound(now, settings),
    queued,
  };
}

// set_round_brief: up to MAX_BRIEF_CHARS shown at the top of a round. For the
// next round (kept until it is released) or the one on screen now. '' clears.
export function setRoundBrief(text, which = 'next') {
  const body = typeof text === 'string' ? text.trim() : '';
  if (typeof text !== 'string') return { error: 'text must be a string ("" clears the brief).' };
  if (body.length > MAX_BRIEF_CHARS) return { error: `The brief is ${body.length} characters; keep it to ${MAX_BRIEF_CHARS}.` };
  if (which !== 'next' && which !== 'current') return { error: 'round must be "next" or "current".' };
  const state = roundState();
  if (which === 'current') {
    if (!state.current) return { error: 'No briefing has been released yet; set the brief for the next one.' };
    state.current = { ...state.current, brief: body || undefined };
  } else {
    state.brief = body || undefined;
  }
  saveRoundState(state);
  return { ok: true, which, cleared: !body };
}

// Where a Telegram round message links to: PUBLIC_URL (APP_URL, its older
// name), else the first ALLOWED_ORIGINS entry (the address the owner's phone
// already uses), else none.
export function appLink(env = process.env) {
  const direct = parsePublicUrl(env.PUBLIC_URL) || (env.APP_URL || '').trim();
  if (direct) return direct;
  const first = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).find(s => s && s !== '*');
  if (!first) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `http://${first.includes(':') ? first : `${first}:${PORT}`}`;
}
