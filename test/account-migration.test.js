// The owner's permanent Claude account switch (server/account-migration.js).
// Everything runs against a scratch home and a fake `security` / `claude`:
// the real Keychain, ~/.claude and ~/.claude.json are never touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import {
  preflight, migrate, rollback, retire, setup, setArmed, isArmed, loadState, publicState, authStatus,
  keychainService, keychainAccount, loginOf, writeAccountFields, DEFAULT_SERVICE, ACCOUNT_FIELDS,
} from '../server/account-migration.js';
import { limitTick, resetLimitWatch, SETTLE_MS } from '../server/billion-limit.js';

const OLD = 'old@example.com', NEW = 'new@example.com';
const OLD_TOKEN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-OLD","refreshToken":"sk-ant-ort01-OLD"}}';
const NEW_TOKEN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-NEW","refreshToken":"sk-ant-ort01-NEW"}}';

let home, dir, newDir, keychain, calls, env, deps;

// A fake `security` over an in-memory Keychain and a fake `claude auth status
// --json` that answers as the real one does: logged in when the folder's
// .claude.json has an oauthAccount and its token exists, email from that block.
function fakeRun(over = {}) {
  return vi.fn(async (file, args, opts = {}) => {
    calls.push([file, ...args]);
    if (file === 'security') {
      const svc = args[args.indexOf('-s') + 1];
      const item = keychain.get(svc);
      if (args[0] === 'find-generic-password') {
        if (!item) return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
        return args.includes('-w')
          ? { code: 0, stdout: `${item.secret}\n`, stderr: '' }
          : { code: 0, stdout: `keychain: "login"\nclass: "genp"\nattributes:\n    "acct"<blob>="${item.acct}"\n    "svce"<blob>="${svc}"\n`, stderr: '' };
      }
      if (args[0] === 'add-generic-password') {
        if (over.writeFails) return { code: 1, stdout: '', stderr: 'boom' };
        const acct = args[args.indexOf('-a') + 1];
        const secret = Buffer.from(args[args.indexOf('-X') + 1], 'hex').toString('utf8');
        // -U updates the item with this account and service; another account would be a second item.
        if (item && item.acct !== acct) keychain.set(`${svc}@${acct}`, { acct, secret });
        else keychain.set(svc, { acct, secret });
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    if (file === 'claude') {
      const folder = opts.env?.CLAUDE_CONFIG_DIR;
      const login = loginOf(folder || null, { home, env: opts.env || env, platform: 'darwin' });
      let account = null;
      try { account = JSON.parse(readFileSync(login.configJson, 'utf8')).oauthAccount; } catch {}
      const item = keychain.get(login.service);
      const loggedIn = !!(account && item) && !over.loggedOut?.(folder);
      const email = over.reportEmail ? over.reportEmail(folder, account) : account?.emailAddress ?? null;
      const s = { loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', configDirectory: login.folder, ...(loggedIn ? { email } : {}) };
      return { code: loggedIn ? 0 : 1, stdout: JSON.stringify(s, null, 2), stderr: '' };
    }
    return { code: 127, stdout: '', stderr: `no ${file}` };
  });
}

const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const defaultJson = () => join(home, '.claude.json');

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'acct-home-')));
  dir = join(home, '.agent-007');
  newDir = join(home, '.claude-new');
  mkdirSync(join(home, '.claude'));
  mkdirSync(newDir);
  writeFileSync(defaultJson(), JSON.stringify({
    numStartups: 40, theme: 'dark', oauthAccount: { accountUuid: 'a-old', emailAddress: OLD, organizationName: 'Old org' },
    hasAvailableSubscription: true, projects: { '/x': { hasTrustDialogAccepted: true } }, userID: 'u1',
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(newDir, '.claude.json'), JSON.stringify({
    numStartups: 1, oauthAccount: { accountUuid: 'a-new', emailAddress: NEW, organizationName: 'New org' },
  }, null, 2), { mode: 0o600 });
  keychain = new Map([
    [DEFAULT_SERVICE, { acct: 'bill', secret: OLD_TOKEN }],
    [keychainService(newDir), { acct: 'bill', secret: NEW_TOKEN }],
  ]);
  calls = [];
  env = { USER: 'bill', PATH: '/usr/bin' };
  deps = { home, env, platform: 'darwin', dir, run: fakeRun(), log: () => {}, wait: async () => {}, now: () => new Date('2026-09-27T10:00:00Z') };
  resetLimitWatch();
});

