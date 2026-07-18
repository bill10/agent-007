// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  captureTokenFromUrl, authHeaders, getToken, setToken, clearToken,
} from '../public/modules/auth.js';

describe('client auth module', () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, '', '/');
  });

  it('captures ?token= into localStorage and strips it from the URL', () => {
    history.replaceState(null, '', '/?token=abc&keep=1');
    captureTokenFromUrl();
    expect(getToken()).toBe('abc');
    expect(location.search).not.toMatch(/token=/);
    expect(location.search).toMatch(/keep=1/);
  });

  it('is a no-op when no token is in the URL', () => {
    captureTokenFromUrl();
    expect(getToken()).toBe('');
  });

  it('authHeaders is empty without a token and Bearer with one', () => {
    expect(authHeaders()).toEqual({});
    setToken('abc');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer abc' });
    clearToken();
    expect(authHeaders()).toEqual({});
  });
});
