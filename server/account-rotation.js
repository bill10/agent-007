// Repeatable authentication-only rotation. The default Claude config (or
// Codex home) remains the workspace; saved logins contain only credentials and
// account fields. One registry per CLI, picked by deps.cli ('claude' unless
// given): the Claude adapter is account-migration.js, the Codex one
// codex-login.js. Both share account-logins/ (a Codex id hashes a `codex:`
// prefix, so it never meets a Claude one) and the one account lock. Secrets never enter publicState(), notifications, or
// command arguments.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './state.js';
import { captureLogin, activateLogin, withAccountLock } from './account-migration.js';
import { captureCodexLogin, activateCodexLogin } from './codex-login.js';

export const RETRY_MS = 30 * 60_000;
const empty = () => ({ enabled: false, defaultSettings: true, fallback: true, active: null, accounts: [], pending: null });
const ADAPTERS = {
  claude: { name: 'Claude', file: 'account-rotation.json', capture: captureLogin, activate: activateLogin, folder: 'an absolute Claude config folder path',
    id: s => [s.fields.oauthAccount.accountUuid || s.email, s.fields.oauthAccount.organizationUuid || ''].join(':') },
  codex: { name: 'Codex', file: 'codex-account-rotation.json', capture: captureCodexLogin, activate: activateCodexLogin, folder: 'an absolute Codex home folder path',
    id: s => `codex:${s.accountId}` },
};
const adapter = cli => ADAPTERS[cli ?? 'claude'] || ADAPTERS.claude;
const statePath = (dir, cli) => join(dir, adapter(cli).file);
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
function writeJson(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
export function rotationState(dir = CONFIG_DIR, cli = 'claude') {
  if (!existsSync(statePath(dir, cli))) return empty();
  try {
    const s = JSON.parse(readFileSync(statePath(dir, cli), 'utf8'));
    if (!Array.isArray(s.accounts) || s.accounts.some(a => !validId(a.id))) throw new Error();
    // Older saved settings have no marker; preserve their existing on/off choice.
    return { ...empty(), defaultSettings: false, ...s };
  } catch { return { ...empty(), error: `Account rotation state could not be read. Restore ${adapter(cli).file} before switching.`, damaged: true }; }
}
function save(s, dir, cli) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(statePath(dir, cli), s);
}
function snapshotPath(dir, id) {
  if (!validId(id)) throw new Error('Invalid account identifier.');
  return join(dir, 'account-logins', `${id}.json`);
}
function remember(snapshot, dir, key) {
  const id = key(snapshot);
  mkdirSync(join(dir, 'account-logins'), { recursive: true, mode: 0o700 });
  writeJson(snapshotPath(dir, id), snapshot);
  return id;
}
function recall(id, dir) { return JSON.parse(readFileSync(snapshotPath(dir, id), 'utf8')); }
export function publicRotationState(dir = CONFIG_DIR, now = Date.now(), cli = 'claude') {
  const s = rotationState(dir, cli);
  return {
    enabled: s.enabled, defaultSettings: s.defaultSettings, fallback: s.fallback, active: s.active,
    pending: !!s.pending, error: s.error, damaged: !!s.damaged,
    accounts: s.accounts.map(({ id, email, folder, enabled, limitedUntil, error }) => ({
      id, email, folder, enabled, limitedUntil, error,
      status: id === s.active ? 'Active' : error ? 'Needs login' : limitedUntil > now ? 'Limited' : 'Available',
    })),
  };
}
const blocked = s => s.damaged ? s.error : s.pending ? 'An account switch was interrupted. Restore the previous login first.' : null;
const clock = deps => deps.now?.() ?? Date.now();
const capture = (folder, deps) => (deps.capture || adapter(deps.cli).capture)(folder, deps);
const activate = (s, deps) => (deps.activate || adapter(deps.cli).activate)(s, deps);
const keyFor = deps => s => createHash('sha256').update(adapter(deps.cli).id(s)).digest('hex');

