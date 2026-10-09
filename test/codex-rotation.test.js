// Codex account rotation: the auth.json adapter (server/codex-login.js), the
// shared registry with cli 'codex' (server/account-rotation.js), Codex reset
// times, `codex resume <id>` restarts and the outside-process check. Temp homes
// with fake auth.json files only; `codex` is a stub, never the real CLI.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync, lstatSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureCodexLogin, activateCodexLogin, codexIdentity, stopCodexDaemon } from '../server/codex-login.js';
import { addRotationAccount, configureRotation, rotateAccount, recoverRotation, publicRotationState, rotationState, retryAt, RETRY_MS, rotationOn } from '../server/account-rotation.js';
import { resetInFlight } from '../server/account-migration.js';
import { resumeCodexCommand, withClaudeSessionsStopped } from '../server/claude-rotation-sessions.js';
import { externalClaudePids, assertClaudeProcessesManaged, isCodexDaemon } from '../server/claude-processes.js';
import { parseCommand } from '../lib/helpers.js';
import { removeTempDir } from './temp-dir.js';

const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const auth = (name, refresh = `refresh-${name}`) => JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: jwt({ email: `${name}@example.com`, 'https://api.openai.com/auth': { chatgpt_account_id: `acct-${name}`, chatgpt_user_id: `user-${name}` } }), access_token: `access-${name}`, refresh_token: refresh, account_id: `acct-${name}` },
  last_refresh: '2026-10-01T00:00:00Z',
});
const POSIX = process.platform !== 'win32';

let home, dir, env, run, calls;
const write = (folder, text) => { mkdirSync(join(home, folder), { recursive: true }); writeFileSync(join(home, folder, 'auth.json'), text, { mode: 0o600 }); };
const live = () => readFileSync(join(home, '.codex', 'auth.json'), 'utf8');
const deps = over => ({ cli: 'codex', dir, home, env, run, platform: process.platform, now: () => 1_000_000, ...over });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-rotation-'));
  dir = join(home, '.agent-007');
  env = {};   // no CODEX_HOME: the default is <temp home>/.codex
  calls = [];
  // `codex login status`: logged in when the folder's auth.json holds a refresh token.
  run = vi.fn(async (file, args, { env: e }) => {
    calls.push([file, ...args]);
    try { return { code: JSON.parse(readFileSync(join(e.CODEX_HOME, 'auth.json'), 'utf8')).tokens.refresh_token ? 0 : 1, stdout: '', stderr: '' }; }
    catch { return { code: 1, stdout: '', stderr: '' }; }
  });
  write('.codex', auth('a')); write('.codex-b', auth('b')); write('.codex-c', auth('c'));
  resetInFlight();
});
afterEach(() => removeTempDir(home));

describe('Codex login snapshots', () => {
  it('reads the account id and email from the token, keeping Team members of one workspace apart', () => {
    expect(codexIdentity(auth('a'))).toEqual({ accountId: 'acct-a:user-a', email: 'a@example.com' });
    expect(() => codexIdentity(JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null }))).toThrow(/Not a ChatGPT login/);
  });
  it('captures the default home for null and a folder by absolute path, and refuses a logged-out one', async () => {
    expect(await captureCodexLogin(null, deps())).toMatchObject({ email: 'a@example.com', folder: join(home, '.codex'), secret: auth('a') });
    expect((await captureCodexLogin(join(home, '.codex-b'), deps())).email).toBe('b@example.com');
    await expect(captureCodexLogin('relative/.codex-b', deps())).rejects.toThrow(/absolute/);
    write('.codex-x', JSON.stringify({ tokens: { id_token: jwt({ email: 'x@example.com' }), account_id: 'x', refresh_token: '' } }));
    await expect(captureCodexLogin(join(home, '.codex-x'), deps())).rejects.toThrow();
    // The secret never reaches a command line.
    expect(JSON.stringify(calls)).not.toContain('refresh-');
  });
  it('activates atomically, 0600, through a symlinked auth.json, and verifies the result', async () => {
    const real = join(home, 'elsewhere', 'auth.json');
    mkdirSync(join(home, 'elsewhere')); writeFileSync(real, auth('a'));
    const link = join(home, '.codex', 'auth.json');
    removeTempDir(link); symlinkSync(real, link);
    await activateCodexLogin(await captureCodexLogin(join(home, '.codex-b'), deps()), deps());
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe(auth('b'));
    if (POSIX) expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, 'elsewhere'))).toEqual(['auth.json']);   // no tmp left behind
  });
  it('refuses to activate an incomplete snapshot or without a default login', async () => {
    await expect(activateCodexLogin({ email: 'b@example.com' }, deps())).rejects.toThrow(/incomplete/);
    removeTempDir(join(home, '.codex', 'auth.json'));
    await expect(activateCodexLogin({ secret: auth('b'), accountId: 'acct-b:user-b', email: 'b@example.com' }, deps())).rejects.toThrow(/missing/);
  });
  it('stops the background server with `codex app-server daemon stop` and reports a failure', async () => {
    const stub = vi.fn(async () => ({ code: 0 }));
    await stopCodexDaemon({ run: stub });
    expect(stub).toHaveBeenCalledWith('codex', ['app-server', 'daemon', 'stop'], expect.anything());
    await expect(stopCodexDaemon({ run: async () => ({ code: 1 }) })).rejects.toThrow(/No account was switched/);
  });
});

