import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
import * as auth from '../server/auth.js';

// USERS_PATH points at the hermetic throwaway path from test/setup.js.
// Remove the file AND call loadUsers() so the module's mtime cache resets to
// the no-file state (otherwise last-known-good could bleed across tests).
afterEach(() => {
  try { rmSync(auth.USERS_PATH, { force: true }); } catch {}
  auth.loadUsers();
});

describe('auth core', () => {
  it('authEnabled is false when no users file exists', () => {
    expect(auth.authEnabled()).toBe(false);
  });

  it('hashToken is deterministic and does not leak the token', () => {
    const t = auth.generateToken();
    expect(auth.hashToken(t)).toBe(auth.hashToken(t));
    expect(auth.hashToken(t)).not.toContain(t);
    expect(auth.hashToken(t)).toHaveLength(64);
  });

  it('resolves a valid token and rejects wrong/empty once a user exists', () => {
    const token = auth.generateToken();
    writeFileSync(auth.USERS_PATH, JSON.stringify([
      { id: 'u_a', displayName: 'Alice', color: '#d4a847', tokenHash: auth.hashToken(token) },
    ]));
    expect(auth.authEnabled()).toBe(true);
    expect(auth.resolveToken(token).displayName).toBe('Alice');
    expect(auth.resolveToken('wrong-token')).toBeNull();
    expect(auth.resolveToken('')).toBeNull();
    expect(auth.resolveToken(null)).toBeNull();
  });

  it('publicUser strips the token hash', () => {
    const u = { id: 'u_a', displayName: 'Alice', color: '#d4a847', tokenHash: 'deadbeef' };
    expect(auth.publicUser(u)).toEqual({ id: 'u_a', displayName: 'Alice', color: '#d4a847' });
    expect('tokenHash' in auth.publicUser(u)).toBe(false);
  });

  it('tokenFromRequest prefers the Authorization header, then ?token=', () => {
    expect(auth.tokenFromRequest({ headers: { authorization: 'Bearer abc' }, url: '/' })).toBe('abc');
    // header wins over query
    expect(auth.tokenFromRequest({ headers: { authorization: 'Bearer abc' }, url: '/?token=xyz' })).toBe('abc');
    // non-Bearer header falls through to the query param
    expect(auth.tokenFromRequest({ headers: { authorization: 'Basic zzz' }, url: '/?token=xyz' })).toBe('xyz');
    expect(auth.tokenFromRequest({ headers: {}, url: '/?token=xyz' })).toBe('xyz');
    expect(auth.tokenFromRequest({ headers: {}, url: '/' })).toBeNull();
    // malformed url must not throw
    expect(auth.tokenFromRequest({ headers: {}, url: undefined })).toBeNull();
  });

  it('unwraps the { users: [...] } object form', () => {
    const token = auth.generateToken();
    writeFileSync(auth.USERS_PATH, JSON.stringify({ users: [
      { id: 'u_a', displayName: 'Alice', color: '#d4a847', tokenHash: auth.hashToken(token) },
    ] }));
    expect(auth.loadUsers()).toHaveLength(1);
    expect(auth.resolveToken(token).displayName).toBe('Alice');
    writeFileSync(auth.USERS_PATH, JSON.stringify({ users: 'nope' }));
    expect(auth.loadUsers()).toEqual([]);
  });

  it('skips malformed user records (missing/short tokenHash) without throwing', () => {
    const token = auth.generateToken();
    writeFileSync(auth.USERS_PATH, JSON.stringify([
      { id: 'u_bad', displayName: 'NoHash' },
      { id: 'u_short', displayName: 'Short', tokenHash: 'abc' },
      { id: 'u_ok', displayName: 'Ok', color: '#d4a847', tokenHash: auth.hashToken(token) },
    ]));
    expect(auth.resolveToken(token).id).toBe('u_ok');
    expect(auth.resolveToken('whatever')).toBeNull();
  });

  it('picks up users added/removed while running (mtime+size cache)', () => {
    const token = auth.generateToken();
    writeFileSync(auth.USERS_PATH, JSON.stringify([
      { id: 'u_a', displayName: 'A', color: '#d4a847', tokenHash: auth.hashToken(token) },
    ]));
    expect(auth.loadUsers()).toHaveLength(1);
    writeFileSync(auth.USERS_PATH, JSON.stringify([
      { id: 'u_a', displayName: 'A', color: '#d4a847', tokenHash: auth.hashToken(token) },
      { id: 'u_b', displayName: 'B', color: '#58a6ff', tokenHash: auth.hashToken(auth.generateToken()) },
    ]));
    expect(auth.loadUsers()).toHaveLength(2);
    rmSync(auth.USERS_PATH, { force: true });
    expect(auth.authEnabled()).toBe(false);
  });

  it('FAILS CLOSED when users.json exists but is corrupt (no prior good copy)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(auth.USERS_PATH, '{ not valid json');
    // auth stays ON (do not silently disable), but no token resolves
    expect(auth.authEnabled()).toBe(true);
    expect(auth.resolveToken('anything')).toBeNull();
    expect(auth.resolveToken(auth.generateToken())).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('serves last-known-good users if the file becomes corrupt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = auth.generateToken();
    writeFileSync(auth.USERS_PATH, JSON.stringify([
      { id: 'u_a', displayName: 'Alice', color: '#d4a847', tokenHash: auth.hashToken(token) },
    ]));
    expect(auth.resolveToken(token).displayName).toBe('Alice'); // caches good copy
    writeFileSync(auth.USERS_PATH, 'CORRUPT');
    // still resolves the previously-valid token rather than locking everyone out
    expect(auth.resolveToken(token).displayName).toBe('Alice');
    warn.mockRestore();
  });
});