export function addRotationAccount(folder, deps = {}) {
  const dir = deps.dir ?? CONFIG_DIR, { cli } = deps, key = keyFor(deps);
  return withAccountLock(async () => {
    const s = rotationState(dir, cli);
    if (blocked(s)) return { error: blocked(s) };
    if (s.accounts.length >= 32) return { error: 'At most 32 accounts can be saved.' };
    // Capture the destination first so a bad folder never changes the registry.
    let incoming, current;
    try { incoming = await capture(folder, deps); current = await capture(null, deps); }
    catch { return { error: `Could not read this login. Use ${adapter(cli).folder} and sign in there first.` }; }
    const currentId = remember(current, dir, key);
    const enroll = (snapshot, id) => {
      let account = s.accounts.find(a => a.id === id);
      if (!account) { account = { id, email: snapshot.email, folder: snapshot.folder, enabled: !s.enabled, limitedUntil: 0 }; s.accounts.push(account); }
      return account;
    };
    enroll(current, currentId);
    s.active = currentId;
    const incomingId = key(incoming);
    const existing = s.accounts.find(a => a.id === incomingId);
    // Refresh is discovery, not restoring a stale duplicate of a login whose
    // refresh token has moved forward in the default credential store.
    if (!existing || (existing.error && incomingId !== currentId)) {
      remember(incoming, dir, key);
      Object.assign(enroll(incoming, incomingId), { error: null, limitedUntil: 0 });
    }
    s.error = null;
    if (s.defaultSettings) s.enabled = s.accounts.filter(a => a.enabled).length >= 2;
    save(s, dir, cli);
    return { ok: true };
  }, deps);
}

export function configureRotation(options, deps = {}) {
  const dir = deps.dir ?? CONFIG_DIR, { cli } = deps;
  return withAccountLock(async () => {
    const s = rotationState(dir, cli);
    if (blocked(s)) return { error: blocked(s) };
    if (typeof options.enabled !== 'boolean' || typeof options.fallback !== 'boolean' || !Array.isArray(options.accounts)
      || options.accounts.length !== s.accounts.length || new Set(options.accounts.map(a => a.id)).size !== s.accounts.length
      || options.accounts.some(a => !s.accounts.some(b => b.id === a.id) || typeof a.enabled !== 'boolean')) return { error: 'Invalid rotation settings.' };
    const accounts = options.accounts.map(a => ({ ...s.accounts.find(b => b.id === a.id), enabled: a.enabled }));
    if (options.enabled && accounts.filter(a => a.enabled).length < 2) return { error: `Select at least two ${adapter(cli).name} accounts for automatic rotation.` };
    save({ ...s, defaultSettings: false, enabled: options.enabled, fallback: options.fallback, accounts }, dir, cli);
    return { ok: true };
  }, deps);
}

// Parse only unambiguous relative/ISO resets. Claude's local clock labels
// without a timezone/date use bounded backoff instead of inventing a reset
// time. Codex prints its reset in this machine's local time, with a date when
// it is not today: "try again at Oct 25th, 2025 3:15 PM", "at 3:15 PM", "in 2
// days 3 hours".
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function codexRetryAt(text, now) {
  const rel = /try\s*again\s*in\s*((?:\d+\s*(?:days?|d|hours?|h|minutes?|mins?|m)\b[\s,]*(?:and\s*)?)+)/i.exec(text);
  if (rel) {
    const unit = { d: 1440, h: 60, m: 1 };
    let minutes = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+)\s*([dhm])/gi)) minutes += Number(n) * unit[u.toLowerCase()];
    return minutes ? now + minutes * 60_000 : null;
  }
  const at = /try\s*again\s*at\s*(?:([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?)?,?\s*(?:(\d{1,2}):(\d\d)\s*([AP]M)?)?/i.exec(text);
  if (!at || (!at[1] && !at[4])) return null;
  const today = new Date(now), month = at[1] ? MONTHS.indexOf(at[1].toLowerCase()) : today.getMonth();
  if (month < 0) return null;
  let hour = at[4] ? Number(at[4]) % 12 + (/pm/i.test(at[6] || '') ? 12 : 0) : 0;
  if (at[4] && !at[6]) hour = Number(at[4]);
  const day = at[1] ? Number(at[2]) : today.getDate(), minute = at[5] ? Number(at[5]) : 0;
  let year = at[3] ? Number(at[3]) : today.getFullYear();
  let when = new Date(year, month, day, hour, minute).getTime();
  // No year: a date already well past is next year's; no date: a time already past is tomorrow's.
  if (!at[3] && at[1] && when < now - 86_400_000) when = new Date(++year, month, day, hour, minute).getTime();
  if (!at[1] && when <= now) when += 86_400_000;
  return when;
}
export function retryAt(line, now) {
  const relative = /resets?\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(line || '');
  if (relative && (relative[1] || relative[2])) return now + Math.max(60_000, (Number(relative[1] || 0) * 60 + Number(relative[2] || 0)) * 60_000);
  const iso = /resets?\s+(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d))/i.exec(line || '');
  const at = (iso && Date.parse(iso[1])) || codexRetryAt(line || '', now);
  return at > now ? Math.max(at, now + 60_000) : now + RETRY_MS;
}
export function nextRotationAccount(s, now = Date.now()) {
  const index = s.accounts.findIndex(a => a.id === s.active);
  for (let offset = 1; offset <= s.accounts.length; offset++) {
    const a = s.accounts[(index + offset) % s.accounts.length];
    if (a.id !== s.active && a.enabled && !a.error && !(a.limitedUntil > now)) return a;
  }
  return null;
}