describe('Codex account rotation', () => {
  const addAll = async () => {
    await addRotationAccount(join(home, '.codex-b'), deps());
    await addRotationAccount(join(home, '.codex-c'), deps());
    await configureRotation({ enabled: true, accounts: publicRotationState(dir, undefined, 'codex').accounts.map(a => ({ id: a.id, enabled: true })) }, deps());
  };
  it('keeps its own registry next to Claude\'s, auto-on at two accounts, with 0600 snapshots and no secrets public', async () => {
    await addRotationAccount(join(home, '.codex-b'), deps());
    expect(existsSync(join(dir, 'codex-account-rotation.json'))).toBe(true);
    expect(existsSync(join(dir, 'account-rotation.json'))).toBe(false);
    expect(rotationState(dir).accounts).toEqual([]);
    const s = rotationState(dir, 'codex');
    expect(s.enabled).toBe(true);
    expect(s.accounts.map(a => a.email)).toEqual(['a@example.com', 'b@example.com']);
    for (const f of readdirSync(join(dir, 'account-logins'))) if (POSIX) expect(statSync(join(dir, 'account-logins', f)).mode & 0o777).toBe(0o600);
    if (POSIX) expect(statSync(join(dir, 'account-logins')).mode & 0o777).toBe(0o700);
    const pub = JSON.stringify(publicRotationState(dir, undefined, 'codex'));
    expect(pub).not.toMatch(/refresh-|access-|secret|id_token/);
  });
  it('rotates A -> B -> C -> A, saving each account\'s refreshed auth.json back first, never a stale source copy', async () => {
    await addAll();
    write('.codex', auth('a', 'refresh-a-2'));            // Codex refreshed A while it was active
    expect(await rotateAccount({}, deps())).toMatchObject({ ok: true, oldEmail: 'a@example.com', newEmail: 'b@example.com' });
    expect(live()).toBe(auth('b'));
    write('.codex', auth('b', 'refresh-b-2'));
    expect(await rotateAccount({}, deps())).toMatchObject({ ok: true, newEmail: 'c@example.com' });
    await addRotationAccount(join(home, '.codex-b'), deps());   // rediscovery must not restore B's stale token
    expect(await rotateAccount({}, deps())).toMatchObject({ ok: true, newEmail: 'a@example.com' });
    expect(live()).toBe(auth('a', 'refresh-a-2'));
    expect(await rotateAccount({}, deps())).toMatchObject({ ok: true, newEmail: 'b@example.com' });
    expect(live()).toBe(auth('b', 'refresh-b-2'));
    // The workspace stays put: only auth.json changed.
    expect(readdirSync(join(home, '.codex'))).toEqual(['auth.json']);
  });
  it('refuses when the default login changed outside the app, and leaves it alone', async () => {
    await addAll();
    write('.codex', auth('z'));
    expect(await rotateAccount({}, deps())).toMatchObject({ blocked: true, error: expect.stringContaining('default Codex login changed') });
    expect(live()).toBe(auth('z'));
  });
  it('marks the limited account until the reset Codex printed, then is exhausted until then', async () => {
    await addRotationAccount(join(home, '.codex-b'), deps());
    const now = new Date(2026, 9, 8, 12, 0).getTime();
    const at = deps({ now: () => now });
    expect(await rotateAccount({ limited: true, line: "You've hit your usage limit. … or try again at Oct 25th, 2026 3:15 PM." }, at)).toMatchObject({ ok: true });
    const a = rotationState(dir, 'codex').accounts.find(x => x.email === 'a@example.com');
    expect(a.limitedUntil).toBe(new Date(2026, 9, 25, 15, 15).getTime());
    // B gives no reset: the 30-minute delay, the earliest the pool is retried.
    expect(await rotateAccount({ limited: true, line: "You've hit your usage limit." }, at)).toMatchObject({ exhausted: true, retryAt: now + RETRY_MS });
    expect(rotationState(dir, 'codex').accounts.find(x => x.email === 'b@example.com').limitedUntil).toBe(now + RETRY_MS);
  });
  // Value: protects=the real adapter's own verify failure (login status rejects the written auth.json) rolls back to the previous login;
  //   fails_when=activateCodexLogin stops checking `codex login status` after the write, or rollback rewrites the wrong login;
  //   why_new=the rollback test below throws from a replaced activate, never from the real adapter; seam=none
  it('rolls back auth.json when codex login status rejects the newly written login', async () => {
    await addAll();
    const rejectB = vi.fn(async (_f, _a, { env: e }) => ({ code: readFileSync(join(e.CODEX_HOME, 'auth.json'), 'utf8').includes('refresh-b') ? 1 : 0, stdout: '', stderr: '' }));
    expect(await rotateAccount({}, deps({ run: rejectB }))).toMatchObject({ retry: true, error: expect.stringContaining('previous login was restored') });
    expect(live()).toBe(auth('a'));
    expect(rotationState(dir, 'codex').accounts.find(a => a.email === 'b@example.com').error).toMatch(/Sign in again/);
    expect(readdirSync(join(home, '.codex')).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
  it('rolls back to the previous login when the new one does not verify, and recovers an interrupted switch', async () => {
    await addAll();
    const failing = deps({ activate: async s => { if (s.email === 'b@example.com') throw Error('token details'); return activateCodexLogin(s, deps()); } });
    expect(await rotateAccount({ id: rotationState(dir, 'codex').accounts[1].id }, failing)).toMatchObject({ retry: true, error: expect.stringContaining('previous login was restored') });
    expect(live()).toBe(auth('a'));
    const s = rotationState(dir, 'codex');
    writeFileSync(join(dir, 'codex-account-rotation.json'), JSON.stringify({ ...s, pending: { from: s.active, to: s.accounts[1].id } }));
    write('.codex', auth('b'));
    expect(await recoverRotation(undefined, deps())).toMatchObject({ ok: true });
    expect(live()).toBe(auth('a'));
    expect(rotationState(dir, 'codex')).toMatchObject({ pending: null, enabled: false });
  });
});

// Settings shows one list: one switch and one order over both registries.
describe('one account list for Claude and Codex', () => {
  // Claude logins are in-memory fixtures here; no real ~/.claude* is read.
  const claudeLogin = name => ({ email: `${name}@example.com`, fields: { oauthAccount: { accountUuid: name, emailAddress: `${name}@example.com` } }, secret: `secret-${name}`, folder: `/claude-${name}` });
  const claudeDeps = () => ({ dir, now: () => 1_000_000, capture: async folder => claudeLogin(folder === null ? 'x' : folder.slice(1)), activate: async () => {} });
  const ids = cli => publicRotationState(dir, undefined, cli).accounts;
  it('turns on by default at two selected accounts counted across both CLIs', async () => {
    await addRotationAccount('/x', claudeDeps());   // one Claude login: the default x
    expect(rotationOn(dir)).toBe(false);
    await addRotationAccount(join(home, '.codex'), deps());   // one Codex login: a
    expect(rotationOn(dir)).toBe(true);
  });
  // Value: protects=an off saved through the one list stays off when the other CLI's logins are discovered;
  //   fails_when=default-on looks only at the registry being added to; why_new=default-on now counts both CLIs; seam=none
  it('keeps a saved off when the other CLI\'s logins are found later', async () => {
    await addRotationAccount('/y', claudeDeps());
    await configureRotation({ enabled: false, accounts: ids('claude').map(({ id }) => ({ id, enabled: true })) }, claudeDeps());
    await addRotationAccount(join(home, '.codex-b'), deps());
    expect(rotationOn(dir)).toBe(false);
  });
  it('saves one mixed order into both registries, ranked, and refuses a list missing either CLI', async () => {
    await addRotationAccount('/y', claudeDeps());
    await addRotationAccount(join(home, '.codex-b'), deps());
    const [x, y] = ids('claude'), [a, b] = ids('codex');
    expect(await configureRotation({ enabled: true, accounts: [x, y].map(({ id }) => ({ id, enabled: true })) }, deps())).toMatchObject({ error: 'Invalid rotation settings.' });
    const order = [a, x, b, y].map(({ id }, i) => ({ id, enabled: i !== 3 }));
    expect(await configureRotation({ enabled: true, accounts: order }, deps())).toEqual({ ok: true });
    expect(ids('claude').map(r => [r.email, r.rank, r.enabled])).toEqual([['x@example.com', 1, true], ['y@example.com', 3, false]]);
    expect(ids('codex').map(r => [r.email, r.rank])).toEqual([['a@example.com', 0], ['b@example.com', 2]]);
    for (const cli of ['claude', 'codex']) expect(rotationState(dir, cli)).toMatchObject({ enabled: true, defaultSettings: false });
    expect(rotationState(dir, 'codex')).not.toHaveProperty('fallback');
    // Two selected across both CLIs are enough; one is not.
    expect((await configureRotation({ enabled: true, accounts: order.map((o, i) => ({ ...o, enabled: i === 0 })) }, deps())).error).toMatch(/at least two/);
  });
  it('refuses to save while either CLI has an interrupted switch, and recovery turns switching off for both', async () => {
    await addRotationAccount('/y', claudeDeps());
    await addRotationAccount(join(home, '.codex-b'), deps());
    const all = [...ids('claude'), ...ids('codex')].map(({ id }) => ({ id, enabled: true }));
    await configureRotation({ enabled: true, accounts: all }, deps());
    const s = rotationState(dir, 'codex');
    writeFileSync(join(dir, 'codex-account-rotation.json'), JSON.stringify({ ...s, pending: { from: s.active, to: s.accounts[1].id } }));
    expect((await configureRotation({ enabled: false, accounts: all }, claudeDeps())).error).toMatch(/interrupted/);
    expect(await recoverRotation(undefined, deps())).toMatchObject({ ok: true });
    expect(rotationOn(dir)).toBe(false);
    expect(rotationState(dir, 'claude').enabled).toBe(false);
  });
});

describe('Codex reset times', () => {
  const now = new Date(2026, 9, 8, 12, 0).getTime();
  const at = (...a) => new Date(...a).getTime();
  it('reads the local reset Codex prints, with or without a date, year or time', () => {
    expect(retryAt('or try again at Oct 25th, 2026 3:15 PM.', now)).toBe(at(2026, 9, 25, 15, 15));
    expect(retryAt('or try again at Oct 25', now)).toBe(at(2026, 9, 25));
    expect(retryAt('or try again at 3:15 PM.', now)).toBe(at(2026, 9, 8, 15, 15));
    expect(retryAt('or try again at 9:15 AM.', now)).toBe(at(2026, 9, 9, 9, 15));      // already past today
    expect(retryAt('tryagainat Jan 3rd, 9:00 AM', now)).toBe(at(2027, 0, 3, 9));        // spaces lost, next year
    expect(retryAt('try again in 2 days 3 hours', now)).toBe(now + (51 * 60) * 60_000);
    expect(retryAt('try again at 16:05', now)).toBe(at(2026, 9, 8, 16, 5));                 // 24-hour clock
    expect(retryAt('try again at Oct 25 12:30 AM', now)).toBe(at(2026, 9, 25, 0, 30));     // just after midnight
  });
  it('falls back to the 30-minute retry delay when there is no usable reset', () => {
    expect(retryAt("You've hit your usage limit.", now)).toBe(now + RETRY_MS);
    expect(retryAt('try again at Oct 7, 2026 1:00 AM', now)).toBe(now + RETRY_MS);
  });
  // Value: protects=a reset under a minute away (Claude or Codex wording) still waits at least 60s before the account is retried;
  //   fails_when=the Math.max(…, now + 60_000) floor in retryAt is dropped for either the relative or the absolute branch;
  //   why_new=the rows above use resets hours or days away; seam=none
  it('waits at least a minute for a reset that is less than a minute away', () => {
    const soon = now - 30_000;   // 11:59:30, so 12:00 PM is 30s away
    expect(retryAt('or try again at 12:00 PM.', soon)).toBe(soon + 60_000);
    expect(retryAt('Limit reached; resets in 0m', now)).toBe(now + 60_000);
    expect(retryAt(`resets ${new Date(now + 10_000).toISOString().slice(0, 19)}Z`, now)).toBe(now + 60_000);
  });
});

describe('Codex sessions across a switch', () => {
  const id = '019a0000-0000-7000-8000-00000000c0de';
  it('resumes the exact conversation with the session\'s own options and without its old prompt', () => {
    const cmd = resumeCodexCommand('codex --sandbox read-only --ask-for-approval on-request -m gpt-5.5 -c model_reasoning_effort=high "Ship card 9"', id);
    expect(parseCommand(cmd).args).toEqual(['resume', id, '--sandbox', 'read-only', '--ask-for-approval', 'on-request', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=high', expect.stringContaining('interrupted conversation')]);
    expect(cmd).not.toContain('Ship card 9');
    // Every spelling lib/jobs.js accepts as a Codex permission flag survives.
    expect(parseCommand(resumeCodexCommand('codex --yolo -sread-only -a=never "task"', id)).args.slice(2, 5)).toEqual(['--yolo', '-sread-only', '-a=never']);
    // Billion's own form, already resuming another id.
    const billion = resumeCodexCommand(`codex resume 019a0000-0000-7000-8000-000000000001 --dangerously-bypass-approvals-and-sandbox 'You were restarted.'`, id);
    expect(parseCommand(billion).args.slice(0, 3)).toEqual(['resume', id, '--dangerously-bypass-approvals-and-sandbox']);
  });
  it('refuses an unknown conversation or an unsupported option before stopping anything', async () => {
    expect(() => resumeCodexCommand('codex', null)).toThrow(/exact Codex conversation/);
    // Value: protects=a Codex restart drops --last and anything after --, keeps --opt=value, and refuses a dangling value or a second positional;
    //   fails_when=resumeCodexCommand's --last, --, = or refusal branches change; why_new=the rows above cover only spaced values and one prompt; seam=none
    expect(parseCommand(resumeCodexCommand('codex resume --last --model=gpt-5.5 -- "old"', id)).args.slice(0, 3)).toEqual(['resume', id, '--model=gpt-5.5']);
    expect(() => resumeCodexCommand('codex -m', id)).toThrow(/Missing -m value/);
    expect(() => resumeCodexCommand('codex "one" "two"', id)).toThrow(/separate the Codex prompt/);
    const stop = vi.fn(), fn = vi.fn();
    await expect(withClaudeSessionsStopped(fn, { agent: 'codex', list: () => [{ agent: 'codex', command: 'codex --worktree' }], idFor: () => id, stop, start: vi.fn() })).rejects.toThrow(/does not support --worktree/);
    await expect(withClaudeSessionsStopped(fn, { agent: 'codex', list: () => [{ agent: 'codex', command: 'codex' }], idFor: () => null, stop, start: vi.fn() })).rejects.toThrow(/exact Codex conversation/);
    expect(stop).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
  it('stops only Codex sessions, swaps, then resumes each on `codex resume <id>`', async () => {
    const events = [];
    const sessions = [{ id: 'w', agent: 'codex', command: 'codex -m gpt-5.5 "card"' }, { id: 'c', agent: 'claude', command: 'claude' }];
    await withClaudeSessionsStopped(async () => { events.push('swap'); return { ok: true }; }, {
      agent: 'codex', list: () => sessions, idFor: () => id,
      stop: async s => { events.push(`stop-${s.id}`); return []; },
      start: async r => { events.push(`start-${r.session.id}`); expect(parseCommand(r.command).args.slice(0, 2)).toEqual(['resume', id]); },
    });
    expect(events).toEqual(['stop-w', 'swap', 'start-w']);
  });
  it('counts an outside codex as blocking but lets the app\'s own sessions and the background server through', async () => {
    const DAEMON = '/Users/x/.codex/packages/app-server-daemon/releases/0.162.0/bin/codex app-server --listen unix:// --managed-daemon';
    const LOOP = '/Users/x/.codex/packages/app-server-daemon/releases/0.162.0/bin/codex app-server daemon pid-update-loop';
    expect(isCodexDaemon(DAEMON)).toBe(true);
    expect(isCodexDaemon(LOOP)).toBe(true);
    expect(isCodexDaemon('codex resume 1')).toBe(false);
    // Only as the subcommand: a prompt that names it is an ordinary outside codex.
    expect(isCodexDaemon("codex exec 'run codex app-server --managed-daemon for me'")).toBe(false);
    expect(isCodexDaemon('node /n/@openai/codex/bin/codex.js app-server daemon pid-update-loop')).toBe(true);
    const rows = [{ pid: 10, ppid: 1, command: 'node /n/@openai/codex/bin/codex.js' }, { pid: 11, ppid: 10, command: '/n/vendor/codex' },
      { pid: 20, ppid: 1, command: DAEMON }, { pid: 21, ppid: 1, command: LOOP }, { pid: 30, ppid: 1, command: '/opt/bin/codex exec hi' }, { pid: 40, ppid: 1, command: 'claude' }];
    expect(externalClaudePids(rows, new Set([10]), 'codex')).toEqual([30]);
    const ps = out => (_f, _a, _o, cb) => cb(null, out);
    const opts = { agent: 'codex', platform: 'darwin', getuid: () => 1 };
    await expect(assertClaudeProcessesManaged([], { ...opts, run: ps(`20 1 ${DAEMON}\n30 1 /opt/bin/codex exec hi\n`) })).rejects.toThrow(/Another Codex process/);
    await expect(assertClaudeProcessesManaged([], { ...opts, run: ps(`20 1 ${DAEMON}\n40 1 claude\n`) })).resolves.toEqual({ daemon: true });
    await expect(assertClaudeProcessesManaged([], { ...opts, run: ps('40 1 claude\n') })).resolves.toEqual({ daemon: false });
  });
});

// Value: protects=a Codex switch or an interrupted Codex switch refuses only Codex spawns, and Claude's gate refuses only Claude;
//   fails_when=pty.js's spawn gate or pending check ignores which CLI is switching, blocking or letting through the wrong agent;
//   why_new=account-rotation-server.test.js covers the Claude pending block only, never per-CLI isolation; seam=none
describe.skipIf(!POSIX)('the per-CLI spawn gate', () => {
  it('refuses Codex while Codex switches or is interrupted, and leaves Claude alone (and back)', async () => {
    const { createSessionFromConfig, blockSpawns } = await import('../server/pty.js');
    const { CONFIG_DIR } = await import('../server/state.js');
    const bin = join(home, 'bin'); mkdirSync(bin);
    for (const name of ['codex', 'claude']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const made = [];
    const spawn = name => { const r = createSessionFromConfig({ sessionId: `gate-${Math.random()}`, name: 'G', color: '#000', command: join(bin, name), cwd: home }, () => {}); if (r.session) made.push(r.session); return r; };
    const pendingFile = join(CONFIG_DIR, 'codex-account-rotation.json');
    try {
      blockSpawns(true, 'codex');
      expect(spawn('codex').error).toMatch(/Codex accounts are switching/);
      expect(spawn('claude').error).toBeUndefined();
      blockSpawns(true, 'claude');
      expect(spawn('claude').error).toMatch(/Claude accounts are switching/);
      expect(spawn('codex').error).toBeUndefined();
      blockSpawns(false);
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(pendingFile, JSON.stringify({ enabled: true, accounts: [], pending: { from: 'a'.repeat(64), to: 'b'.repeat(64) } }));
      expect(spawn('codex').error).toMatch(/Restore the interrupted Codex login/);
      expect(spawn('claude').error).toBeUndefined();
    } finally {
      blockSpawns(false);
      removeTempDir(pendingFile);
      for (const s of made) { try { s.pty.kill(); } catch {} clearInterval(s.stateCheckInterval); clearTimeout(s.scanTimer); }
    }
  });
});
