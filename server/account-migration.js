// A permanent move from one Claude subscription to another, in place: the
// default Claude Code config keeps everything (conversations, settings,
// plugins, trusted folders) and only the login changes (docs/FEATURES.md,
// "Claude account"). Built but off: nothing here runs until the owner sets a
// folder up and presses Switch now or Arm in the browser. No board tool
// reaches it; the browser's WebSocket message is the only way in (server/ws.js
// says what that does and does not guarantee against a same-user process).
//
// Where a Claude Code login lives (read out of claude 2.1.283 itself, and
// checked against the real item on macOS on 2026-09-27, attributes only):
//  - the token: a Keychain generic password, service "Claude Code-credentials"
//    for the default folder and "Claude Code-credentials-<sha256(folder)[0:8]>"
//    for a CLAUDE_CONFIG_DIR, account attribute $USER; elsewhere the file
//    <folder>/.credentials.json. The CLI re-reads it every 30 seconds, so a
//    running worker picks a new token up by itself.
//  - the account: the oauthAccount block of the folder's .claude.json
//    (~/.claude.json for the default folder), plus a few caches its logout
//    clears too. Claude Code holds a `.claude.json.lock` directory while it
//    writes that file; the swap takes the same lock.
// `claude auth status --json` (loggedIn, email) is the check on both sides,
// and the token read back from the store must be the one written.
//
// The steps, each on its own: preflight, backup (0600, under
// ~/.agent-007/account-backup/<time>/), swap, verify, and on a failed verify
// the rollback runs by itself and is verified too. One action at a time. The
// new folder is never deleted: retire renames it, and only when the owner
// asks. Secrets are never logged: they pass between the `security` CLI (the
// token on its stdin, never in argv) or a file and memory, and nowhere else.

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { basename, dirname, join } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { resolveExecutable } from './command-path.js';
import { CONFIG_DIR } from './state.js';
import { expandHome, ptyEnv } from '../lib/helpers.js';

export const DEFAULT_SERVICE = 'Claude Code-credentials';
// oauthAccount is the account; the rest are per-account caches claude's own
// logout resets. Copied from the new folder when it has them, dropped when not.
export const ACCOUNT_FIELDS = ['oauthAccount', 'hasAvailableSubscription', 'subscriptionNoticeCount',
  'additionalModelOptionsCache', 'additionalModelOptionsAnsweredAt', 'additionalModelCostsCache'];
// 'switching' is written before the swap and replaced after it, so a server
// that died mid-swap shows as such and offers only Roll back; 'rollback failed'
// the same.
export const STATUSES = ['not set up', 'ready', 'armed', 'switching', 'migrated', 'rolled back', 'rollback failed'];
export const BUSY_ERROR = 'Another Claude account action is still running.';
const SECURITY = '/usr/bin/security';   // by path: a same-user shim earlier on PATH must not see the token
const RUN_TIMEOUT_MS = 15_000;
const WRITE_TRIES = 5;
const LOCK_STALE_MS = 10_000;           // Claude Code's own lock is stale after this (proper-lockfile's default)
const ACCT_RE = /^[a-zA-Z0-9._-]+$/;

// --- Where things are ---

// The Keychain service claude uses for a config folder (its JL(): default
// name without CLAUDE_CONFIG_DIR, else a hash of the folder as given, NFC).
export const keychainService = (folder) => (folder
  ? `${DEFAULT_SERVICE}-${createHash('sha256').update(String(folder).normalize('NFC')).digest('hex').slice(0, 8)}`
  : DEFAULT_SERVICE);

// The account attribute claude writes (its wk()).
export function keychainAccount(env = process.env) {
  let name;
  try { name = env.USER || userInfo().username; } catch { name = 'claude-code-user'; }
  return ACCT_RE.test(name || '') ? name : 'claude-code-user';
}

