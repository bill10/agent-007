import { describe, it, expect, vi, afterEach } from 'vitest';
import { isAllowedOrigin } from '../server/state.js';

// The origin allowlist is the sole cross-origin defense for both HTTP
// (server/http.js checkOrigin) and WebSocket (server/ws.js verifyClient).
// These tests pin its truth table so a refactor can't silently open the boundary.

describe('isAllowedOrigin — default allowlist', () => {
  it('allows requests with no Origin header (same-origin / curl / native WS)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('allows loopback origins on any port/scheme (incl. IPv6 [::1])', () => {
    expect(isAllowedOrigin('http://localhost:7007')).toBe(true);
    expect(isAllowedOrigin('https://localhost')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:7007')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:7007')).toBe(true);
  });

  it('rejects a non-whitelisted host', () => {
    expect(isAllowedOrigin('http://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('http://mac-mini.tailXXXX.ts.net:7007')).toBe(false);
  });

  it('rejects a malformed origin string', () => {
    expect(isAllowedOrigin('not a url')).toBe(false);
    expect(isAllowedOrigin('http://')).toBe(false);
  });
});

describe('isAllowedOrigin — env-configured allowlist', () => {
  // state.js reads process.env at module load, so re-import per case.
  afterEach(() => { delete process.env.ALLOWED_ORIGINS; vi.resetModules(); });
  async function load(val) {
    process.env.ALLOWED_ORIGINS = val;
    vi.resetModules();
    return (await import('../server/state.js')).isAllowedOrigin;
  }

  it('allows a whitelisted bare hostname, still rejects others', async () => {
    const fn = await load('mac-mini.tailXXXX.ts.net');
    expect(fn('http://mac-mini.tailXXXX.ts.net:7007')).toBe(true);
    expect(fn('http://other.example.com')).toBe(false);
  });

  it('allows a whitelisted host:port entry (regression: was a silent lockout)', async () => {
    const fn = await load('mac-mini.ts.net:7007');
    expect(fn('http://mac-mini.ts.net:7007')).toBe(true);
  });

  it('allows a whitelisted full origin (only the hostname is used)', async () => {
    const fn = await load('https://mac-mini:7007');
    expect(fn('http://mac-mini:9999')).toBe(true);
  });

  it('allows any origin when ALLOWED_ORIGINS contains "*"', async () => {
    const fn = await load('*');
    expect(fn('http://evil.example.com')).toBe(true);
    expect(fn('garbage')).toBe(true);
  });
});
