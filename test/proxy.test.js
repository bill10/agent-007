// Running behind a reverse proxy or tunnel (PUBLIC_URL, docs/REMOTE.md): the
// origin it lets in, the forwarded headers it believes, and the links it builds.
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parsePublicUrl } from '../server/state.js';
import { noteProxy, proxySeen, accessEmail } from '../server/proxy.js';
import { appLink } from '../server/rounds.js';
import { setupProxy } from '../server/remote-setup.js';
import { remoteLines } from '../server/service.js';
import { removeTempDir } from './temp-dir.js';

describe('PUBLIC_URL', () => {
  afterEach(() => { delete process.env.PUBLIC_URL; vi.resetModules(); });
  // state.js reads process.env when it loads.
  async function load(mod, val) {
    process.env.PUBLIC_URL = val;
    vi.resetModules();
    return import(mod);
  }

  it('is the origin of an http(s) URL, else null', () => {
    expect(parsePublicUrl('https://agent.example.com')).toBe('https://agent.example.com');
    expect(parsePublicUrl(' https://agent.example.com/some/path/ ')).toBe('https://agent.example.com');
    expect(parsePublicUrl('https://agent.example.com:8443')).toBe('https://agent.example.com:8443');
    expect(parsePublicUrl('http://10.0.0.1:8080')).toBe('http://10.0.0.1:8080');
    for (const bad of [undefined, '', 'agent.example.com', 'ftp://agent.example.com', 'not a url']) expect(parsePublicUrl(bad)).toBeNull();
  });

  it('lets its hostname in as an origin, and no other', async () => {
    const { isAllowedOrigin, PUBLIC_URL } = await load('../server/state.js', 'https://agent.example.com');
    expect(PUBLIC_URL).toBe('https://agent.example.com');
    expect(isAllowedOrigin('https://agent.example.com')).toBe(true);
    expect(isAllowedOrigin('http://localhost:7007')).toBe(true);
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('https://agent.example.com.evil.com')).toBe(false);
    const off = await load('../server/state.js', '');
    expect(off.isAllowedOrigin('https://agent.example.com')).toBe(false);
  });

  it("counts its page as the owner's browser even when the proxy sends its own Host", async () => {
    const { fromBrowser } = await load('../server/ws.js', 'https://agent.example.com');
    const req = (origin, host) => ({ headers: { origin, host } });
    expect(fromBrowser(req('https://agent.example.com', '127.0.0.1:7007'))).toBe(true);
    expect(fromBrowser(req('https://agent.example.com', 'agent.example.com'))).toBe(true);
    expect(fromBrowser(req('http://localhost:7007', 'localhost:7007'))).toBe(true);
    expect(fromBrowser(req('https://evil.example.com', '127.0.0.1:7007'))).toBe(false);
    expect(fromBrowser(req(undefined, '127.0.0.1:7007'))).toBe(false);
  });

  it('is where Telegram links point, ahead of APP_URL and ALLOWED_ORIGINS', () => {
    expect(appLink({ PUBLIC_URL: 'https://agent.example.com/', APP_URL: 'https://old', ALLOWED_ORIGINS: 'mini.ts.net' })).toBe('https://agent.example.com');
    expect(appLink({ PUBLIC_URL: 'garbage', APP_URL: 'https://old' })).toBe('https://old');
  });
});

describe('forwarded headers (server/proxy.js)', () => {
  // A real Express app with the server's trust setting, on loopback.
  async function serve() {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(noteProxy);
    app.get('/', (req, res) => res.json({ proto: req.protocol, ip: req.ip, email: accessEmail(req) }));
    const server = createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(r => server.close(r)) };
  }

  it("believes a loopback proxy's X-Forwarded-Proto/For and notes the newest request", async () => {
    const s = await serve();
    try {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const headers = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9', 'Cf-Access-Authenticated-User-Email': 'ada@example.com' };
      expect(await (await fetch(s.url, { headers })).json()).toEqual({ proto: 'https', ip: '203.0.113.9', email: 'ada@example.com' });
      expect(proxySeen()).toMatchObject({ proto: 'https', ip: '203.0.113.9', email: 'ada@example.com' });
      await fetch(s.url, { headers });
      expect(log.mock.calls.filter(([l]) => l.includes('ada@example.com'))).toHaveLength(1);
      log.mockRestore();
      // A plain request (no proxy) changes nothing it noted.
      const before = proxySeen();
      expect(await (await fetch(s.url)).json()).toMatchObject({ proto: 'http', email: null });
      expect(proxySeen()).toBe(before);
    } finally { await s.close(); }
  });

  it("says which mode status is in and what the proxy last sent", () => {
    const p = { at: 0, proto: 'https', ip: '203.0.113.9', email: 'ada@example.com' };
    expect(remoteLines({ publicUrl: 'https://a.example', proxy: p }, 120_000)).toEqual([
      '  remote: reverse proxy at https://a.example (PUBLIC_URL)',
      '  proxy headers: last forwarded request 2m ago: https from 203.0.113.9, Cloudflare Access user ada@example.com']);
    expect(remoteLines({ publicUrl: 'https://a.example', proxy: null })[1]).toContain('none since the start');
    expect(remoteLines({ publicUrl: null, proxy: null })).toEqual(['  remote: no PUBLIC_URL (local only, or Tailscale, which doctor checks)']);
  });
});

describe('install --public-url (setupProxy)', () => {
  function ctx(over = {}) {
    const home = mkdtempSync(join(tmpdir(), 'a007-proxy-'));
    const out = [];
    return { home, out, cfg: join(home, '.agent-007'), port: 7123, host: '127.0.0.1', root: home, env: { HOME: home, AGENT007_CONFIG_DIR: join(home, '.agent-007') }, log: (s) => out.push(s), err: (s) => out.push(`ERR ${s}`), ...over };
  }

  it('writes PUBLIC_URL to the settings file, keeping what is there', () => {
    const c = ctx();
    try {
      mkdirSync(c.cfg, { recursive: true });
      writeFileSync(join(c.cfg, '.env'), 'PORT=7123\n');
      expect(setupProxy(c, 'https://agent.example.com/')).toBe(0);
      expect(readFileSync(join(c.cfg, '.env'), 'utf8')).toMatch(/PORT=7123\n[\s\S]*PUBLIC_URL=https:\/\/agent\.example\.com\n/);
      expect(c.out.join('\n')).toContain('http://127.0.0.1:7123');
      expect(c.out.join('\n')).not.toContain('ERR');
      expect(setupProxy(c, 'https://agent.example.com')).toBe(0);
      expect(c.out.at(-2)).toContain('already https://agent.example.com');
    } finally { removeTempDir(c.home); }
  });

  it('refuses a non-URL, and warns about http, a wildcard HOST and an overriding setting', () => {
    const c = ctx({ host: '0.0.0.0' });
    c.env.PUBLIC_URL = 'https://other';
    try {
      expect(setupProxy(c, 'agent.example.com')).toBe(2);
      expect(c.out.join('\n')).toContain('Nothing was changed');
      expect(setupProxy({ ...c, 'dry-run': true }, 'http://agent.example.com')).toBe(0);
      const said = c.out.join('\n');
      expect(said).toContain('Would set PUBLIC_URL=http://agent.example.com');
      expect(said).toContain('ERR ! PUBLIC_URL is also set in your environment');
      expect(said).toContain('ERR ! That is not https');
      expect(said).toContain('ERR ! HOST=0.0.0.0');
    } finally { removeTempDir(c.home); }
  });
});