describe('where a login lives', () => {
  it('names the Keychain item as claude 2.1.283 does', () => {
    expect(keychainService(null)).toBe('Claude Code-credentials');
    expect(keychainService('/Users/x/.claude-new')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(keychainService('/Users/x/.claude-new')).not.toBe(keychainService('/Users/x/.claude-new/'));
    expect(keychainAccount({ USER: 'bill' })).toBe('bill');
    expect(keychainAccount({ USER: 'bad user!' })).toBe('claude-code-user');
    // NFC: a folder typed with a combining accent hashes like the composed one.
    expect(keychainService('/Users/x/café')).toBe(keychainService('/Users/x/café'));
    // No USER in the env: the process's own username, as claude does.
    expect(keychainAccount({})).toBe(/^[a-zA-Z0-9._-]+$/.test(userInfo().username) ? userInfo().username : 'claude-code-user');
  });

  it('the default folder follows CLAUDE_CONFIG_DIR when the server has it, and Linux uses a file', () => {
    expect(loginOf(null, { home, env: {}, platform: 'darwin' })).toMatchObject({ folder: join(home, '.claude'), configJson: defaultJson(), service: DEFAULT_SERVICE, credentialsFile: null });
    const moved = loginOf(null, { home, env: { CLAUDE_CONFIG_DIR: '/cfg' }, platform: 'darwin' });
    expect(moved).toMatchObject({ folder: '/cfg', configJson: '/cfg/.claude.json', service: keychainService('/cfg') });
    expect(moved.env.CLAUDE_CONFIG_DIR).toBe('/cfg');
    const linux = loginOf(newDir, { home, env: {}, platform: 'linux' });
    expect(linux).toMatchObject({ service: null, credentialsFile: join(newDir, '.credentials.json'), configJson: join(newDir, '.claude.json') });
    expect(linux.env.CLAUDE_CONFIG_DIR).toBe(newDir);
  });
});

describe('preflight', () => {
  it('passes with the emails of both accounts and reads no secret', async () => {
    const pre = await preflight('~/.claude-new', deps);
    expect(pre).toMatchObject({ folder: newDir, newEmail: NEW, oldEmail: OLD });
    expect(calls.some(c => c.includes('-w'))).toBe(false);
    expect(calls).toContainEqual(['claude', 'auth', 'status', '--json']);
    expect(deps.run.mock.calls.find(([f, , o]) => f === 'claude' && o.env.CLAUDE_CONFIG_DIR === newDir)).toBeTruthy();
  });

  it('refuses a relative path, a missing folder, the default folder, no login, no token, logged out, and the same account', async () => {
    expect((await preflight('claude-new', deps)).error).toMatch(/absolute path/);
    expect((await preflight(join(home, 'nope'), deps)).error).toMatch(/does not exist/);
    expect((await preflight(join(home, '.claude'), deps)).error).toMatch(/default Claude Code folder itself/);
    writeFileSync(join(newDir, '.claude.json'), '{"numStartups":1}');
    expect((await preflight(newDir, deps)).error).toMatch(/no oauthAccount/);
    writeFileSync(join(newDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: NEW } }));
    keychain.delete(keychainService(newDir));
    expect((await preflight(newDir, deps)).error).toMatch(/No token for/);
    keychain.set(keychainService(newDir), { acct: 'bill', secret: NEW_TOKEN });
    expect((await preflight(newDir, { ...deps, run: fakeRun({ loggedOut: (f) => f === newDir }) })).error).toMatch(/not logged in/);
    writeFileSync(join(newDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: OLD.toUpperCase() } }));
    expect((await preflight(newDir, deps)).error).toMatch(/Both folders are logged in as old@example.com/);
  });

  it('needs a current login to move away from', async () => {
    keychain.delete(DEFAULT_SERVICE);
    expect((await preflight(newDir, deps)).error).toMatch(/default Claude Code folder is not logged in/);
  });

  it('names the new folder\'s .claude.json when it is missing or not JSON', async () => {
    rmSync(join(newDir, '.claude.json'));
    expect((await preflight(newDir, deps)).error).toMatch(new RegExp(`^${join(newDir, '.claude.json').replace(/[.\\/]/g, '\\$&')}: `));
    writeFileSync(join(newDir, '.claude.json'), 'not json');
    expect((await preflight(newDir, deps)).error).toMatch(/\.claude\.json: /);
    writeFileSync(join(newDir, '.claude.json'), '[1]');
    expect((await preflight(newDir, deps)).error).toMatch(/not a JSON object/);
  });

  it('treats a claude that prints no JSON as logged out', async () => {
    const base = fakeRun();
    const run = vi.fn(async (f, a, o) => (f === 'claude' && o.env?.CLAUDE_CONFIG_DIR === newDir) ? { code: 0, stdout: 'Logged in as new@example.com\n', stderr: '' } : base(f, a, o));
    expect(await authStatus(loginOf(newDir, { home, env, platform: 'darwin' }), { run, platform: 'darwin' })).toEqual({ loggedIn: false, email: null, error: 'claude auth status printed no JSON' });
    expect((await preflight(newDir, { ...deps, run })).error).toMatch(/not logged in/);
    // loggedIn: true with a non-zero exit is not a login either.
    const flaky = vi.fn(async () => ({ code: 1, stdout: '{"loggedIn":true,"email":"x@y"}', stderr: '' }));
    expect((await authStatus(loginOf(null, { home, env, platform: 'darwin' }), { run: flaky, platform: 'darwin' })).loggedIn).toBe(false);
  });
});

