import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupRemote, addOrigin } from '../server/remote-setup.js';
import { tailscaleBin, serveTargets, MAC_APP_CLI } from '../server/tailscale.js';
import { originHost } from '../server/state.js';
import { runCommand } from '../server/service.js';
import { removeTempDir } from './temp-dir.js';

const NAME = 'mini.tail1.ts.net';
const PORT = 7123;
const RUNNING = { BackendState: 'Running', Self: { DNSName: `${NAME}.` } };
const served = (proxy, host = NAME, port = 443) => ({ TCP: { [port]: { HTTPS: true } }, Web: { [`${host}:${port}`]: { Handlers: { '/': { Proxy: proxy } } } } });

// Never a real tailscale, launchd or ~/.agent-007: a temp HOME and a fake CLI.
function fakeCtx({ status = RUNNING, serve = {}, serveRun, answers = [], running = false, ...over } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'a007-remote-'));
  const cfg = join(home, '.agent-007');
  const out = [], calls = [], asked = [], restarts = [];
  const ctx = {
    home, cfg, out, calls, asked, restarts,
    platform: 'darwin', tty: true, port: PORT, root: home,
    env: { HOME: home, PATH: '/usr/bin', AGENT007_CONFIG_DIR: cfg },
    tailscaleBin: () => '/usr/local/bin/tailscale',
    run: async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return status ? { code: 0, stdout: JSON.stringify(status), stderr: '' } : { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' };
      if (args.join(' ') === 'serve status --json') return { code: 0, stdout: JSON.stringify(serve), stderr: '' };
      return serveRun || { code: 0, stdout: '', stderr: '' };
    },
    write: (s) => out.push(`OUT ${s}`),
    stream: async (cmd, args, o) => {
      calls.push(args.join(' '));
      const r = serveRun || { code: 0, stdout: '', stderr: '' };
      if (r.stdout) o.onData(r.stdout);
      return r;
    },
    ask: async (q) => { asked.push(q); return answers.shift() ?? ''; },
    log: (s) => out.push(s), err: (s) => out.push(`ERR ${s}`),
    cmd: (s) => `agent007 ${s}`,
    ...over,
  };
  const server = { running: async () => running, restart: async () => { restarts.push(1); } };
  return { ctx, server };
}
const text = (c) => c.out.join('\n');
const envFile = (c) => join(c.cfg, '.env');
const changes = (c) => c.calls.filter(a => a.startsWith('serve --bg'));

