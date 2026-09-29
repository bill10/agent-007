// Repeatable authentication-only rotation. The default Claude config remains
// the workspace; saved logins contain only credentials and account fields.
// Secrets never enter publicState(), notifications, or command arguments.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './state.js';
import { captureLogin, activateLogin, withAccountLock } from './account-migration.js';

export const RETRY_MS = 30 * 60_000;
const empty = () => ({ enabled: false, defaultSettings: true, fallback: true, active: null, accounts: [], pending: null });
const statePath = dir => join(dir, 'account-rotation.json');
const key = s => createHash('sha256').update([s.fields.oauthAccount.accountUuid || s.email, s.fields.oauthAccount.organizationUuid || ''].join(':')).digest('hex');
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
function writeJson(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
export function rotationState(dir = CONFIG_DIR) {
  if (!existsSync(statePath(dir))) return empty();
  try {
    const s = JSON.parse(readFileSync(statePath(dir), 'utf8'));
    if (!Array.isArray(s.accounts) || s.accounts.some(a => !validId(a.id))) throw new Error();
    // Older saved settings have no marker; preserve their existing on/off choice.
    return { ...empty(), defaultSettings: false, ...s };
  } catch { return { ...empty(), error: 'Account rotation state could not be read. Restore account-rotation.json before switching.', damaged: true }; }
}
function save(s, dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(statePath(dir), s);
}
function snapshotPath(dir, id) {
  if (!validId(id)) throw new Error('Invalid account identifier.');
  return join(dir, 'account-logins', `${id}.json`);
}
function remember(snapshot, dir) {
  const id = key(snapshot);
  mkdirSync(join(dir, 'account-logins'), { recursive: true, mode: 0o700 });
  writeJson(snapshotPath(dir, id), snapshot);
  return id;
}
function recall(id, dir) { return JSON.parse(readFileSync(snapshotPath(dir, id), 'utf8')); }
export function publicRotationState(dir = CONFIG_DIR, now = Date.now()) {
  const s = rotationState(dir);
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
const capture = (folder, deps) => (deps.capture || captureLogin)(folder, deps);
const activate = (s, deps) => (deps.activate || activateLogin)(s, deps);

export function addRotationAccount(folder, deps = {}) {
  const dir = deps.dir ?? CONFIG_DIR;
  return withAccountLock(async () => {
    const s = rotationState(dir);
    if (blocked(s)) return { error: blocked(s) };
    if (s.accounts.length >= 32) return { error: 'At most 32 accounts can be saved.' };
    // Capture the destination first so a bad folder never changes the registry.
    let incoming, current;
    try { incoming = await capture(folder, deps); current = await capture(null, deps); }
    catch { return { error: 'Could not read this login. Use an absolute Claude config folder path and sign in there first.' }; }
    const currentId = remember(current, dir);
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
      remember(incoming, dir);
      Object.assign(enroll(incoming, incomingId), { error: null, limitedUntil: 0 });
    }
    s.error = null;
    if (s.defaultSettings) s.enabled = s.accounts.filter(a => a.enabled).length >= 2;
    save(s, dir);
    return { ok: true };
  }, deps);
}

export function configureRotation(options, deps = {}) {
  const dir = deps.dir ?? CONFIG_DIR;
  return withAccountLock(async () => {
    const s = rotationState(dir);
    if (blocked(s)) return { error: blocked(s) };
    if (typeof options.enabled !== 'boolean' || typeof options.fallback !== 'boolean' || !Array.isArray(options.accounts)
      || options.accounts.length !== s.accounts.length || new Set(options.accounts.map(a => a.id)).size !== s.accounts.length
      || options.accounts.some(a => !s.accounts.some(b => b.id === a.id) || typeof a.enabled !== 'boolean')) return { error: 'Invalid rotation settings.' };
    const accounts = options.accounts.map(a => ({ ...s.accounts.find(b => b.id === a.id), enabled: a.enabled }));
    if (options.enabled && accounts.filter(a => a.enabled).length < 2) return { error: 'Select at least two Claude accounts for automatic rotation.' };
    save({ ...s, defaultSettings: false, enabled: options.enabled, fallback: options.fallback, accounts }, dir);
    return { ok: true };
  }, deps);
}

// Parse only unambiguous relative/ISO resets. Local clock labels without a
// timezone/date use bounded backoff instead of inventing a reset time.
export function retryAt(line, now) {
  const relative = /resets?\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(line || '');
  if (relative && (relative[1] || relative[2])) return now + Math.max(60_000, (Number(relative[1] || 0) * 60 + Number(relative[2] || 0)) * 60_000);
  const iso = /resets?\s+(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d))/i.exec(line || '');
  const at = iso && Date.parse(iso[1]);
  return at > now ? at : now + RETRY_MS;
}
export function nextRotationAccount(s, now = Date.now()) {
  const index = s.accounts.findIndex(a => a.id === s.active);
  for (let offset = 1; offset <= s.accounts.length; offset++) {
    const a = s.accounts[(index + offset) % s.accounts.length];
    if (a.id !== s.active && a.enabled && !a.error && !(a.limitedUntil > now)) return a;
  }
  return null;
}

