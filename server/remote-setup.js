// `agent007 install --remote`: remote access over Tailscale in one step
// (docs/REMOTE.md). `tailscale serve --bg <port>` puts Agent 007 at
// https://<machine>.<tailnet>.ts.net (tailscaled keeps it across reboots), and
// that name goes into ALLOWED_ORIGINS in ~/.agent-007/.env so the server lets
// those browsers in. Installs nothing and never logs in: without a running,
// logged-in Tailscale it says what to do and changes nothing. Everything that
// touches the machine goes through ctx, so the tests stub the CLI and use a temp HOME.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseEnv } from 'util';
import { configDir, tilde } from './settings.js';
import { originHost, parsePublicUrl, WILDCARD_BIND_HOSTS } from './state.js';
import { serveTargets, SERVE_HTTPS_PORTS } from './tailscale.js';
import { setEnvLine } from './voice-setup.js';

const TS_MS = 15_000;
// `tailscale serve` waits for the owner to enable Serve in the admin console; past this it gives up.
const SERVE_MS = 300_000;

const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const lastLine = (r) => (r.stderr || r.stdout || '').trim().split('\n').pop() || `exit ${r.code}`;
const quote = (bin) => (/\s/.test(bin) ? `"${bin}"` : bin);

// An ALLOWED_ORIGINS value with `name` added, or null when it already lets it in.
// `name` may carry a port (`mini.ts.net:8443`); the server matches hostnames only, so any entry for the host counts.
export function addOrigin(origins, name) {
  const entries = (origins || '').split(',').map(o => o.trim()).filter(Boolean);
  if (entries.some(o => o === '*' || originHost(o) === originHost(name))) return null;
  return [...entries, name].join(',');
}

// ctx: platform, env, root, port, run, tailscaleBin(), tty, yes, ask(q), log, err, cmd, 'dry-run'.
// server: { running(), restart() }. Resolves 0 when remote access is set up.
export async function setupRemote(ctx, server = {}) {
  const dry = Boolean(ctx['dry-run']);
  const bin = ctx.tailscaleBin();
  const ts = (...args) => ctx.run(bin, args, { timeout: TS_MS });
  const cli = `${quote(bin || 'tailscale')}`;
  ctx.log(`Setting up remote access over Tailscale for port ${ctx.port}.`);

  // 1. Installed, running and logged in, or stop here.
  if (!bin) {
    ctx.err(`✗ Tailscale is not installed (no tailscale on PATH${ctx.platform === 'darwin' ? ' and no /Applications/Tailscale.app' : ''}). Nothing was changed.
  Install it from https://tailscale.com/download, log in, then run ${ctx.cmd('install --remote')} again.`);
    return 1;
  }
  const st = await ts('status', '--json');
  const status = json(st.stdout);
  if (status?.BackendState !== 'Running') {
    const why = status?.BackendState ? `Tailscale is ${status.BackendState}` : `\`tailscale status\` failed (${lastLine(st)})`;
    ctx.err(`✗ ${why}, so this machine is not on your tailnet. Nothing was changed.
  ${ctx.platform === 'darwin' ? 'Open the Tailscale app and log in, or run: ' : 'Run: '}${cli} up
  Then run ${ctx.cmd('install --remote')} again.`);
    return 1;
  }
  const name = String(status?.Self?.DNSName || '').replace(/\.$/, '');
  if (!name) {
    ctx.err(`✗ Tailscale did not report this machine's ts.net name (turn on MagicDNS in the admin console: https://login.tailscale.com/admin/dns). Nothing was changed.`);
    return 1;
  }

  ctx.log(`This machine is ${name}.`);

  // 2. What serve already does: keep this port if served, never take over 443 from something else.
  const cfg = json((await ts('serve', 'status', '--json')).stdout) || {};
  const { names, targets, busyPorts } = serveTargets(cfg, ctx.port);
  // Another app on 443 is left alone: take the first HTTPS port Serve allows that nothing uses.
  const https = SERVE_HTTPS_PORTS.find(p => !busyPorts.has(p));
  if (!names.size && !https) {
    ctx.err(`✗ Every HTTPS port tailscale serve allows (${SERVE_HTTPS_PORTS.join(', ')}) already serves something else (${targets.join(', ') || 'unknown'}). Nothing was changed.
  Free one with ${cli} serve --https=<port> off, then run ${ctx.cmd('install --remote')} again.`);
    return 1;
  }
  const serve = `${cli} serve --bg${https === '443' ? '' : ` --https=${https}`} ${ctx.port}`;
  let host = name;
  if (names.size) {
    host = [...names][0];
    ctx.log(`✓ tailscale serve already sends https://${host} to port ${ctx.port}; keeping it.`);
  } else {
    if (https !== '443') {
      host = `${name}:${https}`;
      ctx.log(`HTTPS port 443 already serves ${targets.join(', ') || 'something else'}; leaving it and using ${https} for Agent 007.`);
    }
    // 3. Background mode is kept by tailscaled, so it survives reboots without a terminal.
    if (dry) ctx.log(`Would run: ${serve}`);
    else {
      ctx.log(`Running: ${serve}`);
      ctx.log(`If Serve isn't enabled on your tailnet yet, Tailscale prints a link to enable it; open it and this continues (waiting up to ${SERVE_MS / 60_000} min, Ctrl-C to stop).`);
      // Echoed as it arrives: the enable link must show while tailscale is still waiting on it.
      const r = await ctx.stream(bin, ['serve', '--bg', ...(https === '443' ? [] : [`--https=${https}`]), String(ctx.port)], { timeout: SERVE_MS, onData: (d) => ctx.write(d) });
      const out = `${r.stdout}\n${r.stderr}`;
      const enable = out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
      if (r.interrupted) {
        ctx.err(`Stopped. Nothing else was changed. Run ${ctx.cmd('install --remote')} again when Serve is enabled.`);
        return 130;
      }
      if (r.timedOut) {
        ctx.err(`✗ Gave up waiting for Serve to be enabled after ${SERVE_MS / 60_000} min.${enable ? ` Enable it here:\n  ${enable}` : ''}\n  Then run ${ctx.cmd('install --remote')} again (or ${serve}).`);
        return 1;
      }
      if (r.code) {
        ctx.err(enable
          ? `✗ Serve is not enabled on your tailnet. Enable it here, then run ${ctx.cmd('install --remote')} again:\n  ${enable}`
          : `✗ tailscale serve failed (${lastLine(r)}).${/denied|operator|permission/i.test(out) && ctx.platform === 'linux' ? ` Let your user run it: sudo ${cli} set --operator=$USER, then run ${ctx.cmd('install --remote')} again.` : ` Run it yourself: ${serve}`}`);
        return 1;
      }
      ctx.log(`✓ tailscale serve sends https://${host} to port ${ctx.port}.`);
    }
  }

  // 4. Let https://<name> in: merge into ALLOWED_ORIGINS, never remove an entry.
  const file = join(configDir(ctx.env), '.env');
  const have = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')).ALLOWED_ORIGINS : undefined;
  const origins = addOrigin(have, host);
  let changed = false;
  if (!origins) ctx.log(`✓ ALLOWED_ORIGINS in ${tilde(file)} already lets ${host} in; skipping.`);
  else if (dry) ctx.log(`Would set ALLOWED_ORIGINS=${origins} in ${tilde(file)}`);
  else {
    setEnvLine(file, 'ALLOWED_ORIGINS', origins);
    changed = true;
    ctx.log(`✓ Set ALLOWED_ORIGINS=${origins} in ${tilde(file)}.`);
  }
  // Read before that file: the environment, then a clone's ./.env.
  const clone = join(ctx.root, '.env');
  const before = ctx.env.ALLOWED_ORIGINS !== undefined ? ['your environment', ctx.env.ALLOWED_ORIGINS]
    : existsSync(clone) && parseEnv(readFileSync(clone, 'utf8')).ALLOWED_ORIGINS !== undefined ? [tilde(clone), parseEnv(readFileSync(clone, 'utf8')).ALLOWED_ORIGINS] : null;
  if (before && addOrigin(before[1], host)) ctx.err(`! ALLOWED_ORIGINS is also set in ${before[0]}, which wins over ${tilde(file)}: add ${host} there too.`);

  // 5. A running server reads ALLOWED_ORIGINS when it starts.
  if (changed && await server.running?.()) {
    ctx.log('Restarting Agent 007 so it lets the new name in.');
    await server.restart();
  } else if (dry && origins) ctx.log(`Would restart Agent 007 if it is running: ${ctx.cmd('restart')}`);
  if (!dry) ctx.log(`Open https://${host} on any device in your tailnet.`);
  return 0;
}

