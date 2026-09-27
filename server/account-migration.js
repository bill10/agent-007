// A permanent move from one Claude subscription to another, in place: the
// default Claude Code config keeps everything (conversations, settings,
// plugins, trusted folders) and only the login changes (docs/FEATURES.md,
// "Claude account"). Built but off: nothing here runs until the owner sets a
// folder up and presses Switch now or Arm in the browser. Billion has no tool
// that reaches it.
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
//    clears too.
// `claude auth status --json` (loggedIn, email) is the check on both sides.
//
// The steps, each on its own: preflight, backup (0600, under
// ~/.agent-007/account-backup/<time>/), swap, verify, and on a failed verify
// the rollback runs by itself. The new folder is never deleted: retire renames
// it, and only when the owner asks. Secrets are never logged: they pass from
// the `security` CLI (argv arrays, no shell) or a file into memory and back.

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { basename, dirname, join } from 'path';
import { resolveExecutable } from './command-path.js';
import { CONFIG_DIR } from './state.js';
import { expandHome, ptyEnv } from '../lib/helpers.js';

export const DEFAULT_SERVICE = 'Claude Code-credentials';
// oauthAccount is the account; the rest are per-account caches claude's own
// logout resets. Copied from the new folder when it has them, dropped when not.
export const ACCOUNT_FIELDS = ['oauthAccount', 'hasAvailableSubscription', 'subscriptionNoticeCount',
  'additionalModelOptionsCache', 'additionalModelOptionsAnsweredAt', 'additionalModelCostsCache'];