// The two logins: `folder` null means the default one, which is
// $CLAUDE_CONFIG_DIR when the server runs with it set, else ~/.claude with
// its .claude.json in $HOME.
export function loginOf(folder, { home = homedir(), env = process.env, platform = process.platform } = {}) {
  const dir = folder || env.CLAUDE_CONFIG_DIR || null;
  return {
    folder: dir || join(home, '.claude'),
    configJson: join(dir || home, '.claude.json'),
    service: platform === 'darwin' ? keychainService(dir) : null,
    credentialsFile: platform === 'darwin' ? null : join(dir || join(home, '.claude'), '.credentials.json'),
    env: dir ? { ...env, CLAUDE_CONFIG_DIR: dir } : env,
  };
}

export const stateFile = (dir = CONFIG_DIR) => join(dir, 'account-migration.json');
export function loadState(dir = CONFIG_DIR) {
  try {
    const s = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
    return STATUSES.includes(s?.status) ? s : { status: 'not set up' };
  } catch { return { status: 'not set up' }; }
}
export function saveState(state, dir = CONFIG_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(dir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}
export const isArmed = (dir = CONFIG_DIR) => loadState(dir).status === 'armed';

// --- Running things ---

// execFile as a promise that never throws: { code, stdout, stderr }. The child
// gets what an agent gets (lib/helpers.js ptyEnv): none of the server's own
// secrets. `input` goes to its stdin and is never part of the command line.
export function runCommand(file, args, { env = process.env, platform = process.platform, input } = {}) {
  const win = platform === 'win32';
  const exe = resolveExecutable(file, env, platform) || file;
  return new Promise((resolve) => {
    // A .cmd shim on Windows runs only through a shell; the path is quoted for one with spaces.
    const child = execFile(win ? `"${exe}"` : exe, args, { env: ptyEnv(env), timeout: RUN_TIMEOUT_MS, shell: win, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input ?? ''); }
  });
}

// { loggedIn, email } for a login, from `claude auth status --json`
// (exits 1 when logged out, with the same JSON).
export async function authStatus(login, { run = runCommand, platform = process.platform } = {}) {
  const { code, stdout } = await run('claude', ['auth', 'status', '--json'], { env: login.env, platform });
  try {
    const s = JSON.parse(stdout);
    return { loggedIn: s.loggedIn === true && code === 0, email: s.email ?? null };
  } catch { return { loggedIn: false, email: null, error: 'claude auth status printed no JSON' }; }
}

// The token store: Keychain on macOS, a 0600 file elsewhere. Every function
// returns or takes the secret as a string and never prints it. `locate()` is
// the item as claude itself looks it up (account $USER and the service), with
// a fallback by service alone for an item written under another account name.
function credentialStore(login, { run, platform, env = process.env }) {
  if (platform === 'darwin') {
    const svc = login.service;
    const sec = (args, input) => run(SECURITY, args, { env, platform, input });
    return {
      where: `Keychain item "${svc}"`,
      async locate() {
        const acct = keychainAccount(env);
        if ((await sec(['find-generic-password', '-a', acct, '-s', svc])).code === 0) return { acct };
        const { code, stdout } = await sec(['find-generic-password', '-s', svc]);
        const found = code === 0 ? /"acct"<blob>="([^"]*)"/.exec(stdout)?.[1] : null;
        return found && ACCT_RE.test(found) ? { acct: found } : null;
      },
      async read(acct) {
        const { code, stdout } = await sec(['find-generic-password', '-a', acct, '-s', svc, '-w']);
        return code === 0 ? stdout.replace(/\n$/, '') : null;
      },
      // -U updates the item in place. The command goes to `security -i` on
      // stdin, so the token is never on a command line `ps` could show; the
      // hex form (what claude writes) keeps quoting out of it.
      async write(secret, acct) {
        if (!ACCT_RE.test(acct)) throw new Error(`Keychain account attribute ${JSON.stringify(acct)} is not a plain name`);
        const line = `add-generic-password -U -a "${acct}" -s "${svc}" -X ${Buffer.from(secret, 'utf8').toString('hex')}\n`;
        const { code, stderr } = await sec(['-i'], line);
        if (code !== 0) throw new Error(`security add-generic-password failed (${code}): ${stderr.trim().slice(0, 200)}`);
      },
    };
  }
  const file = login.credentialsFile;
  return {
    where: file,
    async locate() { return existsSync(file) ? { acct: null } : null; },
    async read() { try { return readFileSync(file, 'utf8'); } catch { return null; } },
    async write(secret) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.agent007-${process.pid}.tmp`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, secret, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    },
  };
}

// --- .claude.json ---

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const readJson = (file) => { const d = JSON.parse(readFileSync(file, 'utf8')); if (!isRecord(d)) throw new Error(`${file} is not a JSON object`); return d; };
const pick = (data) => Object.fromEntries(ACCOUNT_FIELDS.filter(k => k in data).map(k => [k, data[k]]));

// Claude Code's lock on its config file: a `<file>.lock` directory, stale
// once its mtime is LOCK_STALE_MS old (it is left behind after a clean exit).
// Holding it keeps a claude from writing while we do; a fresh one that is not
// ours means a claude is mid-write, so we wait for it.
async function withConfigLock(file, wait, fn, { tries = WRITE_TRIES, now = Date.now } = {}) {
  const lock = `${file}.lock`;
  for (let i = 0; i < tries; i++) {
    try {
      mkdirSync(lock);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try { age = now() - statSync(lock).mtimeMs; } catch { continue; }   // gone between the two calls
      if (age > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; }
      await wait(100 * (i + 1));
      continue;
    }
    try { return await fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  throw new Error(`${file} is locked by Claude Code (${basename(lock)}); try again in a moment`);
}

// Replaces the account fields and nothing else: under Claude Code's lock, a
// temp file beside it, a rename, and a retry when the file changed between
// the read and the rename anyway (server/claude-trust.js has the pattern;
// here we own the change, so we try again instead of giving up).
export async function writeAccountFields(file, fields, { tries = WRITE_TRIES, wait = sleep, afterRead = null, now = Date.now } = {}) {
  let real = file;
  try { real = realpathSync(file); } catch {}
  const tmp = `${real}.agent007-${process.pid}.tmp`;
  return withConfigLock(real, wait, async () => {
    for (let i = 0; i < tries; i++) {
      const before = statSync(real);
      const data = readJson(real);
      afterRead?.(i);   // the tests' stand-in for Claude Code writing at this moment
      for (const k of ACCOUNT_FIELDS) { if (k in fields) data[k] = fields[k]; else delete data[k]; }
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: before.mode & 0o777 || 0o600, flag: 'wx' });
      const after = statSync(real);
      if (after.mtimeMs === before.mtimeMs && after.size === before.size && after.ino === before.ino) {
        renameSync(tmp, real);
        return true;
      }
      rmSync(tmp, { force: true });
      await wait(100 * (i + 1));
    }
    throw new Error(`${file} kept changing under us (${tries} tries); Claude Code may be writing it`);
  }, { tries, now });
}

// --- The steps ---

const email = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };
// One action at a time: two switches, or a switch and a rollback, interleaved
// would back up the wrong token.
let inFlight = null;
async function oneAtATime(fn) {
  if (inFlight) return { error: BUSY_ERROR };
  inFlight = fn();
  try { return await inFlight; } finally { inFlight = null; }
}

// Everything that must be true before anything is touched. Never reads a secret.
export async function preflight(folderInput, deps = {}) {
  const { home = homedir(), env = process.env, platform = process.platform, run = runCommand } = deps;
  // As typed, minus a trailing slash; the Keychain name is tried both ways
  // below, since claude hashed whatever CLAUDE_CONFIG_DIR said at login.
  const folder = expandHome(folderInput, home).replace(/(?<=.)[\\/]+$/, '');
  if (!folder || !/^[/\\]|^[A-Za-z]:[/\\]/.test(folder)) return { error: 'Give the new account\'s folder as an absolute path (the CLAUDE_CONFIG_DIR you logged in with).' };
  const current = loginOf(null, { home, env, platform });
  let next = loginOf(folder, { home, env, platform });
  if (realOr(next.folder) === realOr(current.folder)) return { error: `${folder} is the default Claude Code folder itself; the new account needs a folder of its own.` };
  if (!existsSync(folder)) return { error: `${folder} does not exist. Log the new account in there first: CLAUDE_CONFIG_DIR=${folder} claude, then /login.` };
  let data;
  try { data = readJson(next.configJson); } catch (err) { return { error: `${next.configJson}: ${err.message}` }; }
  const account = data.oauthAccount;
  if (!isRecord(account) || !email(account.emailAddress)) return { error: `${next.configJson} has no oauthAccount: that folder has not logged in.` };
  let store = credentialStore(next, { run, platform, env });
  if (!(await store.locate())) {
    const slashed = loginOf(`${folder}/`, { home, env, platform });
    const alt = credentialStore(slashed, { run, platform, env });
    if (!(await alt.locate())) return { error: `No token for ${folder}: ${store.where} is missing. Log in there again.` };
    [next, store] = [slashed, alt];
  }
  const [status, currentStatus] = await Promise.all([authStatus(next, { run, platform }), authStatus(current, { run, platform })]);
  if (!status.loggedIn) return { error: `claude auth status says ${folder} is not logged in.` };
  const newEmail = email(status.email || account.emailAddress);
  const oldEmail = email(currentStatus.email);
  if (!currentStatus.loggedIn || !oldEmail) return { error: 'The default Claude Code folder is not logged in, so there is nothing to move away from; log in there and try again.' };
  if (newEmail === oldEmail) return { error: `Both folders are logged in as ${newEmail}; the new folder must hold the other account.` };
  return { folder, newEmail, oldEmail, current, next, account: pick(data) };
}

// Backup, swap, verify; rollback on a failed verify. Returns
// { ok, oldEmail, newEmail, backupDir } or { error, rolledBack }.
export function migrate(folderInput, deps = {}) {
  return oneAtATime(() => migrateNow(folderInput, deps));
}
async function migrateNow(folderInput, deps) {
  const { home = homedir(), env = process.env, platform = process.platform, run = runCommand, dir = CONFIG_DIR, now = () => new Date(), log = console.log, wait } = deps;
  // A failure before the swap disarms: the next limit tick must take the
  // ordinary road to Codex, not run this again every ten seconds.
  const fail = (error) => {
    const state = loadState(dir);
    if (state.status === 'armed') saveState({ ...state, status: 'ready', error, at: now().toISOString() }, dir);
    log(`Claude account: switch not started: ${error}`);
    return { error };
  };
  const pre = await preflight(folderInput, { home, env, platform, run });
  if (pre.error) return fail(pre.error);
  const { current, next, newEmail, oldEmail, folder } = pre;
  const from = credentialStore(current, { run, platform, env });
  const to = credentialStore(next, { run, platform, env });

  // Backup: the current token and account fields, account.json first so a
  // half-written backup is never mistaken for a whole one.
  const item = await from.locate();
  if (!item) return fail(`Could not find the current token in ${from.where}; nothing changed.`);
  const oldSecret = await from.read(item.acct);
  if (oldSecret === null) return fail(`Could not read the current token from ${from.where}; nothing changed.`);
  let fields;
  try { fields = pick(readJson(current.configJson)); } catch (err) { return fail(`${current.configJson}: ${err.message}; nothing changed.`); }
  const backupDir = join(dir, 'account-backup', now().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(backupDir, 'account.json'), JSON.stringify({
    at: now().toISOString(), email: oldEmail, configJson: current.configJson, where: from.where, account: item.acct, fields,
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(backupDir, 'credentials'), oldSecret, { mode: 0o600 });
  log(`Claude account: backed up ${oldEmail}'s login to ${backupDir}`);
  const record = { folder, newEmail, oldEmail, backupDir };
  saveState({ ...record, status: 'switching', at: now().toISOString() }, dir);

  // Swap, then verify: the new email from claude, and the token read back is
  // the one written. Anything short of both puts the backup back.
  let failure = null;
  try {
    const newItem = await to.locate();
    const newSecret = newItem && await to.read(newItem.acct);
    if (newSecret === null || newSecret === undefined) throw new Error(`could not read the new token from ${to.where}`);
    await from.write(newSecret, item.acct);
    if ((await from.read(item.acct)) !== newSecret) throw new Error(`${from.where} does not hold the token just written`);
    await writeAccountFields(current.configJson, pre.account, { wait });
    const after = await authStatus(current, { run, platform });
    if (!after.loggedIn || email(after.email) !== newEmail) failure = `claude auth status reports ${after.email || 'no login'} after the swap, not ${newEmail}`;
  } catch (err) { failure = err.message; }

  if (failure) {
    const back = await restoreBackup(backupDir, { home, env, platform, run, wait });
    const rolledBack = !back.error;
    saveState({ ...record, status: rolledBack ? 'rolled back' : 'rollback failed', at: now().toISOString(), error: rolledBack ? failure : `${failure}; rollback failed: ${back.error}` }, dir);
    log(`Claude account: switch to ${newEmail} failed (${failure}); ${rolledBack ? 'rolled back to ' + oldEmail : 'ROLLBACK FAILED: ' + back.error}`);
    return { error: `${failure}. ${rolledBack ? `Rolled back to ${oldEmail}.` : `Rollback failed too (${back.error}); the backup is in ${backupDir}.`}`, rolledBack, backupDir };
  }
  saveState({ ...record, status: 'migrated', at: now().toISOString() }, dir);
  log(`Claude account: switched the default login from ${oldEmail} to ${newEmail}`);
  return { ok: true, oldEmail, newEmail, backupDir };
}