// `agent007 install --public-url <url>`: remote access through a reverse proxy
// or tunnel the owner runs (docs/REMOTE.md), no Tailscale. Writes PUBLIC_URL to
// ~/.agent-007/.env; the service install that follows (server/service.js)
// starts the server with it. Resolves 0 when it is set.
export function setupProxy(ctx, raw) {
  const dry = Boolean(ctx['dry-run']);
  const url = parsePublicUrl(raw);
  if (!url) {
    ctx.err(`✗ --public-url needs the http(s) address your proxy serves, e.g. https://agent.example.com, not "${raw}". Nothing was changed.`);
    return 2;
  }
  const file = join(configDir(ctx.env), '.env');
  const have = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')).PUBLIC_URL : undefined;
  if (parsePublicUrl(have) === url) ctx.log(`✓ PUBLIC_URL in ${tilde(file)} is already ${url}.`);
  else if (dry) ctx.log(`Would set PUBLIC_URL=${url} in ${tilde(file)}`);
  else {
    setEnvLine(file, 'PUBLIC_URL', url);
    ctx.log(`✓ Set PUBLIC_URL=${url} in ${tilde(file)}.`);
  }
  // Read before that file, as ALLOWED_ORIGINS above.
  const clone = join(ctx.root, '.env');
  const before = ctx.env.PUBLIC_URL !== undefined ? ['your environment', ctx.env.PUBLIC_URL]
    : existsSync(clone) && parseEnv(readFileSync(clone, 'utf8')).PUBLIC_URL !== undefined ? [tilde(clone), parseEnv(readFileSync(clone, 'utf8')).PUBLIC_URL] : null;
  if (before && parsePublicUrl(before[1]) !== url) ctx.err(`! PUBLIC_URL is also set in ${before[0]} (${before[1]}), which wins over ${tilde(file)}: change it there too.`);
  if (!url.startsWith('https:')) ctx.err('! That is not https: browsers keep the microphone (voice input, Talk to Billion) to https pages and localhost.');
  if (WILDCARD_BIND_HOSTS.includes(ctx.host)) ctx.err(`! HOST=${ctx.host} lets anyone who reaches port ${ctx.port} past the proxy. Set HOST=127.0.0.1 (or the WireGuard address) in ${tilde(file)}.`);
  ctx.log(`Point your proxy or tunnel at http://127.0.0.1:${ctx.port}, keeping the Host header and WebSocket upgrades (docs/REMOTE.md has cloudflared, caddy and nginx configs). The proxy must sign people in: Agent 007 trusts whoever it lets through.`);
  return 0;
}
