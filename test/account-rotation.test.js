import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { addRotationAccount, configureRotation, rotateAccount, recoverRotation, publicRotationState, rotationState, retryAt, RETRY_MS } from '../server/account-rotation.js';
import { resetInFlight } from '../server/account-migration.js';

let dir, live, logins, deps, now, actions;
const login = name => ({ email: `${name}@example.com`, fields: { oauthAccount: { accountUuid: name, emailAddress: `${name}@example.com` } }, secret: `secret-${name}`, folder: `/claude-${name}` });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rotation-')); now = 1_000_000; actions = [];
  logins = { '/a': login('a'), '/b': login('b'), '/c': login('c') }; live = structuredClone(logins['/a']);
  deps = { dir, now: () => now, capture: async folder => { if (folder === null) return structuredClone(live); if (!logins[folder]) throw Error(); return structuredClone(logins[folder]); }, activate: async s => { actions.push(s.email); live = structuredClone(s); } };
  resetInFlight();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const add = async () => {
  await addRotationAccount('/b', deps); await addRotationAccount('/c', deps);
  await configure({ accounts: publicRotationState(dir).accounts.map(a => ({ id: a.id, enabled: true })) });
};
const configure = async (over = {}) => configureRotation({ enabled: true, fallback: true, accounts: publicRotationState(dir).accounts.map(({ id, enabled }) => ({ id, enabled })), ...over }, deps);

