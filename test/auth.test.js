import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
import * as auth from '../server/auth.js';

// USERS_PATH points at the hermetic throwaway path from test/setup.js.
afterEach(() => { try { rmSync(auth.USERS_PATH, { force: true }); } catch {} });

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

  it('tokenFromRequest reads the Authorization header, then ?token=', () => {
    expect(auth.tokenFromRequest({ headers: { authorization: 'Bearer abc' }, url: '/' })).toBe('abc');
    expect(auth.tokenFromRequest({ headers: {}, url: '/?token=xyz' })).toBe('xyz');
    expect(auth.tokenFromRequest({ headers: {}, url: '/' })).toBeNull();
  });
});
