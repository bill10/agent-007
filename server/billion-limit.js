// Billion moving to the other CLI when its own runs out of usage
// (docs/BILLION.md, "Usage limits").
//
// Read off Billion's screen, on the wake loop's tick: the bottom few lines,
// where a CLI prints its limit notice, and only Billion's session. At a usage
// warning Billion is told once per threshold to bring STATE.md up to date; at
// a hard limit, once it has stopped printing, the server switches it to the
// other CLI (switchBillion: HANDOVER.md, the saved choice, a fresh start).
// It never switches back on a timer: the new CLI keeps Billion until it hits
// its own limit. If that happens within SWITCH_GAP_MS of the last switch, or
// the other CLI is missing or logged out, both are spent: Billion stays where
// it is and the owner is told, once, until a new Billion starts.
//
// An enabled account pool runs before the CLI fallback: Claude or Codex
// conversations resume on the next eligible login of the same CLI without a
// handover. Exhausted pools wait until reset/backoff, or let Billion hand over
// to the other CLI, picking an eligible login of that one first. The migration adapter
// remains only for an older installation that has not configured rotation.

import { execFile } from 'child_process';
import { screenTail, sendText } from './messages.js';
import { CLI_NAMES } from './billion-handover.js';
import { commandExists, commandPath } from './command-path.js';
import { envSwitchOn } from '../lib/helpers.js';

export const WARN_AT = [75, 90];            // used %: one nudge per threshold crossed
export const SWITCH_GAP_MS = 30 * 60_000;   // never two switches closer than this
export const SETTLE_MS = 5000;              // quiet this long before switching
const TAIL_LINES = 15;
const AUTH_TIMEOUT_MS = 10_000;

export const autoSwitchOn = (env = process.env) => envSwitchOn(env.BILLION_AUTO_SWITCH);