// around(fn) stops/resumes the managed sessions of deps.cli and holds that CLI's spawn gate.
// The cross-process auth lock also covers this lifecycle and the journal.
export function rotateAccount({ limited = false, line = '', id = null, allowCurrent = false, preferCurrent = false, around = fn => fn() } = {}, deps = {}) {
  const dir = deps.dir ?? CONFIG_DIR, { cli } = deps, key = keyFor(deps), { name } = adapter(cli);
  const changed = `The default ${name} login changed outside the app. Refresh accounts before rotating.`;
  return withAccountLock(async () => {
    const s = rotationState(dir, cli), now = clock(deps);
    if (blocked(s)) return { error: blocked(s), blocked: true };
    if (!s.accounts.length) return { error: `Add ${name} accounts first.` };
    if (preferCurrent && !limited && !id && s.accounts.some(a => a.id === s.active && a.enabled && !a.error && !(a.limitedUntil > now))) {
      try {
        if (key(await capture(null, deps)) !== s.active) return { error: changed, blocked: true };
      } catch { return { error: `Could not verify the current ${name} login.`, blocked: true }; }
      return { ok: true, unchanged: true };
    }
    if (limited) {
      const a = s.accounts.find(a => a.id === s.active);
      if (a && !(a.limitedUntil > now)) a.limitedUntil = retryAt(line, now);
      save(s, dir, cli);
    }
    let next = id ? s.accounts.find(a => a.id === id && a.id !== s.active) : nextRotationAccount(s, now);
    if (!next && allowCurrent && !limited) next = s.accounts.find(a => a.id === s.active && a.enabled && !a.error && !(a.limitedUntil > now));
    if (!next) return { exhausted: true, retryAt: Math.min(...s.accounts.filter(a => a.enabled && a.limitedUntil > now).map(a => a.limitedUntil)), fallback: s.fallback };
    return around(async () => {
      let current, target;
      try {
        current = await capture(null, deps);
        if (key(current) !== s.active) return { error: changed, blocked: true };
        remember(current, dir, key); // latest refresh token, after all managed CLIs stop
        target = recall(next.id, dir);
      } catch { return { error: 'Could not save or read the login credentials. No account was switched.', blocked: true }; }
      s.pending = { from: s.active, to: next.id };
      save(s, dir, cli); // recovery always has the refreshed previous login
      try {
        await activate(target, deps);
      } catch {
        next.error = 'Login could not be activated. Sign in again, then refresh accounts.';
        try { await activate(current, deps); s.pending = null; }
        catch { s.error = 'The switch and rollback failed. Restore the previous login before continuing.'; save(s, dir, cli); return { error: s.error, blocked: true }; }
        s.error = 'The selected login failed; the previous login was restored.';
        save(s, dir, cli);
        return { error: s.error, retry: true };
      }
      const oldEmail = current.email;
      s.active = next.id; s.pending = null; s.error = null; next.error = null; next.limitedUntil = 0;
      save(s, dir, cli);
      return { ok: true, oldEmail, newEmail: next.email };
    });
  }, deps);
}

export function recoverRotation(around = fn => fn(), deps = {}) {
  const dir = deps.dir ?? CONFIG_DIR, { cli } = deps;
  return withAccountLock(async () => {
    const s = rotationState(dir, cli);
    if (!s.pending || s.damaged) return { error: 'No interrupted rotation to restore.' };
    return around(async () => {
      try { await activate(recall(s.pending.from, dir), deps); }
      catch { return { error: 'Could not restore the previous login. The recovery record has been kept.' }; }
      s.active = s.pending.from; s.pending = null; s.enabled = false; s.defaultSettings = false; s.error = null;
      save(s, dir, cli);
      return { ok: true };
    });
  }, deps);
}