describe('migrate', () => {
  it('backs up at 0600, swaps the token and account in place, verifies, and records the switch', async () => {
    const result = await migrate(newDir, deps);
    expect(result).toMatchObject({ ok: true, oldEmail: OLD, newEmail: NEW });
    // The default item now holds the new token, same account attribute, and nothing else was added.
    expect(keychain.get(DEFAULT_SERVICE)).toEqual({ acct: 'bill', secret: NEW_TOKEN });
    expect([...keychain.keys()]).toEqual([DEFAULT_SERVICE, keychainService(newDir)]);
    expect(keychain.get(keychainService(newDir)).secret).toBe(NEW_TOKEN);   // the new folder is left alone
    const add = calls.find(c => c[1] === 'add-generic-password');
    expect(add).toEqual(['security', 'add-generic-password', '-U', '-a', 'bill', '-s', DEFAULT_SERVICE, '-X', Buffer.from(NEW_TOKEN).toString('hex')]);
    // Only the account fields changed in ~/.claude.json.
    const after = json(defaultJson());
    expect(after.oauthAccount).toEqual({ accountUuid: 'a-new', emailAddress: NEW, organizationName: 'New org' });
    expect(after.hasAvailableSubscription).toBeUndefined();   // not in the new folder: dropped
    expect(after).toMatchObject({ numStartups: 40, theme: 'dark', projects: { '/x': { hasTrustDialogAccepted: true } }, userID: 'u1' });
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(defaultJson()).mode & 0o777).toBe(0o600);
    // The backup: the old token and account fields, readable by the owner alone.
    expect(result.backupDir.startsWith(join(dir, 'account-backup'))).toBe(true);
    expect(readFileSync(join(result.backupDir, 'credentials'), 'utf8')).toBe(OLD_TOKEN);
    const meta = json(join(result.backupDir, 'account.json'));
    expect(meta).toMatchObject({ email: OLD, account: 'bill', where: `Keychain item "${DEFAULT_SERVICE}"`, fields: { oauthAccount: { emailAddress: OLD }, hasAvailableSubscription: true } });
    if (process.platform !== 'win32') {
      expect(statSync(join(result.backupDir, 'credentials')).mode & 0o777).toBe(0o600);
      expect(statSync(join(result.backupDir, 'account.json')).mode & 0o777).toBe(0o600);
      expect(statSync(result.backupDir).mode & 0o777).toBe(0o700);
    }
    expect(loadState(dir)).toMatchObject({ status: 'migrated', folder: newDir, newEmail: NEW, oldEmail: OLD, backupDir: result.backupDir });
    expect(JSON.stringify(publicState(dir))).not.toMatch(/sk-ant/);
  });

  it('never logs a token', async () => {
    const lines = [];
    await migrate(newDir, { ...deps, log: (l) => lines.push(l) });
    expect(lines.join('\n')).toMatch(/switched the default login from old@example.com to new@example.com/);
    expect(lines.join('\n')).not.toMatch(/sk-ant|OLD|NEW/);
  });

  it('rolls back by itself when the verify does not show the new email', async () => {
    // claude still reports the old account after the swap.
    const run = fakeRun({ reportEmail: (folder) => (folder ? NEW : OLD) });
    const result = await migrate(newDir, { ...deps, run });
    expect(result.error).toMatch(/reports old@example.com after the swap, not new@example.com\. Rolled back to old@example.com\./);
    expect(result.rolledBack).toBe(true);
    expect(keychain.get(DEFAULT_SERVICE)).toEqual({ acct: 'bill', secret: OLD_TOKEN });
    const after = json(defaultJson());
    expect(after.oauthAccount.emailAddress).toBe(OLD);
    expect(after.hasAvailableSubscription).toBe(true);
    expect(after.numStartups).toBe(40);
    expect(loadState(dir)).toMatchObject({ status: 'rolled back', oldEmail: OLD, newEmail: NEW });
    expect(isArmed(dir)).toBe(false);
  });

  it('rolls back when the Keychain write itself fails, and changes nothing before the backup exists', async () => {
    const run = fakeRun({ writeFails: true });
    const result = await migrate(newDir, { ...deps, run });
    expect(result.error).toMatch(/add-generic-password failed/);
    // The Keychain write never landed and the rollback write failed the same way: the account block must not have moved either.
    expect(json(defaultJson()).oauthAccount.emailAddress).toBe(OLD);
    expect(result.rolledBack).toBe(false);
    expect(result.error).toMatch(/the backup is in/);
  });

  it('stops before the backup when the current token cannot be read, and rolls back when the new one cannot', async () => {
    // The item is there (preflight only checks that) but its secret will not come out.
    const noRead = (svc) => { const base = fakeRun(); return vi.fn(async (f, a, o) => (f === 'security' && a.includes('-w') && a.includes(svc)) ? { code: 36, stdout: '', stderr: 'denied' } : base(f, a, o)); };
    const result = await migrate(newDir, { ...deps, run: noRead(DEFAULT_SERVICE) });
    expect(result.error).toMatch(/Could not read the current token from Keychain item "Claude Code-credentials"; nothing changed/);
    expect(result.rolledBack).toBeUndefined();
    expect(existsSync(join(dir, 'account-backup'))).toBe(false);
    expect(loadState(dir)).toEqual({ status: 'not set up' });
    expect(json(defaultJson()).oauthAccount.emailAddress).toBe(OLD);
    // The new token unreadable: the backup exists by then, so the swap is undone.
    const second = await migrate(newDir, { ...deps, run: noRead(keychainService(newDir)) });
    expect(second.error).toMatch(/could not read the new token from Keychain item .*\. Rolled back to old@example.com\./);
    expect(second.rolledBack).toBe(true);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);
    expect(json(defaultJson())).toMatchObject({ oauthAccount: { emailAddress: OLD }, hasAvailableSubscription: true });
    expect(loadState(dir)).toMatchObject({ status: 'rolled back', error: expect.stringMatching(/could not read the new token/) });
    expect(publicState(dir).error).toMatch(/could not read the new token/);
  });

  it('on Linux copies .credentials.json at 0600 instead of using the Keychain', async () => {
    const linux = { ...deps, platform: 'linux', env: { ...env, HOME: home } };
    writeFileSync(join(home, '.claude', '.credentials.json'), OLD_TOKEN, { mode: 0o600 });
    writeFileSync(join(newDir, '.credentials.json'), NEW_TOKEN, { mode: 0o600 });
    // The fake claude reads the Keychain map for loggedIn; give it the file view instead.
    linux.run = vi.fn(async (file, args, opts = {}) => {
      if (file === 'security') throw new Error('security must not run on Linux');
      const login = loginOf(opts.env?.CLAUDE_CONFIG_DIR || null, { home, env, platform: 'linux' });
      const account = json(login.configJson).oauthAccount;
      const loggedIn = !!account && existsSync(login.credentialsFile);
      return { code: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn, email: loggedIn ? account.emailAddress : null }), stderr: '' };
    });
    const result = await migrate(newDir, linux);
    expect(result).toMatchObject({ ok: true, newEmail: NEW });
    const file = join(home, '.claude', '.credentials.json');
    expect(readFileSync(file, 'utf8')).toBe(NEW_TOKEN);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(newDir, '.credentials.json'), 'utf8')).toBe(NEW_TOKEN);
    expect(json(join(result.backupDir, 'account.json')).where).toBe(file);
    expect(readFileSync(join(result.backupDir, 'credentials'), 'utf8')).toBe(OLD_TOKEN);
    expect((await rollback(linux)).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(OLD_TOKEN);
  });
});