// Puts a backup's token and account fields back, and checks that claude sees
// the old email again. { ok, email } or { error }.
async function restoreBackup(backupDir, { home, env, platform, run, wait }) {
  try {
    const meta = readJson(join(backupDir, 'account.json'));
    const secret = readFileSync(join(backupDir, 'credentials'), 'utf8');
    const current = loginOf(null, { home, env, platform });
    const store = credentialStore(current, { run, platform, env });
    const acct = meta.account || keychainAccount(env);
    await store.write(secret, acct);
    if ((await store.read(acct)) !== secret) throw new Error(`${store.where} does not hold the restored token`);
    await writeAccountFields(current.configJson, meta.fields || {}, { wait });
    const after = await authStatus(current, { run, platform });
    if (!after.loggedIn || email(after.email) !== email(meta.email)) throw new Error(`claude auth status reports ${after.email || 'no login'} after the restore, not ${meta.email}`);
    return { ok: true, email: meta.email };
  } catch (err) { return { error: err.message }; }
}

// The owner's Roll back: the backup the state names (else the newest whole
// one) goes back, verified.
export function rollback(deps = {}) {
  return oneAtATime(async () => {
    const { home = homedir(), env = process.env, platform = process.platform, run = runCommand, dir = CONFIG_DIR, now = () => new Date(), log = console.log, wait } = deps;
    const state = loadState(dir);
    const backupDir = state.backupDir || latestBackup(dir);
    if (!backupDir) return { error: 'No backup to roll back to.' };
    const missing = ['account.json', 'credentials'].filter(f => !existsSync(join(backupDir, f)));
    if (missing.length) return { error: `The backup in ${backupDir} is incomplete: ${missing.join(' and ')} missing.` };
    const back = await restoreBackup(backupDir, { home, env, platform, run, wait });
    if (back.error) {
      saveState({ ...state, status: 'rollback failed', backupDir, at: now().toISOString(), error: back.error }, dir);
      return { error: `Rollback failed: ${back.error}` };
    }
    saveState({ ...state, status: 'rolled back', oldEmail: back.email, backupDir, at: now().toISOString(), error: undefined }, dir);
    log(`Claude account: rolled back to ${back.email}`);
    return { ok: true, email: back.email };
  });
}
function latestBackup(dir) {
  const root = join(dir, 'account-backup');
  try {
    const whole = readdirSync(root).filter(n => existsSync(join(root, n, 'account.json')) && existsSync(join(root, n, 'credentials'))).sort();
    return whole.length ? join(root, whole[whole.length - 1]) : null;
  } catch { return null; }
}

