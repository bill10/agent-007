// The owner's permanent Claude account switch (server/account-migration.js).
// Everything runs against a scratch home and a fake `security` / `claude`:
// the real Keychain, ~/.claude and ~/.claude.json are never touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync, rmSync, utimesSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import {
  preflight, migrate, rollback, retire, setup, setArmed, isArmed, loadState, publicState, canMigrate, runCommand, BUSY_ERROR, resetInFlight, checkSwitch, recheck, authStatus,
  keychainService, keychainAccount, loginOf, writeAccountFields, DEFAULT_SERVICE, ACCOUNT_FIELDS,
} from '../server/account-migration.js';
import { limitTick, resetLimitWatch, SETTLE_MS } from '../server/billion-limit.js';
import { withBillionStopped } from '../server/billion.js';

const OLD = 'old@example.com', NEW = 'new@example.com';
const OLD_TOKEN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-OLD","refreshToken":"sk-ant-ort01-OLD"}}';
const NEW_TOKEN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-NEW","refreshToken":"sk-ant-ort01-NEW"}}';

let home, dir, newDir, keychain, calls, env, deps;

// A fake `security` over an in-memory Keychain and a fake `claude auth status
// --json` that answers as the real one does: logged in when the folder's
// .claude.json has an oauthAccount and its token exists, email from that block.
function fakeRun(over = {}) {
  // `security -i` takes its command on stdin: parse the one line the module writes.
  const parseLine = (line) => {
    const m = /^add-generic-password -U -a "([^"]*)" -s "([^"]*)" -X ([0-9a-f]+)\n$/.exec(line);
    if (!m) throw new Error(`fake security -i: unexpected command ${JSON.stringify(line)}`);
    return { acct: m[1], svc: m[2], secret: Buffer.from(m[3], 'hex').toString('utf8') };
  };
  return vi.fn(async (file, args, opts = {}) => {
    calls.push([file, ...args, ...(opts.input ? ['<stdin>'] : [])]);
    if (file === '/usr/bin/security') {
      if (args[0] === '-i') {
        if (over.writeFails) return { code: 1, stdout: '', stderr: 'boom' };
        const { acct, svc, secret } = parseLine(opts.input);
        const item = keychain.get(svc);
        // -U updates the item with this account and service; another account would be a second item.
        if (item && item.acct !== acct) keychain.set(`${svc}@${acct}`, { acct, secret });
        else keychain.set(svc, { acct, secret });
        return { code: 0, stdout: '', stderr: '' };
      }
      const svc = args[args.indexOf('-s') + 1];
      const acct = args.includes('-a') ? args[args.indexOf('-a') + 1] : null;
      const item = keychain.get(svc);
      if (args[0] === 'find-generic-password') {
        if (!item || (acct && item.acct !== acct)) return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
        return args.includes('-w')
          ? { code: 0, stdout: `${item.secret}\n`, stderr: '' }
          : { code: 0, stdout: `keychain: "login"\nclass: "genp"\nattributes:\n    "acct"<blob>="${item.acct}"\n    "svce"<blob>="${svc}"\n`, stderr: '' };
      }
      throw new Error(`fake security: unexpected ${args.join(' ')}`);
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
  resetInFlight();
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
    expect(moved).toMatchObject({ folder: '/cfg', configJson: join('/cfg', '.claude.json'), service: keychainService('/cfg') });   // join: a backslash on Windows
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
    // The write went to `security -i` on stdin: no token on any command line.
    expect(calls.find(c => c[1] === '-i')).toEqual(['/usr/bin/security', '-i', '<stdin>']);
    expect(calls.flat().join(' ')).not.toMatch(/add-generic-password|sk-ant|[0-9a-f]{40}/);
    expect(deps.run.mock.calls.find(([, a]) => a[0] === '-i')[2].input).toBe(`add-generic-password -U -a "bill" -s "${DEFAULT_SERVICE}" -X ${Buffer.from(NEW_TOKEN).toString('hex')}\n`);
    // Read back after the write, with the account claude itself uses.
    expect(calls.filter(c => c.includes('-w')).every(c => c.includes('-a') && c.includes('bill'))).toBe(true);
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

  it('a Keychain write that fails before anything changed needs no rollback and leaves the panel usable', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    const run = fakeRun({ writeFails: true });
    const result = await migrate(newDir, { ...deps, run });
    expect(result.error).toMatch(/add-generic-password failed \(1\): boom\. Nothing changed\./);
    expect(result.rolledBack).toBeUndefined();
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);
    expect(json(defaultJson()).oauthAccount.emailAddress).toBe(OLD);
    // Disarmed, ready, the error shown; the backup stays for the record.
    expect(loadState(dir)).toMatchObject({ status: 'ready', error: expect.stringMatching(/boom/), backupDir: result.backupDir });
    expect(canMigrate(dir).ok).toBe(true);
    expect((await migrate(newDir, deps)).ok).toBe(true);
  });

  it('stops before the backup when the current token cannot be read, and rolls back when the new one cannot', async () => {
    // The item is there (preflight only checks that) but its secret will not come out.
    const noRead = (svc) => { const base = fakeRun(); return vi.fn(async (f, a, o) => (f === '/usr/bin/security' && a.includes('-w') && a.includes(svc)) ? { code: 36, stdout: '', stderr: 'denied' } : base(f, a, o)); };
    const result = await migrate(newDir, { ...deps, run: noRead(DEFAULT_SERVICE) });
    expect(result.error).toMatch(/Could not read the current token from Keychain item "Claude Code-credentials"; nothing changed/);
    expect(result.rolledBack).toBeUndefined();
    expect(existsSync(join(dir, 'account-backup'))).toBe(false);
    expect(loadState(dir)).toEqual({ status: 'not set up' });
    expect(json(defaultJson()).oauthAccount.emailAddress).toBe(OLD);
    // The new token unreadable: found out before anything moved, so nothing to undo.
    const second = await migrate(newDir, { ...deps, run: noRead(keychainService(newDir)) });
    expect(second.error).toMatch(/could not read the new token from Keychain item .*; nothing changed\./);
    expect(second.rolledBack).toBeUndefined();
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);
    expect(json(defaultJson())).toMatchObject({ oauthAccount: { emailAddress: OLD }, hasAvailableSubscription: true });
    expect(loadState(dir)).toEqual({ status: 'not set up' });   // not armed: nothing to record
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
    expect(result).toMatchObject({ ok: true, email: OLD });
    expect(keychain.get(DEFAULT_SERVICE)).toEqual({ acct: 'bill', secret: OLD_TOKEN });
    expect(json(defaultJson())).toMatchObject({ oauthAccount: { emailAddress: OLD }, hasAvailableSubscription: true, numStartups: 40 });
    expect(loadState(dir).status).toBe('rolled back');
    expect((await rollback({ ...deps, dir: join(home, 'empty') })).error).toMatch(/Nothing to roll back/);
  });

  it('rollback reports a restore that does not verify', async () => {
    await migrate(newDir, deps);
    const result = await rollback({ ...deps, run: fakeRun({ reportEmail: () => NEW }) });
    expect(result.error).toMatch(/^Rollback failed: claude auth status reports new@example.com after the restore, not old@example.com/);
    expect(loadState(dir).status).toBe('rollback failed');
    expect(publicState(dir).error).toMatch(/after the restore/);
  });

  it('rollback needs the backup its state names, never whatever is newest on disk, and backs up what it replaces', async () => {
    const first = await migrate(newDir, deps);
    // Nothing to roll back from a fresh or a rolled-back state; a state that lost its pointer is refused too.
    expect((await rollback({ ...deps, dir: join(home, 'other') })).error).toMatch(/Nothing to roll back/);
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ status: 'migrated', folder: newDir, newEmail: NEW, oldEmail: OLD }));
    mkdirSync(join(dir, 'account-backup', '2020-01-01T00-00-00-000Z'));
    writeFileSync(join(dir, 'account-backup', '2020-01-01T00-00-00-000Z', 'account.json'), '{"email":"stale@example.com"}');
    writeFileSync(join(dir, 'account-backup', '2020-01-01T00-00-00-000Z', 'credentials'), 'stale');
    expect((await rollback(deps)).error).toMatch(/names no backup/);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(NEW_TOKEN);
    // With the pointer back: the login being replaced is saved first, then the old one restored.
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ status: 'migrated', folder: newDir, newEmail: NEW, oldEmail: OLD, backupDir: first.backupDir }));
    const result = await rollback(deps);
    expect(result).toMatchObject({ ok: true, email: OLD });
    expect(loadState(dir)).toMatchObject({ status: 'rolled back', backupDir: first.backupDir, replacedBackupDir: result.replacedBackupDir });
    expect(result.replacedBackupDir).not.toBe(first.backupDir);
    expect(readFileSync(join(result.replacedBackupDir, 'credentials'), 'utf8')).toBe(NEW_TOKEN);
    expect(json(join(result.replacedBackupDir, 'account.json'))).toMatchObject({ email: NEW, fields: { oauthAccount: { emailAddress: NEW } } });
    expect((await rollback(deps)).error).toMatch(/Already rolled back/);
    // A backup with its credentials gone is an error, not a half restore.
    await migrate(newDir, deps);
    const state = loadState(dir);
    rmSync(join(state.backupDir, 'credentials'));
    const broken = await rollback(deps);
    expect(broken.error).toMatch(/incomplete: credentials missing/);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(NEW_TOKEN);
    expect(loadState(dir).status).toBe('migrated');
  });

  it('retire renames the migrated folder with the date and never deletes it', async () => {
    expect((await retire(deps)).error).toMatch(/Only a folder whose account has been switched to/);
    await migrate(newDir, deps);
    const result = await retire(deps);
    expect(result).toEqual({ ok: true, retiredTo: `${newDir}.retired-2026-09-27` });
    expect(existsSync(newDir)).toBe(false);
    expect(json(join(result.retiredTo, '.claude.json')).oauthAccount.emailAddress).toBe(NEW);
    expect(loadState(dir)).toMatchObject({ status: 'migrated', retiredTo: result.retiredTo });
    expect(publicState(dir).retiredTo).toBe(result.retiredTo);
    // A second folder retired the same day gets a number, not an overwrite.
    mkdirSync(newDir);
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ ...loadState(dir), retiredTo: undefined }));
    expect((await retire(deps)).retiredTo).toBe(`${newDir}.retired-2026-09-27-2`);
    expect(existsSync(result.retiredTo)).toBe(true);
    // Retired already: the button does nothing twice.
    const rename = vi.fn();
    expect((await retire({ ...deps, rename })).error).toMatch(/already retired as/);
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ ...loadState(dir), retiredTo: undefined }));
    expect((await retire({ ...deps, rename })).error).toMatch(/not there any more/);
    expect(rename).not.toHaveBeenCalled();
    // A rename that fails is an error, not a throw, and nothing is recorded.
    mkdirSync(newDir);
    const eperm = vi.fn(() => { throw new Error('EPERM: operation not permitted'); });
    expect((await retire({ ...deps, rename: eperm })).error).toMatch(/Could not rename .*EPERM/);
    expect(loadState(dir).retiredTo).toBeUndefined();
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

