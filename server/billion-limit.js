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
// One thing comes before the switch: an armed Claude account migration
// (server/account-migration.js). At a Claude Billion's first hard limit it runs
// once, disarms, and Billion stays on Claude with the new account; only if it
// fails (and rolls back) does the next tick switch to Codex as usual.

import { execFile } from 'child_process';
import { screenTail, sendText } from './messages.js';
import { CLI_NAMES } from './billion-handover.js';
import { commandExists, resolveExecutable } from './command-path.js';
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

// { kind: 'hard', line } | { kind: 'warning', used, limit, line } | null.
// `limit` names which one, spaces dropped: a key, not for show.
export function matchLimit(text) {
  const s = String(text ?? '');
  const lineAt = (i) => s.slice(i).split('\n')[0].trim().slice(0, 160);
  for (const re of HARD) {
    const m = unquoted(re).exec(s);
    if (m) return { kind: 'hard', line: lineAt(m.index) };
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
// which exits non-zero when logged out). Never a model call.
export function cliReady(agent, { env = process.env, platform = process.platform } = {}) {
  if (!commandExists(agent, env, platform)) return Promise.resolve(false);
  const file = resolveExecutable(agent, env, platform) || agent;
  const args = agent === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
  return new Promise((resolve) => {
    // A .cmd shim on Windows runs only through a shell; the arguments are fixed.
    execFile(file, args, { timeout: AUTH_TIMEOUT_MS, shell: platform === 'win32', windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      if (agent === 'codex') return resolve(true);
      try { resolve(JSON.parse(stdout).loggedIn === true); } catch { resolve(false); }
    });
  });
}

let watch = { switchAt: 0, pausedFor: null, running: false };
export function resetLimitWatch(over = {}) { watch = { switchAt: 0, pausedFor: null, running: false, ...over }; }

/**
 * One look at Billion's screen. Returns what it did: 'warned', 'switched',
 * 'paused', 'migrated', 'migration-failed' or null. The actions come in so
 * the tests need no CLI: switchTo(agent, reason), notify(text) (a Waiting
 * item and Telegram), tell(text) (Telegram only), ready(agent) (cliReady),
 * and migration { armed(), run(hit) }: the owner's armed Claude account
 * switch, which needs no BILLION_AUTO_SWITCH and applies to a Claude Billion.
 */
export async function limitTick(session, { now = Date.now(), env = process.env, send = sendText, ready = cliReady, switchTo, notify, tell, log = console.log, migration = null } = {}) {
  if (!session?.isBillion || session.exited || watch.running) return null;
  const agent = session.agent;
  const armed = agent === 'claude' && !!migration?.armed?.();
  if (!autoSwitchOn(env) && !armed) return null;
  const to = { claude: 'codex', codex: 'claude' }[agent];
  if (!to) return null;
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

  if (watch.pausedFor === session.id) return null;
  if (session.state === 'WORKING' || now - (session.lastOutputAt || 0) < SETTLE_MS) return null;
  if (armed) {
    // Once: run() disarms whatever happens (server/account-migration.js). A
    // failure leaves the notice on screen, so the next tick takes the
    // ordinary road to Codex.
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
      watch.pausedFor = session.id;
      log(`Billion: paused on ${CLI_NAMES[agent]}: ${why} ("${hit.line}")`);
      await notify(`Billion paused: both Claude Code and Codex are at their limits. ${why}; ${CLI_NAMES[agent]} says "${hit.line}". Billion stays on ${CLI_NAMES[agent]}. Press Start or the switch button next to Billion once either has usage again.`);
      return 'paused';
    }
    const reason = `${CLI_NAMES[agent]} hit its limit`;
    const result = await switchTo(to, reason);
    if (result?.error) {
      // Not retried every tick: the owner's switch button still works.
      watch.pausedFor = session.id;
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