describe('writeAccountFields', () => {
  it('tries again when Claude Code wrote the file meanwhile, and gives up after a few', async () => {
    const file = defaultJson();
    const waits = [];
    // Claude Code writes between our read and our rename, once.
    const afterRead = (i) => { if (i === 0) writeFileSync(file, JSON.stringify({ ...json(file), numStartups: 41 })); };
    expect(await writeAccountFields(file, { oauthAccount: { emailAddress: NEW } }, { wait: async (ms) => waits.push(ms), afterRead })).toBe(true);
    expect(waits).toEqual([100]);
    expect(json(file)).toMatchObject({ oauthAccount: { emailAddress: NEW }, numStartups: 41, theme: 'dark' });
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
    // A file that keeps changing is an error, and the temp file is gone.
    const always = () => writeFileSync(file, JSON.stringify({ ...json(file), numStartups: Math.random() }));
    await expect(writeAccountFields(file, {}, { tries: 2, wait: async () => {}, afterRead: always })).rejects.toThrow(/kept changing under us \(2 tries\)/);
    expect(json(file).oauthAccount.emailAddress).toBe(NEW);
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('leaves a file that is not a JSON object alone', async () => {
    const file = join(home, 'list.json');
    writeFileSync(file, '[1,2]');
    await expect(writeAccountFields(file, {}, { tries: 1 })).rejects.toThrow(/not a JSON object/);
    expect(readFileSync(file, 'utf8')).toBe('[1,2]');
  });

  it('drops account fields the new folder lacks and keeps every other key', async () => {
    const file = defaultJson();
    await writeAccountFields(file, { oauthAccount: { emailAddress: NEW } });
    const after = json(file);
    for (const k of ACCOUNT_FIELDS.filter(k => k !== 'oauthAccount')) expect(after[k]).toBeUndefined();
    expect(Object.keys(after)).toEqual(['numStartups', 'theme', 'oauthAccount', 'projects', 'userID']);
  });
});

describe('rollback and retire', () => {
  it('rollback restores the backup and verifies the old email again', async () => {
    await migrate(newDir, deps);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(NEW_TOKEN);
    const result = await rollback(deps);
    expect(result).toEqual({ ok: true, email: OLD });
    expect(keychain.get(DEFAULT_SERVICE)).toEqual({ acct: 'bill', secret: OLD_TOKEN });
    expect(json(defaultJson())).toMatchObject({ oauthAccount: { emailAddress: OLD }, hasAvailableSubscription: true, numStartups: 40 });
    expect(loadState(dir).status).toBe('rolled back');
    expect((await rollback({ ...deps, dir: join(home, 'empty') })).error).toMatch(/No backup/);
  });

  it('rollback reports a restore that does not verify', async () => {
    await migrate(newDir, deps);
    const result = await rollback({ ...deps, run: fakeRun({ reportEmail: () => NEW }) });
    expect(result.error).toMatch(/reports new@example.com, not old@example.com/);
  });

  it('rollback finds the newest backup when the state does not name one, and reports a broken backup', async () => {
    const first = await migrate(newDir, deps);
    // A second, later backup: an older stamp sorts first, so the newest wins.
    mkdirSync(join(dir, 'account-backup', '2020-01-01T00-00-00-000Z'));
    writeFileSync(join(dir, 'account-backup', '2020-01-01T00-00-00-000Z', 'account.json'), '{"email":"stale@example.com"}');
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ status: 'migrated', folder: newDir, newEmail: NEW, oldEmail: OLD }));
    expect(await rollback(deps)).toEqual({ ok: true, email: OLD });
    expect(loadState(dir)).toMatchObject({ status: 'rolled back', backupDir: first.backupDir });
    // A backup with its credentials gone is an error, not a half restore.
    await migrate(newDir, deps);
    const state = loadState(dir);
    rmSync(join(state.backupDir, 'credentials'));
    const broken = await rollback(deps);
    expect(broken.error).toMatch(/^Rollback failed: .*credentials/);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(NEW_TOKEN);
    expect(loadState(dir).status).toBe('migrated');
    // No backups at all under an existing folder.
    expect((await rollback({ ...deps, dir: join(home, 'other') })).error).toMatch(/No backup/);
    mkdirSync(join(home, 'other', 'account-backup'), { recursive: true });
    expect((await rollback({ ...deps, dir: join(home, 'other') })).error).toMatch(/No backup/);
  });

  it('retire renames the migrated folder with the date and never deletes it', async () => {
    expect(retire(deps).error).toMatch(/Only a folder whose account has been switched to/);
    await migrate(newDir, deps);
    const result = retire(deps);
    expect(result).toEqual({ ok: true, retiredTo: `${newDir}.retired-2026-09-27` });
    expect(existsSync(newDir)).toBe(false);
    expect(json(join(result.retiredTo, '.claude.json')).oauthAccount.emailAddress).toBe(NEW);
    expect(loadState(dir)).toMatchObject({ status: 'migrated', retiredTo: result.retiredTo });
    expect(publicState(dir).retiredTo).toBe(result.retiredTo);
    // A second folder retired the same day gets a number, not an overwrite.
    mkdirSync(newDir);
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ ...loadState(dir), retiredTo: undefined }));
    expect(retire(deps).retiredTo).toBe(`${newDir}.retired-2026-09-27-2`);
    expect(existsSync(result.retiredTo)).toBe(true);
    const rename = vi.fn();
    expect(retire({ ...deps, rename }).error).toMatch(/not there any more/);
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('setup and arming', () => {
  it('is off by default: no state file, nothing armed, nothing to disarm', () => {
    expect(loadState(dir)).toEqual({ status: 'not set up' });
    expect(isArmed(dir)).toBe(false);
    expect(setArmed(true, { dir }).error).toMatch(/Set the new account's folder up first/);
    expect(setArmed(false, { dir }).error).toMatch(/Nothing is armed/);
    expect(existsSync(join(dir, 'account-migration.json'))).toBe(false);
  });

  it('setup records the folder as ready, then arm and disarm flip it', async () => {
    expect((await setup(join(home, 'nope'), deps)).error).toMatch(/does not exist/);
    expect(loadState(dir).status).toBe('not set up');
    const result = await setup('~/.claude-new', deps);
    expect(result.state).toMatchObject({ status: 'ready', folder: newDir, newEmail: NEW, oldEmail: OLD });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'account-migration.json')).mode & 0o777).toBe(0o600);
    expect(setArmed(true, { dir }).state.status).toBe('armed');
    expect(isArmed(dir)).toBe(true);
    expect(setArmed(false, { dir }).state.status).toBe('ready');
    expect(isArmed(dir)).toBe(false);
    // A corrupt state file reads as not set up rather than throwing.
    writeFileSync(join(dir, 'account-migration.json'), '{"status":"weird"}');
    expect(loadState(dir)).toEqual({ status: 'not set up' });
    writeFileSync(join(dir, 'account-migration.json'), '{not json');
    expect(loadState(dir)).toEqual({ status: 'not set up' });
    expect(isArmed(dir)).toBe(false);
    expect(publicState(dir)).toMatchObject({ status: 'not set up', folder: undefined, newEmail: undefined });
  });

  it('arming again while armed keeps it armed, and a rolled-back state must be checked again first', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    expect(setArmed(true, { dir }).state.status).toBe('armed');
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ ...loadState(dir), status: 'rolled back' }));
    expect(setArmed(true, { dir }).error).toMatch(/Set the new account's folder up first/);
    expect(setArmed(false, { dir }).error).toMatch(/Nothing is armed/);
    // Check again from there brings it back to ready with the state file rewritten.
    expect((await setup(newDir, deps)).state.status).toBe('ready');
  });
});