describe('what the reviews asked for', () => {
  it('one action at a time: a second switch while one runs is refused, and one backup is written', async () => {
    // Slow the first switch down at its first `security -w` read.
    const base = fakeRun();
    let release;
    const gate = new Promise(r => { release = r; });
    const run = vi.fn(async (f, a, o) => { if (a.includes('-w') && !run.held) { run.held = true; await gate; } return base(f, a, o); });
    const first = migrate(newDir, { ...deps, run });
    try {
      await new Promise(r => setTimeout(r, 20));
      expect(await migrate(newDir, deps)).toEqual({ error: BUSY_ERROR });
      expect(await rollback(deps)).toEqual({ error: BUSY_ERROR });
      expect(await retire(deps)).toEqual({ error: BUSY_ERROR });
      expect(await setup(newDir, deps)).toEqual({ error: BUSY_ERROR });
      expect(await checkSwitch(newDir, deps)).toEqual({ error: BUSY_ERROR });
      // Another server process holds the same lock on disk.
      expect(existsSync(join(dir, 'account-migration.lock'))).toBe(true);
    } finally { release(); }
    expect((await first).ok).toBe(true);
    expect(existsSync(join(dir, 'account-migration.lock'))).toBe(false);
    expect(readdirSync(join(dir, 'account-backup'))).toHaveLength(1);
    // Free again afterwards.
    expect((await rollback(deps)).ok).toBe(true);
  });

  it('a failure before the swap disarms, so the next limit tick can take the ordinary road', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    rmSync(newDir, { recursive: true });
    const result = await migrate(newDir, deps);
    expect(result.error).toMatch(/does not exist/);
    expect(loadState(dir)).toMatchObject({ status: 'ready', error: expect.stringMatching(/does not exist/) });
    expect(isArmed(dir)).toBe(false);
    expect(publicState(dir).error).toMatch(/does not exist/);
    // Not armed: the same failure leaves the state alone.
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ status: 'ready', folder: newDir, newEmail: NEW, oldEmail: OLD }));
    await migrate(newDir, deps);
    expect(loadState(dir).error).toBeUndefined();
  });

  it('a folder typed with a trailing slash finds the item claude made for it either way', async () => {
    // Logged in as CLAUDE_CONFIG_DIR=~/.claude-new/ : the hash covers the slash.
    keychain.delete(keychainService(newDir));
    keychain.set(keychainService(`${newDir}/`), { acct: 'bill', secret: NEW_TOKEN });
    const pre = await preflight(`${newDir}/`, deps);
    expect(pre.folder).toBe(newDir);                       // stored without the slash
    expect(pre.next.folder).toBe(`${newDir}/`);            // used as claude hashed it
    expect(pre.next.env.CLAUDE_CONFIG_DIR).toBe(`${newDir}/`);
    const result = await migrate(`${newDir}///`, deps);
    expect(result).toMatchObject({ ok: true, newEmail: NEW });
    expect(loadState(dir).folder).toBe(newDir);
    expect((await retire(deps)).retiredTo).toBe(`${newDir}.retired-2026-09-27`);
  });

  it('a token that does not read back as written is a failed swap, rolled back', async () => {
    const base = fakeRun();
    const run = vi.fn(async (f, a, o) => {
      const r = await base(f, a, o);
      // The write "succeeds" but the item keeps the old secret.
      if (a[0] === '-i' && keychain.get(DEFAULT_SERVICE).secret === NEW_TOKEN) keychain.set(DEFAULT_SERVICE, { acct: 'bill', secret: OLD_TOKEN });
      return r;
    });
    const result = await migrate(newDir, { ...deps, run });
    // The item still holds the old token, so there is nothing to undo.
    expect(result.error).toMatch(/does not hold the token just written\. Nothing changed\./);
    expect(json(defaultJson()).oauthAccount.emailAddress).toBe(OLD);
    expect(loadState(dir)).toMatchObject({ status: 'ready', error: expect.stringMatching(/does not hold/) });
  });

  it("records 'switching' while the swap is in the air, and 'rollback failed' when the restore fails too", async () => {
    const seen = [];
    const base = fakeRun();
    const run = vi.fn(async (f, a, o) => { if (f === 'claude') seen.push(loadState(dir).status); return base(f, a, o); });
    await migrate(newDir, { ...deps, run });
    expect(seen).toEqual(['not set up', 'not set up', 'switching']);   // two preflight checks, then the verify; the backup reuses preflight's email
    expect(loadState(dir).status).toBe('migrated');
    // Back on the old account, then a config file that breaks once the token has moved: the swap fails
    // after its first write, the restore hits the same broken file, and the state says so.
    expect(await rollback(deps)).toMatchObject({ ok: true });
    const base2 = fakeRun();
    const breaking = vi.fn(async (f, a, o) => { const r = await base2(f, a, o); if (a[0] === '-i') writeFileSync(defaultJson(), '[1]'); return r; });
    const failed = await migrate(newDir, { ...deps, run: breaking });
    expect(failed.rolledBack).toBe(false);
    expect(failed.error).toMatch(/not a JSON object.*Rollback failed too/);
    expect(loadState(dir)).toMatchObject({ status: 'rollback failed', error: expect.stringMatching(/rollback failed: /) });
    expect(canMigrate(dir).error).toMatch(/did not finish cleanly/);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);   // the restore did put the token back
    // Roll back by hand once the file is whole again.
    writeFileSync(defaultJson(), JSON.stringify({ numStartups: 40, oauthAccount: { emailAddress: NEW } }));
    expect(await rollback(deps)).toMatchObject({ ok: true, email: OLD });
    expect(loadState(dir)).toMatchObject({ status: 'rolled back' });
    expect(loadState(dir).error).toBeUndefined();
  });

  it('finds and keeps an item claude wrote under another account name', async () => {
    keychain.set(DEFAULT_SERVICE, { acct: 'legacy', secret: OLD_TOKEN });
    const result = await migrate(newDir, deps);
    expect(result.ok).toBe(true);
    expect(deps.run.mock.calls.find(([, a]) => a[0] === '-i')[2].input).toMatch(/-a "legacy"/);
    expect(json(join(result.backupDir, 'account.json')).account).toBe('legacy');
    expect(keychain.get(DEFAULT_SERVICE)).toEqual({ acct: 'legacy', secret: NEW_TOKEN });
    expect([...keychain.keys()]).toEqual([DEFAULT_SERVICE, keychainService(newDir)]);
    expect((await rollback(deps)).ok).toBe(true);
    expect(keychain.get(DEFAULT_SERVICE)).toEqual({ acct: 'legacy', secret: OLD_TOKEN });
    // An account attribute that is not a plain name is not used at all.
    keychain.set(DEFAULT_SERVICE, { acct: 'bad name!', secret: OLD_TOKEN });
    expect((await migrate(newDir, deps)).error).toMatch(/Could not find the current token in Keychain item "Claude Code-credentials"; nothing changed/);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);
  });

  it('writes its state beside and renames over, and refuses setup once a switch is recorded', async () => {
    await migrate(newDir, deps);
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect((await setup(newDir, deps)).error).toMatch(/A switch has been made; roll it back/);
    expect(loadState(dir).status).toBe('migrated');
    await rollback(deps);
    expect((await setup(newDir, deps)).ok).toBe(true);
  });

  it('checkSwitch is the preflight the server runs before stopping Billion, disarming on failure', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    expect(await checkSwitch(newDir, deps)).toEqual({ ok: true, newEmail: NEW, oldEmail: OLD });
    expect(isArmed(dir)).toBe(true);
    rmSync(newDir, { recursive: true });
    expect((await checkSwitch(newDir, deps)).error).toMatch(/does not exist/);
    expect(loadState(dir)).toMatchObject({ status: 'ready', error: expect.stringMatching(/does not exist/) });
  });

  it('recheck notices a login that went back to the old account after the switch', async () => {
    expect(await recheck(deps)).toEqual({ ok: true, skipped: true });
    await migrate(newDir, deps);
    expect(await recheck({ ...deps, now: () => new Date('2026-09-27T10:00:40Z') })).toEqual({ ok: true, email: NEW });
    // A worker wrote the old account back.
    writeFileSync(defaultJson(), JSON.stringify({ ...json(defaultJson()), oauthAccount: { emailAddress: OLD } }));
    const result = await recheck({ ...deps, now: () => new Date('2026-09-27T10:00:40Z') });
    expect(result.error).toMatch(/reports old@example.com, not new@example.com, 40s after the switch; a running Claude Code/);
    expect(loadState(dir)).toMatchObject({ status: 'migrated', error: expect.stringMatching(/40s after/) });
    expect(publicState(dir).error).toMatch(/written its token back/);
  });

  it('a lock another server left on disk blocks, unless it is stale or its holder is dead', async () => {
    const lock = join(dir, 'account-migration.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), '4242');
    // Its holder is alive: wait.
    expect(await migrate(newDir, { ...deps, alive: () => true })).toEqual({ error: BUSY_ERROR });
    expect(await rollback({ ...deps, alive: () => true })).toEqual({ error: BUSY_ERROR });
    expect(existsSync(lock)).toBe(true);
    // Its holder died mid-action: the owner is not locked out of Roll back for a quarter of an hour.
    expect((await migrate(newDir, { ...deps, alive: () => false })).ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
    // Very old, no pid file: stale by age.
    mkdirSync(lock);
    const old = new Date(Date.now() - 16 * 60_000);
    utimesSync(lock, old, old);
    expect((await rollback(deps)).ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
    // Our own lock carries our pid while held.
    let pidSeen;
    const run = vi.fn(async (f, a, o) => { if (a[0] === '-i') pidSeen = readFileSync(join(lock, 'pid'), 'utf8'); return fakeRun()(f, a, o); });
    await migrate(newDir, { ...deps, run });
    expect(pidSeen).toBe(String(process.pid));
  });

  it('recheck never writes over a state that moved on, and rollback stops when it cannot save what it replaces', async () => {
    await migrate(newDir, deps);
    // The owner rolls back while the recheck is in the air: its result is dropped.
    const racing = vi.fn(async (f, a, o) => {
      if (f === 'claude') writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ ...loadState(dir), status: 'rolled back', at: '2026-09-27T10:00:30Z' }));
      return fakeRun({ reportEmail: () => OLD })(f, a, o);
    });
    const result = await recheck({ ...deps, run: racing, now: () => new Date('2026-09-27T10:00:40Z') });
    expect(result.error).toMatch(/reports old@example.com/);
    expect(loadState(dir)).toMatchObject({ status: 'rolled back', at: '2026-09-27T10:00:30Z' });
    expect(loadState(dir).error).toBeUndefined();
    // A current login whose config cannot be read is not overwritten by a rollback.
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ ...loadState(dir), status: 'migrated' }));
    const good = readFileSync(defaultJson(), 'utf8');
    writeFileSync(defaultJson(), 'not json');
    const blocked = await rollback(deps);
    expect(blocked.error).toMatch(/Rollback not started: the current login could not be backed up first/);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(NEW_TOKEN);
    expect(loadState(dir).status).toBe('migrated');
    writeFileSync(defaultJson(), good);
    // A missing current token is nothing to preserve: the rollback goes on and puts one there.
    keychain.delete(DEFAULT_SERVICE);
    expect((await rollback(deps)).ok).toBe(true);
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);
  });

  it('withBillionStopped stops before, restarts after with the carried mail, even when the work throws', async () => {
    const order = [];
    const stop = vi.fn(async () => { order.push('stop'); return ['mail']; });
    const start = vi.fn(({ carried }) => { order.push(`start:${carried}`); return { session: { id: 'b2' } }; });
    const announce = vi.fn();
    expect(await withBillionStopped(async () => { order.push('fn'); return 'ok'; }, { live: () => ({ id: 'b1' }), stop, start, announce })).toBe('ok');
    expect(order).toEqual(['stop', 'fn', 'start:mail']);
    expect(announce).toHaveBeenCalledWith({ id: 'b2' });
    order.length = 0;
    await expect(withBillionStopped(() => { order.push('fn'); throw new Error('x'); }, { live: () => ({ id: 'b1' }), stop, start, announce })).rejects.toThrow('x');
    expect(order).toEqual(['stop', 'fn', 'start:mail']);
    // No Billion: nothing stopped, nothing started.
    stop.mockClear(); start.mockClear();
    expect(await withBillionStopped(async () => 1, { live: () => null, stop, start, announce })).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    // A start that reports an existing session is not announced twice; one that fails is reported.
    announce.mockClear();
    await withBillionStopped(async () => 1, { live: () => ({}), stop, start: () => ({ existing: true, session: {} }), announce });
    expect(announce).not.toHaveBeenCalled();
    const failed = vi.fn();
    expect(await withBillionStopped(async () => 'done', { live: () => ({}), stop, start: () => ({ error: 'no claude' }), announce, failed })).toBe('done');
    expect(failed).toHaveBeenCalledWith('no claude');
    expect(announce).not.toHaveBeenCalled();
  });

  it('rolls back from a switch the server died in the middle of, and recheck under another action is busy, not an alarm', async () => {
    await migrate(newDir, deps);
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ ...loadState(dir), status: 'switching' }));
    expect(await rollback(deps)).toMatchObject({ ok: true, email: OLD });
    expect(keychain.get(DEFAULT_SERVICE).secret).toBe(OLD_TOKEN);
    expect(loadState(dir).status).toBe('rolled back');
    // The recheck timer fires while the owner rolls back: busy, and nothing recorded.
    await migrate(newDir, deps);
    let release; const gate = new Promise(r => { release = r; });
    const base = fakeRun();
    const run = vi.fn(async (f, a, o) => { if (a.includes('-w') && !run.held) { run.held = true; await gate; } return base(f, a, o); });
    const rb = rollback({ ...deps, run });
    try {
      await new Promise(r => setTimeout(r, 20));
      expect(await recheck(deps)).toEqual({ error: BUSY_ERROR });
      expect(loadState(dir).error).toBeUndefined();
    } finally { release(); }
    expect((await rb).ok).toBe(true);
  });

  it('the default liveness check tells a dead holder from a live one', async () => {
    const lock = join(dir, 'account-migration.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(spawnSync(process.execPath, ['-e', '0']).pid));
    expect((await migrate(newDir, deps)).ok).toBe(true);   // dead holder: taken over
    expect((await rollback(deps)).ok).toBe(true);
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(process.ppid));
    expect(await migrate(newDir, deps)).toEqual({ error: BUSY_ERROR });   // live holder: wait
  });

  it('a folder check while armed stays armed', async () => {
    await setup(newDir, deps);
    setArmed(true, { dir });
    expect((await setup(newDir, deps)).state.status).toBe('armed');
    expect(isArmed(dir)).toBe(true);
    rmSync(newDir, { recursive: true });
    expect((await setup(newDir, deps)).error).toMatch(/does not exist/);
    expect(isArmed(dir)).toBe(true);   // a failed check changes nothing; Disarm is the owner's call
  });

  it('canMigrate gates on the state', async () => {
    expect(canMigrate(dir).error).toMatch(/Set the new account/);
    await setup(newDir, deps);
    expect(canMigrate(dir)).toEqual({ ok: true, folder: newDir });
    await migrate(newDir, deps);
    expect(canMigrate(dir).error).toMatch(/already the new account; roll back first/);
    writeFileSync(join(dir, 'account-migration.json'), JSON.stringify({ ...loadState(dir), status: 'switching' }));
    expect(canMigrate(dir).error).toMatch(/did not finish cleanly/);
  });

  it("takes Claude Code's own lock on .claude.json, waits out a fresh one and clears a stale one", async () => {
    const file = defaultJson();
    const lock = `${file}.lock`;
    // A fresh lock: someone is writing; we wait and then give up.
    mkdirSync(lock);
    const waits = [];
    await expect(writeAccountFields(file, { oauthAccount: { emailAddress: NEW } }, { lockTries: 3, wait: async (ms) => waits.push(ms) }))
      .rejects.toThrow(/locked by Claude Code \(\.claude\.json\.lock\)/);
    expect(waits).toEqual([400, 400, 400]);   // 30 of these by default: longer than a fresh lock stays fresh
    expect(json(file).oauthAccount.emailAddress).toBe(OLD);
    expect(existsSync(lock)).toBe(true);                    // not ours: left alone
    // A stale lock (older than 10 s): claude left it behind, so it is removed and the write goes through.
    expect(await writeAccountFields(file, { oauthAccount: { emailAddress: NEW } }, { lockTries: 3, wait: async () => {}, now: () => Date.now() + 60_000 })).toBe(true);
    expect(json(file).oauthAccount.emailAddress).toBe(NEW);
    expect(existsSync(lock)).toBe(false);                   // ours, released
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('runCommand maps exit codes, never throws, feeds stdin, and hands the child the agent env only', async () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENT007_CONFIG_DIR: '/secret', TELEGRAM_BOT_TOKEN: 't', KEEP: 'yes' };
    expect((await runCommand(process.execPath, ['-e', 'process.exit(3)'], { env })).code).toBe(3);
    // No quotes inside the one-liner: on Windows the argument goes through cmd.exe.
    expect((await runCommand(process.execPath, ['-e', 'process.stdout.write(String.fromCharCode(104,105))'], { env })).stdout).toBe('hi');
    expect((await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { env, input: 'from stdin' })).stdout).toBe('from stdin');
    expect((await runCommand('definitely-not-a-binary-a007', [], { env })).code).toBe(1);   // ENOENT has a string code
    const { stdout } = await runCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env });
    const child = JSON.parse(stdout);
    expect(child.KEEP).toBe('yes');
    expect(child.AGENT007_CONFIG_DIR).toBeUndefined();
    expect(child.TELEGRAM_BOT_TOKEN).toBeUndefined();
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