// Renames the migrated folder out of the way. Never deletes it.
export function retire(deps = {}) {
  const { dir = CONFIG_DIR, now = () => new Date(), log = console.log, rename = renameSync } = deps;
  if (inFlight) return { error: BUSY_ERROR };
  const state = loadState(dir);
  if (state.status !== 'migrated') return { error: 'Only a folder whose account has been switched to can be retired.' };
  if (state.retiredTo) return { error: `${state.folder} was already retired as ${state.retiredTo}.` };
  if (!existsSync(state.folder)) return { error: `${state.folder} is not there any more.` };
  const day = now().toISOString().slice(0, 10);
  let target = `${state.folder}.retired-${day}`;
  for (let n = 2; existsSync(target); n++) target = `${state.folder}.retired-${day}-${n}`;
  try { rename(state.folder, target); } catch (err) { return { error: `Could not rename ${state.folder}: ${err.message}` }; }
  saveState({ ...state, retiredTo: target, retiredAt: now().toISOString() }, dir);
  log(`Claude account: retired ${basename(state.folder)} as ${basename(target)}`);
  return { ok: true, retiredTo: target };
}

// The owner's setup: check a folder and remember it as ready (nothing armed).
export async function setup(folderInput, deps = {}) {
  const { dir = CONFIG_DIR, now = () => new Date() } = deps;
  if (inFlight) return { error: BUSY_ERROR };
  const pre = await preflight(folderInput, deps);
  if (pre.error) return { error: pre.error };
  return { ok: true, state: saveState({ status: 'ready', folder: pre.folder, newEmail: pre.newEmail, oldEmail: pre.oldEmail, at: now().toISOString() }, dir) };
}