export const STATUSES = ['not set up', 'ready', 'armed', 'migrated', 'rolled back'];
const RUN_TIMEOUT_MS = 15_000;
const WRITE_TRIES = 5;

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
  return /^[a-zA-Z0-9._-]+$/.test(name || '') ? name : 'claude-code-user';
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
// gets what an agent gets (lib/helpers.js ptyEnv): none of the server's own secrets.
export function runCommand(file, args, { env = process.env, platform = process.platform } = {}) {
  const exe = resolveExecutable(file, env, platform) || file;
  return new Promise((resolve) => {
    execFile(exe, args, { env: ptyEnv(env), timeout: RUN_TIMEOUT_MS, shell: platform === 'win32', windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
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
// returns or takes the secret as a string and never prints it.
function credentialStore(login, { run, platform, env = process.env }) {
  if (platform === 'darwin') {
    const svc = login.service;
    return {
      where: `Keychain item "${svc}"`,
      async exists() { return (await run('security', ['find-generic-password', '-s', svc], { env, platform })).code === 0; },
      async account() {
        const { stdout } = await run('security', ['find-generic-password', '-s', svc], { env, platform });
        return /"acct"<blob>="([^"]*)"/.exec(stdout)?.[1] ?? null;
      },
      async read() {
        const { code, stdout } = await run('security', ['find-generic-password', '-s', svc, '-w'], { env, platform });
        return code === 0 ? stdout.replace(/\n$/, '') : null;
      },
      // -U updates the item in place; the hex form is what claude writes and
      // keeps any quoting out of it.
      async write(secret, account) {
        const { code, stderr } = await run('security', ['add-generic-password', '-U', '-a', account, '-s', svc, '-X', Buffer.from(secret, 'utf8').toString('hex')], { env, platform });
        if (code !== 0) throw new Error(`security add-generic-password failed (${code}): ${stderr.trim().slice(0, 200)}`);
      },
    };
  }
  const file = login.credentialsFile;
  return {
    where: file,
    async exists() { return existsSync(file); },
    async account() { return null; },
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick = (data) => Object.fromEntries(ACCOUNT_FIELDS.filter(k => k in data).map(k => [k, data[k]]));

// Replaces the account fields and nothing else: temp file beside it, rename,
// and a retry when Claude Code wrote the file meanwhile (server/claude-trust.js
// has the pattern; here we own the change, so we try again instead of giving up).
export async function writeAccountFields(file, fields, { tries = WRITE_TRIES, wait = sleep, afterRead = null } = {}) {
  let real = file;
  try { real = realpathSync(file); } catch {}
  const tmp = `${real}.agent007-${process.pid}.tmp`;
  for (let i = 0; i < tries; i++) {
    const before = statSync(real);
    const data = readJson(real);
    afterRead?.(i);   // the tests' stand-in for Claude Code writing at this moment
    for (const k of ACCOUNT_FIELDS) { if (k in fields) data[k] = fields[k]; else delete data[k]; }
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: before.mode & 0o777 || 0o600, flag: 'wx' });
    const now = statSync(real);
    if (now.mtimeMs === before.mtimeMs && now.size === before.size && now.ino === before.ino) {
      renameSync(tmp, real);
      return true;
    }
    rmSync(tmp, { force: true });
    await wait(100 * (i + 1));
  }
  throw new Error(`${file} kept changing under us (${tries} tries); Claude Code may be writing it`);
}

// --- The steps ---

const email = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

// Everything that must be true before anything is touched. Never reads a secret.
export async function preflight(folderInput, deps = {}) {
  const { home = homedir(), env = process.env, platform = process.platform, run = runCommand } = deps;
  const folder = expandHome(folderInput, home);
  if (!folder || !/^[/\\]|^[A-Za-z]:[/\\]/.test(folder)) return { error: 'Give the new account\'s folder as an absolute path (the CLAUDE_CONFIG_DIR you logged in with).' };
  const current = loginOf(null, { home, env, platform });
  const next = loginOf(folder, { home, env, platform });
  if (realOr(next.folder) === realOr(current.folder)) return { error: `${folder} is the default Claude Code folder itself; the new account needs a folder of its own.` };
  if (!existsSync(folder)) return { error: `${folder} does not exist. Log the new account in there first: CLAUDE_CONFIG_DIR=${folder} claude, then /login.` };
  let account;
  try { account = readJson(next.configJson).oauthAccount; } catch (err) { return { error: `${next.configJson}: ${err.message}` }; }
  if (!isRecord(account) || !email(account.emailAddress)) return { error: `${next.configJson} has no oauthAccount: that folder has not logged in.` };
  const store = credentialStore(next, { run, platform, env });
  if (!(await store.exists())) return { error: `No token for ${folder}: ${store.where} is missing. Log in there again.` };
  const [status, currentStatus] = await Promise.all([authStatus(next, { run, platform }), authStatus(current, { run, platform })]);
  if (!status.loggedIn) return { error: `claude auth status says ${folder} is not logged in.` };
  const newEmail = email(status.email || account.emailAddress);
  const oldEmail = email(currentStatus.email);
  if (!currentStatus.loggedIn || !oldEmail) return { error: 'The default Claude Code folder is not logged in, so there is nothing to move away from; log in there and try again.' };
  if (newEmail === oldEmail) return { error: `Both folders are logged in as ${newEmail}; the new folder must hold the other account.` };
  return { folder, newEmail, oldEmail, current, next, account: pick(readJson(next.configJson)) };
}
const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };

// Backup, swap, verify; rollback on a failed verify. Returns
// { ok, oldEmail, newEmail, backupDir } or { error, rolledBack }.
export async function migrate(folderInput, deps = {}) {
  const { home = homedir(), env = process.env, platform = process.platform, run = runCommand, dir = CONFIG_DIR, now = () => new Date(), log = console.log, wait } = deps;
  const pre = await preflight(folderInput, { home, env, platform, run });
  if (pre.error) return { error: pre.error };
  const { current, next, newEmail, oldEmail, folder } = pre;
  const from = credentialStore(current, { run, platform, env });
  const to = credentialStore(next, { run, platform, env });

  // Backup. The account attribute is the default item's own, so the swap
  // updates that item rather than adding a second one under the service.
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(dir, 'account-backup', stamp);
  const oldSecret = await from.read();
  if (oldSecret === null) return { error: `Could not read the current token from ${from.where}; nothing changed.` };
  const account = (await from.account()) || keychainAccount(env);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(backupDir, 'credentials'), oldSecret, { mode: 0o600 });
  writeFileSync(join(backupDir, 'account.json'), JSON.stringify({
    at: now().toISOString(), email: oldEmail, configJson: current.configJson, where: from.where, account,
    fields: pick(readJson(current.configJson)),
  }, null, 2), { mode: 0o600 });
  log(`Claude account: backed up ${oldEmail}'s login to ${backupDir}`);

  // Swap, then verify; anything short of the new email puts the backup back.
  let failure = null;
  try {
    const newSecret = await to.read();
    if (newSecret === null) throw new Error(`could not read the new token from ${to.where}`);
    await from.write(newSecret, account);
    await writeAccountFields(current.configJson, pre.account, { wait });
    const after = await authStatus(current, { run, platform });
    if (!after.loggedIn || email(after.email) !== newEmail) failure = `claude auth status reports ${after.email || 'no login'} after the swap, not ${newEmail}`;
  } catch (err) { failure = err.message; }

  if (failure) {
    const back = await restoreBackup(backupDir, { home, env, platform, run, wait });
    const rolledBack = !back.error;
    saveState({ status: rolledBack ? 'rolled back' : 'ready', folder, newEmail, oldEmail, backupDir, at: now().toISOString(), error: failure }, dir);
    log(`Claude account: switch to ${newEmail} failed (${failure}); ${rolledBack ? 'rolled back to ' + oldEmail : 'ROLLBACK FAILED: ' + back.error}`);
    return { error: `${failure}. ${rolledBack ? `Rolled back to ${oldEmail}.` : `Rollback failed too (${back.error}); the backup is in ${backupDir}.`}`, rolledBack, backupDir };
  }
  saveState({ status: 'migrated', folder, newEmail, oldEmail, backupDir, at: now().toISOString() }, dir);
  log(`Claude account: switched the default login from ${oldEmail} to ${newEmail}`);
  return { ok: true, oldEmail, newEmail, backupDir };
}

// Puts a backup's token and account fields back. No verify: rollback() does that.
async function restoreBackup(backupDir, { home, env, platform, run, wait }) {
  try {
    const meta = readJson(join(backupDir, 'account.json'));
    const secret = readFileSync(join(backupDir, 'credentials'), 'utf8');
    const current = loginOf(null, { home, env, platform });
    await credentialStore(current, { run, platform, env }).write(secret, meta.account || keychainAccount(env));
    await writeAccountFields(current.configJson, meta.fields || {}, { wait });
    return { ok: true, email: meta.email };
  } catch (err) { return { error: err.message }; }
}

// The owner's Roll back: the newest backup (or the one the state names) goes
// back, and the old email must show again.
export async function rollback(deps = {}) {
  const { home = homedir(), env = process.env, platform = process.platform, run = runCommand, dir = CONFIG_DIR, now = () => new Date(), log = console.log, wait } = deps;
  const state = loadState(dir);
  const backupDir = state.backupDir || latestBackup(dir);
  if (!backupDir || !existsSync(join(backupDir, 'account.json'))) return { error: 'No backup to roll back to.' };
  const back = await restoreBackup(backupDir, { home, env, platform, run, wait });
  if (back.error) return { error: `Rollback failed: ${back.error}` };
  const after = await authStatus(loginOf(null, { home, env, platform }), { run, platform });
  if (!after.loggedIn || email(after.email) !== email(back.email)) return { error: `Restored the backup, but claude auth status reports ${after.email || 'no login'}, not ${back.email}.` };
  saveState({ ...state, status: 'rolled back', oldEmail: back.email, at: now().toISOString(), backupDir }, dir);
  log(`Claude account: rolled back to ${back.email}`);
  return { ok: true, email: back.email };
}
function latestBackup(dir) {
  const root = join(dir, 'account-backup');
  try {
    const names = readdirSync(root).sort();
    return names.length ? join(root, names[names.length - 1]) : null;
  } catch { return null; }
}

// Renames the migrated folder out of the way. Never deletes it.
export function retire(deps = {}) {
  const { dir = CONFIG_DIR, now = () => new Date(), log = console.log, rename = renameSync } = deps;
  const state = loadState(dir);
  if (state.status !== 'migrated') return { error: 'Only a folder whose account has been switched to can be retired.' };
  if (!existsSync(state.folder)) return { error: `${state.folder} is not there any more.` };
  const day = now().toISOString().slice(0, 10);
  let target = `${state.folder}.retired-${day}`;
  for (let n = 2; existsSync(target); n++) target = `${state.folder}.retired-${day}-${n}`;
  rename(state.folder, target);
  saveState({ ...state, retiredTo: target, retiredAt: now().toISOString() }, dir);
  log(`Claude account: retired ${basename(state.folder)} as ${basename(target)}`);
  return { ok: true, retiredTo: target };
}

// The owner's setup: check a folder and remember it as ready (nothing armed).
export async function setup(folderInput, deps = {}) {
  const { dir = CONFIG_DIR, now = () => new Date() } = deps;
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

// What the browser shows. Never a secret, never a token: emails, dates, paths.
export function publicState(dir = CONFIG_DIR) {
  const { status, folder, newEmail, oldEmail, at, retiredTo, error } = loadState(dir);
  return { status, folder, newEmail, oldEmail, at, retiredTo, error };
}