// The armed trigger, through the same tick that switches Billion to Codex.
describe('the armed switch at a usage limit', () => {
  const T0 = 1_000_000_000;
  const OUT = "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.";
  let ids = 0;
  const billion = (screen = OUT, over = {}) => ({
    id: `acct-${++ids}`, isBillion: true, exited: false, agent: 'claude',
    state: 'WAITING', lastOutputAt: T0 - SETTLE_MS, ringBuffer: { getAll: () => [screen] }, ...over,
  });
  const tick = (session, over = {}) => limitTick(session, {
    now: T0, env: {}, log: () => {}, send: vi.fn(), ready: vi.fn(async () => true),
    switchTo: vi.fn(async () => ({ session: {} })), notify: vi.fn(async () => ({})), tell: vi.fn(async () => ({})), ...over,
  });
  const migration = (run) => ({ armed: () => isArmed(dir), run: vi.fn(run || (async () => { await setup(newDir, deps); return migrate(newDir, deps); })) });

  it('fires once at the first hard limit, disarms, and the Codex switch never happens', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    const m = migration();
    const switchTo = vi.fn(async () => ({ session: {} }));
    expect(await tick(billion(), { migration: m, switchTo })).toBe('migrated');
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run.mock.calls[0][0]).toMatchObject({ kind: 'hard' });
    expect(switchTo).not.toHaveBeenCalled();
    expect(loadState(dir).status).toBe('migrated');
    expect(isArmed(dir)).toBe(false);
    // The notice still on screen (say Billion did not restart yet): the ordinary switch now, not a second migration.
    expect(await tick(billion(), { migration: m, switchTo })).toBe('switched');
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('waits for Billion to go quiet, and only a Claude Billion arms it', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    const m = migration();
    expect(await tick(billion(OUT, { state: 'WORKING' }), { migration: m })).toBeNull();
    expect(await tick(billion(OUT, { lastOutputAt: T0 - 1000 }), { migration: m })).toBeNull();
    const switchTo = vi.fn(async () => ({ session: {} }));
    expect(await tick(billion("■ You've hit your usage limit. Try again at 4:05 PM.", { agent: 'codex' }), { migration: m, switchTo })).toBe('switched');
    expect(m.run).not.toHaveBeenCalled();
    expect(isArmed(dir)).toBe(true);
  });

  it('runs even with BILLION_AUTO_SWITCH=0, which keeps the Codex switch off', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    const m = migration();
    const switchTo = vi.fn(async () => ({ session: {} }));
    expect(await tick(billion(), { migration: m, switchTo, env: { BILLION_AUTO_SWITCH: '0' } })).toBe('migrated');
    expect(await tick(billion(), { migration: m, switchTo, env: { BILLION_AUTO_SWITCH: '0' } })).toBeNull();
    expect(switchTo).not.toHaveBeenCalled();
  });

  it('a failed migration is rolled back and disarmed, and the next tick switches to Codex', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    const bad = { ...deps, run: fakeRun({ reportEmail: (folder) => (folder ? NEW : OLD) }) };
    const m = migration(async () => migrate(newDir, bad));
    const switchTo = vi.fn(async () => ({ session: {} }));
    expect(await tick(billion(), { migration: m, switchTo })).toBe('migration-failed');
    expect(switchTo).not.toHaveBeenCalled();
    expect(loadState(dir).status).toBe('rolled back');
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);
    expect(await tick(billion(), { migration: m, switchTo })).toBe('switched');
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('a warning still needs BILLION_AUTO_SWITCH: armed alone never nudges, and never migrates', async () => {
    const WARN = "You've used 92% of your weekly limit · resets 10am (America/Los_Angeles)";
    await setup(newDir, deps);
    setArmed(true, { dir });
    const m = migration();
    const send = vi.fn();
    // Auto-switch off: the armed gate lets the tick in, the warning branch sends it back out.
    expect(await tick(billion(WARN), { migration: m, send, env: { BILLION_AUTO_SWITCH: '0' } })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    // Auto-switch on: the nudge as before, and no migration for a mere warning.
    expect(await tick(billion(WARN), { migration: m, send })).toBe('warned');
    expect(send).toHaveBeenCalledTimes(1);
    expect(m.run).not.toHaveBeenCalled();
    expect(isArmed(dir)).toBe(true);
  });

  it('stays out of a paused Billion, and a Codex Billion with auto-switch off is left alone even when armed', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    const m = migration();
    const s = billion();
    resetLimitWatch({ pausedFor: s.id });
    expect(await tick(s, { migration: m })).toBeNull();
    resetLimitWatch();
    expect(await tick(billion("■ You've hit your usage limit. Try again at 4:05 PM.", { agent: 'codex' }), { migration: m, env: { BILLION_AUTO_SWITCH: '0' } })).toBeNull();
    expect(m.run).not.toHaveBeenCalled();
    // migration given without armed() (or an exited Billion) is as good as none.
    expect(await tick(billion(), { migration: {}, env: { BILLION_AUTO_SWITCH: '0' } })).toBeNull();
    expect(await tick(billion(OUT, { exited: true }), { migration: m })).toBeNull();
    expect(isArmed(dir)).toBe(true);
  });

  it('a migration that throws lets go of the tick, so the next one runs', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    const m = { armed: () => isArmed(dir), run: vi.fn(async () => { throw new Error('keychain locked'); }) };
    await expect(tick(billion(), { migration: m })).rejects.toThrow(/keychain locked/);
    expect(isArmed(dir)).toBe(true);   // nothing disarmed it: the switch never got as far as the state file
    // watch.running was cleared: the next tick reaches run() again.
    await expect(tick(billion(), { migration: m })).rejects.toThrow(/keychain locked/);
    expect(m.run).toHaveBeenCalledTimes(2);
  });

  it('off by default: nothing set up means the tick behaves as before', async () => {
    const m = migration();
    const switchTo = vi.fn(async () => ({ session: {} }));
    expect(await tick(billion(), { migration: m, switchTo })).toBe('switched');
    expect(m.run).not.toHaveBeenCalled();
    expect(await tick(billion(), { switchTo, env: { BILLION_AUTO_SWITCH: '0' } })).toBeNull();
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);
  });
});