describe('setupRemote', () => {
  it('serves the port, adds the ts.net name to ALLOWED_ORIGINS (0600), restarts a running server', async () => {
    const { ctx, server } = fakeCtx({ running: true });
    expect(await setupRemote(ctx, server)).toBe(0);
    expect(changes(ctx)).toEqual([`serve --bg ${PORT}`]);
    const env = readFileSync(envFile(ctx), 'utf8');
    expect(env).toContain(`\nALLOWED_ORIGINS=${NAME}\n`);
    expect(env).not.toMatch(/^# ALLOWED_ORIGINS=/m);
    if (process.platform !== 'win32') expect(statSync(envFile(ctx)).mode & 0o777).toBe(0o600);
    expect(ctx.restarts).toEqual([1]);
    expect(ctx.out.at(-1)).toBe(`Open https://${NAME} on any device in your tailnet.`);
    removeTempDir(ctx.home);
  });

  it('keeps a port already served and existing origins, and changes nothing when all is in place', async () => {
    const { ctx, server } = fakeCtx({ serve: served(`http://127.0.0.1:${PORT}`), running: true });
    mkdirSync(ctx.cfg, { recursive: true });
    writeFileSync(envFile(ctx), 'PORT=7123\nALLOWED_ORIGINS=other.example\n');
    expect(await setupRemote(ctx, server)).toBe(0);
    expect(changes(ctx)).toEqual([]);
    expect(readFileSync(envFile(ctx), 'utf8')).toBe(`PORT=7123\nALLOWED_ORIGINS=other.example,${NAME}\n`);
    expect(ctx.restarts).toEqual([1]);
    ctx.out.length = 0;
    expect(await setupRemote(ctx, server)).toBe(0);
    expect(text(ctx)).toMatch(/already lets mini\.tail1\.ts\.net in/);
    expect(ctx.restarts).toEqual([1]);
    removeTempDir(ctx.home);
  });

  it('stops without changing anything when Tailscale is missing, not running or not logged in', async () => {
    for (const [over, says] of [
      [{ tailscaleBin: () => null }, /not installed.*\n.*tailscale\.com\/download/],
      [{ status: null }, /`tailscale status` failed \(failed to connect.*\n.*tailscale up/],
      [{ status: { BackendState: 'NeedsLogin' } }, /Tailscale is NeedsLogin.*\n.*Open the Tailscale app and log in, or run: \/usr\/local\/bin\/tailscale up/],
    ]) {
      const { ctx, server } = fakeCtx(over);
      expect(await setupRemote(ctx, server)).toBe(1);
      expect(text(ctx)).toMatch(says);
      expect(text(ctx)).toContain('Nothing was changed');
      expect(changes(ctx)).toEqual([]);
      expect(existsSync(envFile(ctx))).toBe(false);
      removeTempDir(ctx.home);
    }
  });

  const busy = (...ports) => ports.reduce((c, p) => {
    const w = served('http://127.0.0.1:3000', NAME, p);
    return { TCP: { ...c.TCP, ...w.TCP }, Web: { ...c.Web, ...w.Web } };
  }, { TCP: {}, Web: {} });

  it('leaves another site on 443 alone and uses the next free HTTPS port, without asking', async () => {
    for (const [ports, p] of [[[443], 8443], [[443, 8443], 10000]]) {
      const { ctx, server } = fakeCtx({ serve: busy(...ports) });
      expect(await setupRemote(ctx, server)).toBe(0);
      expect(ctx.asked).toEqual([]);
      expect(changes(ctx)).toEqual([`serve --bg --https=${p} ${PORT}`]);
      expect(readFileSync(envFile(ctx), 'utf8')).toContain(`ALLOWED_ORIGINS=${NAME}:${p}\n`);
      expect(ctx.out.at(-1)).toBe(`Open https://${NAME}:${p} on any device in your tailnet.`);
      removeTempDir(ctx.home);
    }
  });

  it('stops without changes when every HTTPS port serves something else', async () => {
    const { ctx, server } = fakeCtx({ serve: busy(443, 8443, 10000) });
    expect(await setupRemote(ctx, server)).toBe(1);
    expect(text(ctx)).toMatch(/Every HTTPS port.*http:\/\/127\.0\.0\.1:3000.*Nothing was changed/s);
    expect(changes(ctx)).toEqual([]);
    expect(existsSync(envFile(ctx))).toBe(false);
    removeTempDir(ctx.home);
  });

  it('keeps this port when already served on a non-443 HTTPS port', async () => {
    const mine = served(`http://127.0.0.1:${PORT}`, NAME, 8443);
    const { ctx, server } = fakeCtx({ serve: { TCP: { ...busy(443).TCP, ...mine.TCP }, Web: { ...busy(443).Web, ...mine.Web } } });
    expect(await setupRemote(ctx, server)).toBe(0);
    expect(changes(ctx)).toEqual([]);
    expect(ctx.out.at(-1)).toBe(`Open https://${NAME}:8443 on any device in your tailnet.`);
    removeTempDir(ctx.home);
  });

  it('prints the link Tailscale gives when Serve is not enabled on the tailnet', async () => {
    const url = 'https://login.tailscale.com/f/serve?node=abc123';
    const { ctx, server } = fakeCtx({ serveRun: { code: -1, stdout: `Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         ${url}\n`, stderr: '' } });
    expect(await setupRemote(ctx, server)).toBe(1);
    expect(text(ctx)).toContain(`Serve is not enabled on your tailnet. Enable it here, then run agent007 install --remote again:\n  ${url}`);
    expect(existsSync(envFile(ctx))).toBe(false);
    removeTempDir(ctx.home);
  });

  it('shows the enable link while tailscale is still waiting, and says which machine it is', async () => {
    const url = 'https://login.tailscale.com/f/serve?node=abc123';
    const { ctx, server } = fakeCtx();
    let seenBeforeExit = false;
    ctx.stream = async (cmd, args, o) => {
      o.onData(`To enable, visit:\n ${url}\n`);
      seenBeforeExit = ctx.out.some(l => l.includes(url));
      return { code: 0, stdout: url, stderr: '' };
    };
    expect(await setupRemote(ctx, server)).toBe(0);
    expect(seenBeforeExit).toBe(true);
    expect(text(ctx)).toContain(`This machine is ${NAME}.`);
    expect(text(ctx)).toMatch(/Tailscale prints a link to enable it/);
    removeTempDir(ctx.home);
  });

  it('on timeout prints the link and the command to re-run; on Ctrl-C stops cleanly', async () => {
    const url = 'https://login.tailscale.com/f/serve?node=abc123';
    const t = fakeCtx({ serveRun: { code: -1, stdout: url, stderr: '', timedOut: true } });
    expect(await setupRemote(t.ctx, t.server)).toBe(1);
    expect(text(t.ctx)).toContain('Gave up waiting');
    expect(text(t.ctx)).toContain(url);
    expect(text(t.ctx)).toContain('agent007 install --remote');
    const i = fakeCtx({ serveRun: { code: -1, stdout: '', stderr: '', interrupted: true } });
    expect(await setupRemote(i.ctx, i.server)).toBe(130);
    expect(existsSync(envFile(i.ctx))).toBe(false);
    removeTempDir(t.ctx.home); removeTempDir(i.ctx.home);
  });

  it('stream: echoes a real child live, kills it on timeout', async () => {
    const { stream } = await import('../server/service.js');
    const seen = [];
    const r = await stream(process.execPath, ['-e', "console.log('hello'); setInterval(()=>{},1000)"], { timeout: 700, onData: (d) => seen.push(d) });
    expect(seen.join('')).toContain('hello');
    expect(r.timedOut).toBe(true);
  });

  it('--dry-run reads status and prints what it would do, changing nothing', async () => {
    const { ctx, server } = fakeCtx({ 'dry-run': true, running: true });
    expect(await setupRemote(ctx, server)).toBe(0);
    expect(changes(ctx)).toEqual([]);
    expect(text(ctx)).toContain(`Would run: /usr/local/bin/tailscale serve --bg ${PORT}`);
    expect(text(ctx)).toContain(`Would set ALLOWED_ORIGINS=${NAME}`);
    expect(existsSync(envFile(ctx))).toBe(false);
    expect(ctx.restarts).toEqual([]);
    removeTempDir(ctx.home);
  });

  it('warns when the environment sets ALLOWED_ORIGINS without the name', async () => {
    const { ctx, server } = fakeCtx();
    ctx.env.ALLOWED_ORIGINS = 'other.example';
    expect(await setupRemote(ctx, server)).toBe(0);
    expect(text(ctx)).toMatch(/also set in your environment.*add mini\.tail1\.ts\.net there too/);
    removeTempDir(ctx.home);
  });

  it('is what `install --remote` runs, alone', async () => {
    const { ctx } = fakeCtx();
    ctx.callServer = async () => null;
    ctx.readServer = () => null;
    expect(await runCommand('install', { remote: true }, ctx)).toBe(0);
    expect(changes(ctx)).toEqual([`serve --bg ${PORT}`]);
    expect(await runCommand('install', { remote: true, voice: true }, ctx)).toBe(2);
    removeTempDir(ctx.home);
  });
});

describe('tailscale helpers', () => {
  it('finds the CLI on PATH, else the macOS app bundle', () => {
    const none = { PATH: '/nonexistent' };
    expect(tailscaleBin(none, { platform: 'darwin', exists: (p) => p === MAC_APP_CLI })).toBe(MAC_APP_CLI);
    expect(tailscaleBin(none, { platform: 'linux', exists: () => true })).toBe(null);
    expect(tailscaleBin(none, { platform: 'darwin', exists: () => false })).toBe(null);
  });

  it('serveTargets: names sent to this port, other targets, busy HTTPS ports', () => {
    const cfg = { ...served(`http://localhost:${PORT}`), Foreground: { x: served('http://127.0.0.1:3000', NAME, 8443) } };
    const t = serveTargets(cfg, PORT);
    expect([...t.names]).toEqual([NAME]);
    expect(t.targets).toEqual(['http://127.0.0.1:3000']);
    expect([...t.busyPorts]).toEqual(['8443']);
    expect([...serveTargets(served(`http://localhost:${PORT}`, NAME, 8443), PORT).names]).toEqual([`${NAME}:8443`]);
  });

  it('the server lets a host:port ALLOWED_ORIGINS entry in by hostname', () => {
    expect(originHost(`${NAME}:8443`)).toBe(NAME);
  });

  it('addOrigin merges and never removes', () => {
    expect(addOrigin(undefined, NAME)).toBe(NAME);
    expect(addOrigin('a.example, b.example', NAME)).toBe(`a.example,b.example,${NAME}`);
    expect(addOrigin(`https://${NAME}`, NAME)).toBe(null);
    expect(addOrigin('*', NAME)).toBe(null);
    expect(addOrigin('a.example', `${NAME}:8443`)).toBe(`a.example,${NAME}:8443`);
    expect(addOrigin(NAME, `${NAME}:8443`)).toBe(null);
  });
});