// Wording from Claude Code 2.1.283 and Codex 0.157. Whole phrases, not
// "limit" or "usage": Billion's screen is full of its own prose about the
// board. Claude Code draws with cursor moves, so the stripped text can lose
// its spaces: \s* between words.
const HARD = [
  // Claude Code: "You've hit your session limit · resets 3pm", weekly, Opus,
  // Fable, usage, monthly spend limit, team's shared budget. Codex: "You've
  // hit your usage limit. Upgrade to Plus…". Not fast mode's own limit.
  /You['’]?ve\s*hit\s*your(?!\s*fast)[\w'’ -]{0,30}?(?:limit|budget)/i,
  /You['’]?ve\s*reached\s*your\s*[\w -]{0,20}?limit/i,          // "You've reached your Fable limit"
  /You['’]?re\s*out\s*of\s*(?:usage\s*credits|extra\s*usage|credits)\b/i,
  /Your\s*workspace\s*is\s*out\s*of\s*credits/i,                      // Codex
  /You\s*hit\s*your\s*spend\s*cap/i,                                  // Codex
  /\b(?:Claude\s*usage|Usage)\s*limit\s*reached/,                     // older Claude Code; Codex
];
const WARN = [
  // Claude Code: "You've used 92% of your weekly limit · resets 10am (…)"
  { re: /You['’]?ve\s*used\s*(\d{1,3})%\s*of\s*your\s*([A-Za-z-]+(?:\s*limit)?)/i, used: (n) => n },
  // Codex: "Heads up, you have less than 25% of your weekly limit left."
  { re: /Heads\s*up,\s*you\s*have\s*less\s*than\s*(\d{1,3})%\s*of\s*your\s*([^%\n]{0,40}?)\s*limit\s*left/i, used: (n) => 100 - n },
];

// A notice the CLI printed, not one quoted in prose: Billion reading
// HANDOVER.md may well say `Claude Code said "You're out of usage credits"`.
// So not after a quote mark, a word and a space, or a markdown bullet or
// quote (a file read out, the owner's own "> " line). Glued straight onto
// the text before it is fine: that is a stripped repaint.
const NOT_QUOTED = String.raw`(?<![\w,:;\-*>][ \t]+|["'“‘\`][ \t]*)`;
const unquoted = (re) => new RegExp(NOT_QUOTED + re.source, re.flags);

// { kind: 'hard', line, retry } | { kind: 'warning', used, limit, line } | null.
// `limit` names which one, spaces dropped: a key, not for show. `retry` is the
// notice joined across the lines it wrapped onto, up to a blank line, for its
// reset time.
export function matchLimit(text) {
  const s = String(text ?? '');
  const lineAt = (i) => s.slice(i).split('\n')[0].trim().slice(0, 160);
  for (const re of HARD) {
    const m = unquoted(re).exec(s);
    if (m) return { kind: 'hard', line: lineAt(m.index), retry: s.slice(m.index, m.index + 400).split(/\n[ \t]*\n/)[0].replace(/\s+/g, ' ') };
  }
  for (const { re, used } of WARN) {
    const m = unquoted(re).exec(s);
    const n = m && Number(m[1]);
    if (m && n <= 100) return { kind: 'warning', used: used(n), limit: m[2].replace(/\s+/g, '').toLowerCase(), line: lineAt(m.index) };
  }
  return null;
}

// Whether `agent` can take over: installed, and logged in by its own quick
// non-interactive check (`claude auth status --json`, `codex login status`,
// which exits non-zero when logged out). Never a model call. false is a
// definite no; null means the check itself failed (timed out, no answer),
// which is falsy too, so a switch still waits for a definite yes.
export function cliReady(agent, { env = process.env, platform = process.platform } = {}) {
  if (!commandExists(agent, env, platform)) return Promise.resolve(false);
  const file = commandPath(agent, env, platform) || agent;   // the one commandExists found
  const args = agent === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
  return new Promise((resolve) => {
    // A .cmd shim on Windows runs only through a shell; the arguments are fixed.
    execFile(file, args, { timeout: AUTH_TIMEOUT_MS, shell: platform === 'win32', windowsHide: true }, (err, stdout) => {
      // A number is the CLI's own exit status; anything else is it not answering.
      const answered = !err || (typeof err.code === 'number' && !err.killed);
      if (agent === 'codex') return resolve(!answered ? null : !err);
      // claude prints its JSON either way, and exits 1 when logged out.
      let loggedIn;
      try { ({ loggedIn } = JSON.parse(stdout)); } catch {}
      resolve(answered && typeof loggedIn === 'boolean' ? loggedIn : null);
    });
  });
}

// toldFor: the session last told it is paused at both limits, until it rotates.
let watch = { switchAt: 0, pausedFor: null, toldFor: null, running: false };
export function resetLimitWatch(over = {}) { watch = { switchAt: 0, pausedFor: null, toldFor: null, running: false, ...over }; }

/**
 * One look at Billion's screen. Returns what it did: 'warned', 'switched',
 * 'paused', 'migrated', 'migration-failed' or null. The actions come in so
 * the tests need no CLI: switchTo(agent, reason), notify(text) (a Waiting
 * item, pushed to Telegram too), tell(text) (Telegram only), ready(agent) (cliReady),
 * and migration { armed(), run(hit) }: the owner's armed Claude account
 * switch, which needs no BILLION_AUTO_SWITCH and applies to a Claude Billion.
 * rotation and codexRotation { run, fallback, prepare } are the enabled
 * Claude and Codex account pools, or null.
 */
export async function limitTick(session, { now = Date.now(), env = process.env, send = sendText, ready = cliReady, switchTo, notify, tell, log = console.log, migration = null, rotation = null, codexRotation = null } = {}) {
  if (!session?.isBillion || session.exited || watch.running) return null;
  const agent = session.agent;
  const armed = agent === 'claude' && !!migration?.armed?.();
  const pool = { claude: rotation, codex: codexRotation }[agent] || null;
  if (!autoSwitchOn(env) && !armed && !pool) return null;
  const to = { claude: 'codex', codex: 'claude' }[agent];
  if (!to) return null;
  // The pool of the CLI a handover goes to: it picks a login first, and a
  // pause waiting on it is retried at its reset rather than held for good.
  const target = { claude: rotation, codex: codexRotation }[to] || null;
  const hit = matchLimit(screenTail(session.ringBuffer?.getAll().join('') || '', TAIL_LINES));
  if (!hit) return null;

  if (hit.kind === 'warning') {
    if (!autoSwitchOn(env)) return null;
    const step = WARN_AT.filter(p => hit.used >= p).pop();
    const key = `${hit.limit}:${step}`;
    if (step === undefined || session.limitWarned?.has(key)) return null;
    (session.limitWarned ||= new Set()).add(key);
    // Queued like mail, so it is typed only while Billion rests at its prompt.
    send(session, `Your ${CLI_NAMES[agent]} usage is at ${hit.used}%; bring STATE.md up to date and commit now, in case you're switched.`, now);
    return 'warned';
  }

  if ((rotation || codexRotation) && session.rotationRetryAt > now) return null;
  // Rotation cooldown is per login, not the CLI-switch gap. An exhausted
  // pool is checked again when its earliest known reset/backoff expires.
  if (pool) {
    if (session.state === 'WORKING' || now - (session.lastOutputAt || 0) < SETTLE_MS) return null;
    if (session.rotationRetryAt > now) return null;
    watch.running = true;
    try {
      const result = await pool.run(hit, { limited: !session.rotationMarked });
      if (!result?.busy) session.rotationMarked = true;
      if (result?.ok) { if (watch.toldFor === session.id) watch.toldFor = null; return 'rotated'; }
      if (result?.busy || result?.retry) return null;
      if (result?.error) {
        if (!session.rotationNotified) { session.rotationNotified = true; await notify(`${CLI_NAMES[agent]} account rotation paused: ${result.error}`); }
        session.rotationRetryAt = now + 30 * 60_000;
        return 'paused';
      }
      if (result?.exhausted) {
        // Only a pause waits for this pool's reset: a fallback goes on to the
        // handover now, whose own login check must not see this pool's wait.
        if (!pool.fallback() || !autoSwitchOn(env)) {
          session.rotationRetryAt = Number.isFinite(result.retryAt) ? result.retryAt : now + 30 * 60_000;
          if (!session.rotationNotified) { session.rotationNotified = true; await notify(`${CLI_NAMES[agent]} accounts are unavailable. Waiting for a usage reset before retrying.`); }
          return 'paused';
        }
      }
    } finally { watch.running = false; }
  }
  if (watch.pausedFor === session.id && !pool && !target) return null;
  if (session.state === 'WORKING' || now - (session.lastOutputAt || 0) < SETTLE_MS) return null;
  if (armed && !rotation) {
    // Once: run() disarms on any failure of its own (server/account-migration.js);
    // a busy server (another account action, Billion mid-switch) leaves it
    // armed for the next tick. A switch that cannot start leaves Billion and
    // its notice alone, so the next tick takes the ordinary road to Codex;
    // one that rolled back restarted Billion on the old account, which
    // prints the notice again.
    watch.running = true;
    try {
      const result = await migration.run(hit);
      log(`Billion: Claude account migration at the limit ("${hit.line}"): ${result?.error || 'switched to ' + result?.newEmail}`);
      return result?.error ? 'migration-failed' : 'migrated';
    } finally {
      watch.running = false;
    }
  }
  watch.running = true;
  try {
    const why = now - watch.switchAt < SWITCH_GAP_MS
      ? `${CLI_NAMES[agent]} hit its limit too, soon after the switch to it`
      : !(await ready(to, { env })) ? `${CLI_NAMES[to]} is not installed or not logged in` : null;
    if (why) {
      // With a pool on, the gap is what holds the next try (pausedFor does
      // not), and the owner hears of the pause once, not at every retry.
      if (pool || target) session.rotationRetryAt = now + SWITCH_GAP_MS;
      const told = watch.toldFor === session.id;
      watch.pausedFor = watch.toldFor = session.id;
      log(`Billion: paused on ${CLI_NAMES[agent]}: ${why} ("${hit.line}")`);
      if (!told) await notify(`Billion paused: both Claude Code and Codex are at their limits. ${why}; ${CLI_NAMES[agent]} says "${hit.line}". Billion stays on ${CLI_NAMES[agent]}. Press Start or the switch button next to Billion once either has usage again.`);
      return 'paused';
    }
    // A handover also selects an eligible login of the CLI taken over to.
    // Exhausted logins are never retried every tick.
    if (target) {
      if (session.rotationRetryAt > now) return null;
      const result = await target.prepare();
      if (!result?.ok) {
        session.rotationRetryAt = Number.isFinite(result?.retryAt) ? result.retryAt : now + 30 * 60_000;
        if (!session.rotationNotified) { session.rotationNotified = true; await notify(`${CLI_NAMES[agent]} and the selected ${CLI_NAMES[to]} accounts are unavailable. Waiting before retrying.`); }
        return 'paused';
      }
    }
    const reason = `${CLI_NAMES[agent]} hit its limit`;
    const result = await switchTo(to, reason);
    if (result?.error) {
      // Not retried every tick: the owner's switch button still works. With
      // an account pool on, pausedFor alone does not hold it, so wait the gap,
      // unless the switch only met another one in flight (busy).
      watch.pausedFor = session.id;
      if ((pool || target) && !result.busy) session.rotationRetryAt = now + SWITCH_GAP_MS;
      log(`Billion: could not switch to ${CLI_NAMES[to]}: ${result.error}`);
      return null;
    }
    watch.switchAt = now;
    log(`Billion: switched to ${CLI_NAMES[to]}: ${reason} ("${hit.line}")`);
    await tell(`Switched Billion to ${CLI_NAMES[to]}: ${reason}. HANDOVER.md written.`);
    return 'switched';
  } finally {
    watch.running = false;
  }
}