// around(fn) stops/resumes managed Claude processes and holds their spawn gate.
// The cross-process auth lock also covers this lifecycle and the journal.
export function rotateAccount({ limited = false, line = '', id = null, allowCurrent = false, preferCurrent = false, around = fn => fn() } = {}, deps = {}) {
  const dir = deps.dir ?? CONFIG_DIR;
  return withAccountLock(async () => {
    const s = rotationState(dir), now = clock(deps);
    if (blocked(s)) return { error: blocked(s), blocked: true };
    if (!s.accounts.length) return { error: 'Add Claude accounts first.' };
    if (preferCurrent && !limited && !id && s.accounts.some(a => a.id === s.active && a.enabled && !a.error && !(a.limitedUntil > now))) {
      try {
        if (key(await capture(null, deps)) !== s.active) return { error: 'The default Claude login changed outside the app. Refresh accounts before rotating.', blocked: true };
      } catch { return { error: 'Could not verify the current Claude login.', blocked: true }; }
      return { ok: true, unchanged: true };
    }
    if (limited) {
      const a = s.accounts.find(a => a.id === s.active);
      if (a && !(a.limitedUntil > now)) a.limitedUntil = retryAt(line, now);
      save(s, dir);
    }
    let next = id ? s.accounts.find(a => a.id === id && a.id !== s.active) : nextRotationAccount(s, now);
    if (!next && allowCurrent && !limited) next = s.accounts.find(a => a.id === s.active && a.enabled && !a.error && !(a.limitedUntil > now));
    if (!next) return { exhausted: true, retryAt: Math.min(...s.accounts.filter(a => a.enabled && a.limitedUntil > now).map(a => a.limitedUntil)), fallback: s.fallback };
    return around(async () => {
      let current, target;
      try {
        current = await capture(null, deps);
        if (key(current) !== s.active) return { error: 'The default Claude login changed outside the app. Refresh accounts before rotating.', blocked: true };
        remember(current, dir); // latest refresh token, after all managed CLIs stop
        target = recall(next.id, dir);
      } catch { return { error: 'Could not save or read the login credentials. No account was switched.', blocked: true }; }
      s.pending = { from: s.active, to: next.id };
      save(s, dir); // recovery always has the refreshed previous login
      try {
        await activate(target, deps);
      } catch {
        next.error = 'Login could not be activated. Sign in again, then refresh accounts.';
        try { await activate(current, deps); s.pending = null; }
        catch { s.error = 'The switch and rollback failed. Restore the previous login before continuing.'; save(s, dir); return { error: s.error, blocked: true }; }
        s.error = 'The selected login failed; the previous login was restored.';
        save(s, dir);
        return { error: s.error, retry: true };
      }
      const oldEmail = current.email;
      s.active = next.id; s.pending = null; s.error = null; next.error = null; next.limitedUntil = 0;
      save(s, dir);
      return { ok: true, oldEmail, newEmail: next.email };
    });
  }, deps);
}

export function recoverRotation(around = fn => fn(), deps = {}) {
  const dir = deps.dir ?? CONFIG_DIR;
  return withAccountLock(async () => {
    const s = rotationState(dir);
    if (!s.pending || s.damaged) return { error: 'No interrupted rotation to restore.' };
    return around(async () => {
      try { await activate(recall(s.pending.from, dir), deps); }
      catch { return { error: 'Could not restore the previous login. The recovery record has been kept.' }; }
      s.active = s.pending.from; s.pending = null; s.enabled = false; s.defaultSettings = false; s.error = null;
      save(s, dir);
      return { ok: true };
    });
  }, deps);
}