describe('account rotation', () => {
  it('does not enroll either account when the source login cannot be read', async () => {
    expect(await addRotationAccount('/missing', deps)).toMatchObject({ error: expect.stringContaining('Could not read') });
    expect(rotationState(dir).accounts).toEqual([]);
    expect(actions).toEqual([]);
  });

  it('keeps a failed recovery pending and prevents enabling or enrolling accounts', async () => {
    await add();
    const saved = rotationState(dir);
    saved.pending = { from: saved.active, to: saved.accounts[1].id };
    writeFileSync(join(dir, 'account-rotation.json'), JSON.stringify(saved));
    deps.activate = async () => { throw Error('secret details'); };
    expect(await recoverRotation(undefined, deps)).toMatchObject({ error: expect.stringContaining('recovery record has been kept') });
    expect(rotationState(dir).pending).toEqual(saved.pending);
    expect((await configure()).error).toMatch(/interrupted/);
    expect((await addRotationAccount('/b', deps)).error).toMatch(/interrupted/);
  });

  it('enables rotation by default when the second distinct account is added, including after restart', async () => {
    expect(publicRotationState(dir)).toMatchObject({ enabled: false, defaultSettings: true });
    await addRotationAccount('/a', deps);
    expect(rotationState(dir).enabled).toBe(false);
    resetInFlight();
    await addRotationAccount('/b', deps);
    expect(rotationState(dir).enabled).toBe(true);
    expect(publicRotationState(dir).accounts.every(a => a.enabled)).toBe(true);
    await addRotationAccount('/c', deps);
    expect(publicRotationState(dir).accounts.at(-1).enabled).toBe(false);
  });

  it('preserves an explicitly disabled setting when accounts are added or rediscovered', async () => {
    await addRotationAccount('/a', deps);
    await configure({ enabled: false });
    await addRotationAccount('/b', deps);
    await addRotationAccount('/a', deps);
    expect(rotationState(dir)).toMatchObject({ enabled: false, defaultSettings: false });
  });

  it('preserves old saved off settings without a default marker', async () => {
    await addRotationAccount('/a', deps);
    const saved = rotationState(dir);
    delete saved.defaultSettings;
    writeFileSync(join(dir, 'account-rotation.json'), JSON.stringify(saved));
    await addRotationAccount('/b', deps);
    expect(rotationState(dir).enabled).toBe(false);
  });

  it('cycles A -> B -> C -> A with the refreshed A credential, never a source-folder stale copy', async () => {
    await add(); await configure();
    live.secret = 'secret-a-refreshed';
    expect(await rotateAccount({}, deps)).toMatchObject({ ok: true, newEmail: 'b@example.com' });
    expect(await rotateAccount({}, deps)).toMatchObject({ ok: true, newEmail: 'c@example.com' });
    await addRotationAccount('/a', deps); // discovery must not overwrite saved A
    expect(await rotateAccount({}, deps)).toMatchObject({ ok: true, newEmail: 'a@example.com' });
    expect(live.secret).toBe('secret-a-refreshed');
    const pub = JSON.stringify(publicRotationState(dir));
    expect(pub).not.toMatch(/secret|oauthAccount|refreshToken/);
    expect(rotationState(dir).enabled).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'account-logins', `${rotationState(dir).active}.json`)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'account-rotation.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('skips limited accounts, persists cooldown, then returns after reset', async () => {
    await add(); await configure();
    await rotateAccount({ limited: true, line: 'resets in 1h' }, deps);
    await rotateAccount({ limited: true }, deps);
    const result = await rotateAccount({ limited: true }, deps);
    expect(result).toMatchObject({ exhausted: true, fallback: true, retryAt: now + RETRY_MS });
    expect(publicRotationState(dir, now).accounts[0].limitedUntil).toBe(now + 3600000);
    resetInFlight(); // a server restart does not forget account limits
    expect(await rotateAccount({}, deps)).toMatchObject({ exhausted: true });
    now += RETRY_MS + 1;
    expect(await rotateAccount({ allowCurrent: true }, deps)).toMatchObject({ ok: true, newEmail: 'b@example.com' });
  });

  it('prepares a healthy current login without stopping sessions or activating another account', async () => {
    await add();
    const before = rotationState(dir).active;
    let stopped = false;
    const result = await rotateAccount({ allowCurrent: true, preferCurrent: true, around: async fn => { stopped = true; return fn(); } }, deps);
    expect(result).toMatchObject({ ok: true });
    expect(stopped).toBe(false);
    expect(actions).toEqual([]);
    expect(rotationState(dir).active).toBe(before);
  });

  it('applies explicit inclusion and ordering and adds new discoveries disabled while running', async () => {
    await add();
    const [a, b, c] = publicRotationState(dir).accounts;
    await configure({ accounts: [a, c, { ...b, enabled: false }] });
    await rotateAccount({}, deps);
    expect(live.email).toBe('c@example.com');
    logins['/d'] = login('d'); await addRotationAccount('/d', deps);
    expect(publicRotationState(dir).accounts.at(-1).enabled).toBe(false);
    expect((await configure({ accounts: [a, a, b, c] })).error).toMatch(/Invalid/);
  });

  it('does not postpone the reset every time the same limit is seen', async () => {
    await add();
    await rotateAccount({ limited: true }, deps);
    const a = rotationState(dir).accounts[0];
    now += 1000;
    await rotateAccount({ limited: true }, deps);
    expect(rotationState(dir).accounts[0].limitedUntil).toBe(a.limitedUntil);
  });

  it('rolls back a failed activation and tries the next account on the next tick', async () => {
    await add();
    const real = deps.activate;
    deps.activate = async s => { if (s.email === 'b@example.com') { live.secret = 'half-written'; throw new Error('secret-must-not-leak'); } await real(s); };
    expect(await rotateAccount({ limited: true }, deps)).toMatchObject({ retry: true });
    expect(live.email).toBe('a@example.com');
    expect(live.secret).toBe('secret-a');
    expect(rotationState(dir).pending).toBeNull();
    expect(JSON.stringify(publicRotationState(dir))).not.toContain('secret-must-not-leak');
    expect(await rotateAccount({ limited: true }, deps)).toMatchObject({ ok: true, newEmail: 'c@example.com' });
  });

  it('keeps a recovery journal after rollback fails, blocks more swaps and restores the previous login', async () => {
    await add();
    const real = deps.activate;
    deps.activate = async () => { throw new Error('failed'); };
    expect(await rotateAccount({}, deps)).toMatchObject({ blocked: true });
    expect(publicRotationState(dir).pending).toBe(true);
    expect((await rotateAccount({}, deps)).error).toMatch(/interrupted/);
    deps.activate = real;
    expect(await recoverRotation(undefined, deps)).toMatchObject({ ok: true });
    expect(live.email).toBe('a@example.com');
    expect(publicRotationState(dir)).toMatchObject({ pending: false, enabled: false });
    await addRotationAccount('/b', deps);
    expect(rotationState(dir).enabled).toBe(false);
  });

  it('recovers a crash after activation but before committing the active-account record', async () => {
    await add();
    const s = rotationState(dir);
    s.pending = { from: s.active, to: s.accounts[1].id };
    writeFileSync(join(dir, 'account-rotation.json'), JSON.stringify(s));
    live = structuredClone(logins['/b']);
    await recoverRotation(undefined, deps);
    expect(live.email).toBe('a@example.com');
  });

  it('serializes simultaneous requests across the entire stop/swap/resume operation', async () => {
    await add();
    let release;
    const first = rotateAccount({ around: async fn => { await new Promise(r => { release = r; }); return fn(); } }, deps);
    await Promise.resolve();
    expect((await rotateAccount({}, deps)).error).toMatch(/Another Claude account action/);
    release(); await first;
    expect(actions).toEqual(['b@example.com']);
  });

  it('refuses an external login change, invalid settings and damaged registry without changing auth', async () => {
    await add();
    live = login('outside');
    expect(await rotateAccount({}, deps)).toMatchObject({ blocked: true });
    expect(actions).toEqual([]);
    expect((await configure({ accounts: [] })).error).toMatch(/Invalid/);
    writeFileSync(join(dir, 'account-rotation.json'), '{bad');
    expect(publicRotationState(dir).damaged).toBe(true);
    expect((await addRotationAccount('/b', deps)).error).toMatch(/could not be read/);
    expect(readFileSync(join(dir, 'account-rotation.json'), 'utf8')).toBe('{bad');
  });

  it('uses explicit reset times and a bounded fallback for ambiguous local clock labels', () => {
    expect(retryAt('resets in 2h 15m', now)).toBe(now + 135 * 60_000);
    expect(retryAt('resets 2026-10-01T10:00:00Z', now)).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(retryAt('resets 3pm', now)).toBe(now + RETRY_MS);
  });
});
