// The Tailscale CLI and `tailscale serve`'s config, shared by `agent007 doctor`
// (server/doctor.js, checkRemote) and `agent007 install --remote`
// (server/remote-setup.js).

import { existsSync } from 'fs';
import { commandPath } from './command-path.js';

// The macOS app keeps its CLI inside the bundle, on PATH only if the owner installed it.
export const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

// The tailscale CLI's path, or null.
export function tailscaleBin(env = process.env, { platform = process.platform, exists = existsSync } = {}) {
  return commandPath('tailscale', env) || (platform === 'darwin' && exists(MAC_APP_CLI) ? MAC_APP_CLI : null);
}

// From `tailscale serve status --json`: the names it sends to this port
// (`mini.tail1.ts.net`, or `mini.tail1.ts.net:8443` off the default HTTPS port), what else it serves, and the HTTPS ports in use for something else.
export function serveTargets(cfg, port) {
  const proxy = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(/|$)`);
  const webs = [cfg, ...Object.values(cfg?.Foreground || {})].flatMap(c => Object.entries(c?.Web || {}));
  const ours = ([, web]) => Object.values(web?.Handlers || {}).some(h => proxy.test(h?.Proxy || ''));
  const names = new Set(webs.filter(ours).map(([hostPort]) => hostPort.replace(/:443$/, '')));
  const others = webs.filter(w => !ours(w));
  const targets = [...new Set(others.flatMap(([, web]) => Object.values(web?.Handlers || {}).map(h => h?.Proxy || h?.Path || h?.Text && 'text').filter(Boolean)))];
  const busyPorts = new Set(others.map(([hostPort]) => hostPort.match(/:(\d+)$/)?.[1] || '443'));
  return { names, targets, busyPorts };
}

// The HTTPS ports `tailscale serve` accepts, in the order we try them.
export const SERVE_HTTPS_PORTS = ['443', '8443', '10000'];