// Arm (switch at the next hard usage limit on Billion's screen) or disarm.
export function setArmed(on, { dir = CONFIG_DIR } = {}) {
  const state = loadState(dir);
  if (on && state.status !== 'ready' && state.status !== 'armed') return { error: 'Set the new account\'s folder up first.' };
  if (!on && state.status !== 'armed') return { error: 'Nothing is armed.' };
  return { ok: true, state: saveState({ ...state, status: on ? 'armed' : 'ready' }, dir) };
}

// Whether a switch may start from this state: set up, and not already on the
// new account.
export function canMigrate(dir = CONFIG_DIR) {
  const { status, folder } = loadState(dir);
  if (!folder) return { error: 'Set the new account\'s folder up first.' };
  if (status === 'migrated') return { error: 'The default login is already the new account; roll back first if you want to switch again.' };
  if (status === 'switching' || status === 'rollback failed') return { error: 'The last switch did not finish cleanly; roll back first.' };
  return { ok: true, folder };
}

// What the browser shows. Never a secret, never a token: emails, dates, paths.
export function publicState(dir = CONFIG_DIR) {
  const { status, folder, newEmail, oldEmail, at, retiredTo, error } = loadState(dir);
  return { status, folder, newEmail, oldEmail, at, retiredTo, error };
}
