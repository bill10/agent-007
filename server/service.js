// `agent007 install | uninstall | status | restart | logs | update`.
//
// install writes a per-user service: a LaunchAgent plist on macOS, a systemd
// --user unit on Linux. It runs this copy's bin/agent-007.js with an absolute
// node and the PATH of the person's login shell, captured now: a service
// starts with a bare PATH, where claude, codex, gh and an nvm node are not.
// Re-running install re-captures it. Everything that touches the machine goes
// through ctx (defaultContext below), so the tests stub launchctl, systemctl,
// git and npm and never write outside a temp HOME.

import { execFile } from 'child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync,
} from 'fs';
import { homedir, userInfo } from 'os';
import { createInterface } from 'readline';
import { commandExists } from './command-path.js';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { carryOverEnv, configDir, tilde } from './settings.js';
import { setupVoice } from './voice-setup.js';
import { callServer, lastServerFile, pidAlive, readServerFile } from './control.js';

export const LABEL = 'com.bill10.agent-007';
export const UNIT = 'agent-007.service';
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const BIN = fileURLToPath(new URL('../bin/agent-007.js', import.meta.url));
const PKG_NAME = '@bill10/agent-007';
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const MANAGER_MS = 15_000;

export const serviceKind = (platform = process.platform) => ({ darwin: 'launchd', linux: 'systemd' })[platform] || null;

export function serviceFilePath(kind, home = homedir()) {
  if (kind === 'launchd') return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (kind === 'systemd') return join(home, '.config', 'systemd', 'user', UNIT);
  return null;
}

export const logPath = (env = process.env) => join(configDir(env), 'logs', 'server.log');

// 'checkout' (a git clone), 'npx' (a throwaway copy) or 'npm' (an install).
export function installKind({ root = PKG_ROOT, env = process.env, exists = existsSync } = {}) {
  if (env.npm_command === 'exec' || /[\\/]_npx[\\/]/.test(root)) return 'npx';
  return exists(join(root, '.git')) ? 'checkout' : 'npm';
}

// --- The definition ---

// The login shell's PATH, between markers: an interactive shell may print a
// banner or a prompt theme's noise around it. -i as well as -l, since nvm and
// friends are often set up in .zshrc / .bashrc only. null when it fails.
// Started from a bare environment, as at login, so this terminal's own PATH
// (npm run's node_modules/.bin, say) does not come along.
export async function loginShellPath(run, { SHELL, HOME, USER } = {}) {
  const env = { HOME, USER, SHELL, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const r = await run(SHELL || '/bin/sh', ['-ilc', 'printf "\\n__A007_PATH__%s__A007_PATH__\\n" "$PATH"'], { timeout: 10_000, env });
  return /__A007_PATH__(.*?)__A007_PATH__/.exec(r.stdout || '')?.[1] || null;
}

// node's own folder first, so `node` in a hook or an npm script is this one.
export function mergePath(execPath, ...paths) {
  const dirs = [dirname(execPath), ...paths.flatMap(p => (p || '').split(':'))].filter(Boolean);
  return [...new Set(dirs)].join(':');
}

export function serviceDefinition({ kind, execPath, bin = BIN, root = PKG_ROOT, path, home, launchEnv, env = launchEnv }) {
  const log = logPath(env);
  const vars = { PATH: path, HOME: home, AGENT007_SERVICE: kind, AGENT007_LOG: log };
  // Only what was set: the server reads the settings files itself, so a value
  // there is not frozen into the service.
  for (const key of ['PORT', 'HOST', 'AGENT007_CONFIG_DIR']) if (launchEnv[key]) vars[key] = launchEnv[key];
  // A checkout runs where `npm start` would, so its ./.env still applies; an
  // install runs in the config dir, whose .env is read anyway.
  const cwd = installKind({ root, env: launchEnv }) === 'checkout' ? root : configDir(env);
  return { args: [execPath, bin], env: vars, cwd, log };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function plist({ args, env, cwd, log }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

// systemd expands %specifiers everywhere and $VARS in ExecStart.
const sdPct = (s) => String(s).replace(/%/g, '%%');
const sdQuote = (s, dollar) => `"${sdPct(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, dollar ? '$$$$' : '$')}"`;
const unsd = (s) => s.replace(/\\(.)/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$');

export function systemdUnit({ args, env, cwd, log }) {
  return `[Unit]
Description=Agent 007
After=network-online.target

[Service]
ExecStart=${args.map(a => sdQuote(a, true)).join(' ')}
WorkingDirectory=${sdPct(cwd)}
${Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=5
StandardOutput=append:${sdPct(log)}
StandardError=append:${sdPct(log)}

[Install]
WantedBy=default.target
`;
}

// { args, env } back out of either file, for doctor.
export function parseServiceFile(text) {
  if (text.includes('<plist')) {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] || '';
    const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] || '';
    return {
      args: [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => unxml(m[1])),
      env: Object.fromEntries([...dict.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map(m => [unxml(m[1]), unxml(m[2])])),
    };
  }
  const exec = /^ExecStart=(.*)$/m.exec(text)?.[1] || '';
  const env = {};
  for (const m of text.matchAll(/^Environment="((?:[^"\\]|\\.)*)"$/gm)) {
    const kv = unsd(m[1]);
    env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  return { args: [...exec.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => unsd(m[1])), env };
}

// What launchctl print / systemctl show say about it.
export function parseServiceState(kind, out = '') {
  if (kind === 'launchd') {
    const state = /^\s*state = (\S+)/m.exec(out)?.[1] || null;
    const pid = /^\s*pid = (\d+)/m.exec(out)?.[1];
    return { running: state === 'running', state, pid: pid ? Number(pid) : null };
  }
  const kv = Object.fromEntries(out.split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  return { running: kv.ActiveState === 'active', state: kv.ActiveState || null, pid: Number(kv.MainPID) || null };
}

// The installed definition, for doctor. null when there is none.
export function installedService({ platform = process.platform, home = homedir() } = {}) {
  const file = serviceFilePath(serviceKind(platform), home);
  try { return file ? { file, text: readFileSync(file, 'utf8') } : null; } catch { return null; }
}

// --- The service manager ---

const launchdTarget = (ctx) => `gui/${ctx.uid}/${LABEL}`;

async function managerInstall(ctx, kind, file) {
  const { run } = ctx;
  if (kind === 'launchd') {
    // bootout returns before launchd has let go of a KeepAlive job, and a
    // bootstrap into that gap fails with EIO (5): wait, then retry on 5 only.
    await run('launchctl', ['bootout', launchdTarget(ctx)], { timeout: MANAGER_MS });
    for (let i = 0; i < 30 && (await run('launchctl', ['print', launchdTarget(ctx)], { timeout: MANAGER_MS })).code === 0; i++) await ctx.sleep(500);
    let r;
    for (let i = 0; i < 5; i++) {
      r = await run('launchctl', ['bootstrap', `gui/${ctx.uid}`, file], { timeout: MANAGER_MS });
      if (r.code !== 5) break;
      await ctx.sleep(1000);
    }
    if (r.code) throw new Error(`launchctl bootstrap failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
    return;
  }
  for (const args of [['daemon-reload'], ['enable', UNIT], ['restart', UNIT]]) {
    const r = await run('systemctl', ['--user', ...args], { timeout: MANAGER_MS });
    if (r.code) throw new Error(`systemctl --user ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  // Without linger, systemd stops a user's services at logout.
  const user = ctx.user;
  const linger = async () => (await run('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { timeout: MANAGER_MS })).stdout.trim() === 'yes';
  if (!(await linger())) {
    await run('loginctl', ['enable-linger', user], { timeout: MANAGER_MS });
    if (!(await linger())) ctx.err(`! Linger is off for ${user}, so Agent 007 stops when you log out. Fix: sudo loginctl enable-linger ${user}`);
  }
}

async function managerUninstall(ctx, kind) {
  if (kind === 'launchd') return ctx.run('launchctl', ['bootout', launchdTarget(ctx)], { timeout: MANAGER_MS });
  return ctx.run('systemctl', ['--user', 'disable', '--now', UNIT], { timeout: MANAGER_MS });
}

async function managerState(ctx, kind) {
  const r = kind === 'launchd'
    ? await ctx.run('launchctl', ['print', launchdTarget(ctx)], { timeout: MANAGER_MS })
    : await ctx.run('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveState', '-p', 'MainPID'], { timeout: MANAGER_MS });
  return r.code ? { running: false, state: null, pid: null } : parseServiceState(kind, r.stdout);
}

function managerRestart(ctx, kind) {
  return kind === 'launchd'
    ? ctx.run('launchctl', ['kickstart', '-k', launchdTarget(ctx)], { timeout: MANAGER_MS })
    : ctx.run('systemctl', ['--user', 'restart', UNIT], { timeout: MANAGER_MS });
}

// --- The running server ---

// The server this config dir has, and what it says about itself; null when none answers.
async function liveServer(ctx) {
  const info = ctx.readServer();
  const status = info && pidAlive(info.pid) ? await ctx.callServer('/control/status', { info }) : null;
  return status && { info, status };
}

// Polls until no board worker is mid-step. Returns the last status, or null
// once the server stops answering.
export async function waitForIdle({ getStatus, sleep, log, intervalMs = 5000 }) {
  let last = 0;
  for (;;) {
    const s = await getStatus();
    if (!s || !s.workers) return s;
    if (s.workers !== last) {
      log(`${s.workers} worker${s.workers === 1 ? ' is' : 's are'} mid-run. Waiting for the board to go idle (Ctrl-C to cancel; --now restarts anyway, and they resume after but lose the step they were on)...`);
    }
    last = s.workers;
    await sleep(intervalMs);
  }
}

// A new server (another pid) answering, or null after timeoutMs.
async function waitForNewServer(ctx, oldPid, timeoutMs = 60_000) {
  for (const end = ctx.now() + timeoutMs; ctx.now() < end; await ctx.sleep(500)) {
    const live = await liveServer(ctx);
    if (live && live.status.pid !== oldPid) return live.status;
  }
  return null;
}

export function formatUptime(sec) {
  const d = Math.floor(sec / 86400); const h = Math.floor(sec / 3600) % 24; const m = Math.floor(sec / 60) % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : `${sec}s`;
}

// The .env files an old setup read, oldest guess last: ./.env here, the ones
// the last server loaded (it records them), and, for a server too old to
// record them, the ./.env of the folder a running one was started in.
async function envSources(ctx) {
  const files = [join(ctx.cwd, '.env'), ...(ctx.readLastServer()?.settings || [])];
  const info = ctx.readServer();
  let pid = info && !info.cwd && pidAlive(info.pid) ? info.pid : null;
  if (!info && await ctx.portState(ctx.port, ctx.host) === 'agent-007') {
    pid = Number((await ctx.run('lsof', ['-t', `-iTCP:${ctx.port}`, '-sTCP:LISTEN'], { timeout: MANAGER_MS })).stdout.split('\n')[0]) || null;
  }
  const cwd = pid && await ctx.procCwd(pid);
  if (cwd) files.push(join(cwd, '.env'));
  return [...new Set(files.map(f => resolve(f)))];
}

// --- Commands ---

async function install(ctx, { 'dry-run': dryRun } = {}) {
  const kind = serviceKind(ctx.platform);
  if (!kind) {
    ctx.err(`Running Agent 007 as a service is not supported on ${ctx.platform} yet. Run it in a terminal instead: ${ctx.cmd('')}`.trim());
    return 1;
  }
  if (installKind({ root: ctx.root, env: ctx.env }) === 'npx') {
    ctx.err(`An npx copy is temporary, so a service cannot run it. Install it first, then install the service:\n  npm install -g ${PKG_NAME}\n  agent007 install`);
    return 1;
  }
  const loginPath = await loginShellPath(ctx.run, ctx.env);
  if (!loginPath) ctx.err(`! Could not read your login shell's PATH (${ctx.env.SHELL || '/bin/sh'}); using this terminal's.`);
  const def = serviceDefinition({ kind, execPath: ctx.execPath, bin: ctx.bin, root: ctx.root, path: mergePath(ctx.execPath, loginPath || ctx.env.PATH), home: ctx.home, launchEnv: ctx.env });
  // The service runs in its own folder, so the .env the old setup read (ALLOWED_ORIGINS
  // for remote access, say) would stop applying. Before refusing over a server
  // still running: its folder is easiest to find now. Key names only: values may be secrets.
  if (!dryRun) {
    const shared = join(configDir(ctx.env), '.env');
    for (const from of await envSources(ctx)) {
      if (resolve(dirname(from)) === resolve(def.cwd)) continue;
      const copied = carryOverEnv(from, shared);
      if (copied.length) ctx.log(`Copied ${copied.join(', ')} from ${tilde(from)} to ${tilde(shared)}: the service runs in ${tilde(def.cwd)}, where that .env is not read.`);
    }
  }
  if (!dryRun) {
    const live = await liveServer(ctx);
    if (live && !live.status.service) {
      ctx.err(`Agent 007 is already running in a terminal (pid ${live.status.pid}, port ${live.status.port}), and the service would not get the port. Stop it there (Ctrl-C), then run install again.`);
      return 1;
    }
    if (!live) {
      const state = await ctx.portState(ctx.port, ctx.host);
      if (state !== 'free') {
        ctx.err(`Port ${ctx.port} is in use${state === 'agent-007' ? ' by an Agent 007 this config does not know' : state === 'other' ? ' by another program' : ` (${state})`}, so the service could not start. Stop that first, or install with --port.`);
        return 1;
      }
    }
  }
  const text = kind === 'launchd' ? plist(def) : systemdUnit(def);
  const file = serviceFilePath(kind, ctx.home);
  if (dryRun) {
    ctx.log(`Would write ${file}:\n\n${text}`);
    ctx.log(kind === 'launchd'
      ? `Then: launchctl bootout ${launchdTarget(ctx)}; launchctl bootstrap gui/${ctx.uid} ${file}`
      : `Then: systemctl --user daemon-reload; systemctl --user enable ${UNIT}; systemctl --user restart ${UNIT}; loginctl enable-linger ${ctx.user}`);
    return 0;
  }
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(def.log), { recursive: true });
  writeFileSync(file, text);
  try {
    await managerInstall(ctx, kind, file);
  } catch (err) {
    ctx.err(`Wrote ${file}, but it did not start: ${err.message}`);
    return 1;
  }
  ctx.log(`Installed ${tilde(file)}.\nAgent 007 now starts when you log in and comes back if it stops.`);
  const up = await waitForNewServer(ctx, null, 20_000);
  ctx.log(up ? `Running at http://localhost:${up.port} (pid ${up.pid}).` : `Not answering yet; see ${ctx.cmd('logs')}.`);
  // No old .env had ALLOWED_ORIGINS, and tailscale serve needs it: say the line to add.
  for (const l of await ctx.remoteCheck(ctx.port).catch(() => [])) if (l.status === 'fail') ctx.err(`! ${l.text}.\n  ${l.fix}.`);
  ctx.log(`Log: ${tilde(def.log)}\nCheck on it with ${ctx.cmd('status')}; remove it with ${ctx.cmd('uninstall')}.`);
  return 0;
}

async function uninstall(ctx) {
  const kind = serviceKind(ctx.platform);
  const file = serviceFilePath(kind, ctx.home);
  if (!file || !existsSync(file)) {
    ctx.log('No Agent 007 service is installed.');
    return 0;
  }
  await managerUninstall(ctx, kind);
  rmSync(file, { force: true });
  if (kind === 'systemd') await ctx.run('systemctl', ['--user', 'daemon-reload'], { timeout: MANAGER_MS });
  ctx.log(`Stopped and removed ${tilde(file)}. Your boards, settings and logs in ${tilde(configDir(ctx.env))} are kept.`);
  return 0;
}

async function status(ctx) {
  const kind = serviceKind(ctx.platform);
  const file = serviceFilePath(kind, ctx.home);
  const installed = !!file && existsSync(file);
  const live = await liveServer(ctx);
  const lines = [];
  if (live) {
    const s = live.status;
    lines.push(`Agent 007 ${s.version} is running ${s.service ? `as a service (${s.service})` : 'in a terminal'}.`,
      `  pid ${s.pid}, port ${s.port}, up ${formatUptime(s.uptime)}`,
      `  workers running: ${s.workers}`);
  } else if (installed) {
    const st = await managerState(ctx, kind);
    lines.push(`Agent 007 is not answering. ${kind} says: ${st.state || 'not loaded'}${st.pid ? ` (pid ${st.pid})` : ''}.`);
  } else {
    lines.push('Agent 007 is not running.');
  }
  lines.push(installed ? `  service: installed (${tilde(file)})` : kind ? `  service: not installed (${ctx.cmd('install')} runs it at login)` : '  service: not supported on this platform');
  lines.push(installed || live?.status.service ? `  log: ${tilde(logPath(ctx.env))}` : '  log: the terminal it runs in');
  ctx.log(lines.join('\n'));
  return live ? 0 : 3;
}

async function restart(ctx, { now = false } = {}) {
  const kind = serviceKind(ctx.platform);
  const file = serviceFilePath(kind, ctx.home);
  const live = await liveServer(ctx);
  if (!live) {
    if (file && existsSync(file)) {
      ctx.log('Agent 007 is not answering; restarting the service.');
      await managerRestart(ctx, kind);
      const up = await waitForNewServer(ctx, null);
      ctx.log(up ? `Running again (pid ${up.pid}, version ${up.version}).` : `Still not answering; see ${ctx.cmd('logs')}.`);
      return up ? 0 : 1;
    }
    ctx.err('Agent 007 is not running.');
    return 1;
  }
  const { info } = live;
  if (!now) {
    const s = await waitForIdle({ getStatus: () => ctx.callServer('/control/status', { info }), sleep: ctx.sleep, log: ctx.log });
    if (!s) { ctx.err('Agent 007 stopped while waiting.'); return 1; }
  }
  if (!(await ctx.callServer('/control/restart', { method: 'POST', info }))) {
    ctx.err('Agent 007 did not take the restart request.');
    return 1;
  }
  const up = await waitForNewServer(ctx, live.status.pid);
  if (!up) { ctx.err(`Agent 007 has not come back yet; see ${live.status.service ? ctx.cmd('logs') : 'its terminal'}.`); return 1; }
  ctx.log(`Restarted: pid ${live.status.pid} → ${up.pid}, version ${live.status.version} → ${up.version}.`);
  return 0;
}

// The last `lines` lines, then (follow) whatever is added, until Ctrl-C.
async function logs(ctx, { follow = false, lines = '50' } = {}) {
  const file = logPath(ctx.env);
  if (!existsSync(file)) {
    ctx.err(`No log at ${tilde(file)} yet. The service writes there; a server in a terminal logs to that terminal.`);
    return 1;
  }
  const read = (from, to) => {
    const buf = Buffer.alloc(to - from);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
    return buf.toString('utf8');
  };
  let size = statSync(file).size;
  const n = Math.max(1, Number(lines) || 50);
  const tail = read(Math.max(0, size - 256 * 1024), size).split('\n');
  if (tail.at(-1) === '') tail.pop();
  ctx.write(tail.slice(-n).join('\n') + (tail.length ? '\n' : ''));
  if (!follow) return 0;
  for (;;) {
    await ctx.sleep(500);
    let now;
    try { now = statSync(file).size; } catch { continue; }
    if (now < size) size = 0; // capped (copied to server.log.1 and emptied)
    if (now > size) { ctx.write(read(size, now)); size = now; }
  }
}

// What update does in a checkout, from what git says.
export function checkoutDecision({ dirty, upstream, ahead, behind }) {
  if (dirty) return { error: `You have local changes:\n${dirty}\nCommit or stash them, then run update again.` };
  if (!upstream) return { error: 'This branch tracks no remote branch, so there is nothing to pull. Check out one that does (git switch main), then run update again.' };
  if (ahead && behind) return { error: `This branch and ${upstream} have diverged (${ahead} local commit${ahead === 1 ? '' : 's'}, ${behind} new upstream). Merge or rebase by hand, then run update again.` };
  if (!behind) return { upToDate: true };
  return { pull: true };
}

async function updateCheckout(ctx) {
  const git = (...args) => ctx.run('git', ['-C', ctx.root, ...args], { timeout: 120_000 });
  const dirty = (await git('status', '--porcelain', '--untracked-files=no')).stdout.trim();
  const up = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  const upstream = up.code ? null : up.stdout.trim();
  let ahead = 0; let behind = 0;
  if (!dirty && upstream) {
    const f = await git('fetch', '--quiet');
    if (f.code) return { error: `git fetch failed: ${(f.stderr || f.stdout).trim()}` };
    [ahead, behind] = (await git('rev-list', '--left-right', '--count', 'HEAD...@{u}')).stdout.trim().split(/\s+/).map(Number);
  }
  const decision = checkoutDecision({ dirty, upstream, ahead, behind });
  if (!decision.pull) return decision;
  const lock = async () => (await git('rev-parse', 'HEAD:package-lock.json')).stdout.trim();
  const lockBefore = await lock();
  const pull = await git('pull', '--ff-only');
  if (pull.code) return { error: `git pull --ff-only failed: ${(pull.stderr || pull.stdout).trim()}` };
  if ((await lock()) !== lockBefore) {
    ctx.log('package-lock.json changed; running npm install...');
    const npm = await ctx.run('npm', ['install'], { cwd: ctx.root, timeout: 600_000 });
    if (npm.code) return { error: `npm install failed: ${(npm.stderr || npm.stdout).trim().split('\n').slice(-5).join('\n')}` };
  }
  return { updated: true };
}

async function updateNpm(ctx) {
  const rootG = (await ctx.run('npm', ['root', '-g'], { timeout: 30_000 })).stdout.trim();
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  if (!rootG || !real(ctx.root).startsWith(real(rootG))) {
    return { error: `This copy is in ${ctx.root}, not npm's global folder (${rootG || 'unknown'}). Update it where it was installed (npm install ${PKG_NAME}@latest there).` };
  }
  const { toNpm, fromNpm, versionAtLeast } = await import('./doctor.js');
  const before = ctx.version();
  const latest = await ctx.latest();
  if (!latest) return { error: `Could not reach the npm registry to find the latest version, so ${before} may or may not be current. Check the network and run agent007 update again.` };
  if (versionAtLeast(toNpm(before), latest)) return { upToDate: true };
  const want = fromNpm(latest);
  ctx.log(`npm install -g ${PKG_NAME}@${latest} ...`);
  const r = await ctx.run('npm', ['install', '-g', `${PKG_NAME}@${latest}`, '--prefer-online'], { timeout: 600_000 });
  if (r.code) return { error: `npm install -g failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n')}` };
  if (ctx.version() !== want) return { error: `npm installed ${ctx.version()}, not ${want}, so this was not updated. Retry: npm install -g ${PKG_NAME}@${latest} --prefer-online` };
  return { updated: true };
}

async function update(ctx, opts = {}) {
  const how = installKind({ root: ctx.root, env: ctx.env });
  if (how === 'npx') {
    ctx.log(`npx runs the latest version each time it starts, so there is nothing to update. Restart it to pick up a new one: Ctrl-C, then npx ${PKG_NAME}@latest.`);
    return 0;
  }
  const before = ctx.version();
  const result = how === 'checkout' ? await updateCheckout(ctx) : await updateNpm(ctx);
  if (result.error) { ctx.err(result.error); return 1; }
  if (result.upToDate) {
    ctx.log(`Already up to date (${before}).`);
    return 0;
  }
  ctx.log(`Updated ${before} → ${ctx.version()}.`);
  const file = serviceFilePath(serviceKind(ctx.platform), ctx.home);
  if (!(await liveServer(ctx)) && !(file && existsSync(file))) {
    ctx.log(`Agent 007 is not running; start it with ${ctx.cmd('')}`.trim());
    return 0;
  }
  return restart(ctx, opts);
}

// install: the service, the voice setup, or both (see bin/agent-007.js HELP).
async function installWithVoice(ctx, opts = {}) {
  const { voice, all, yes } = opts;
  if (voice && all) { ctx.err('Use --voice or --all, not both.'); return 2; }
  const setup = () => setupVoice({ ...ctx, yes: Boolean(yes) }, { running: async () => Boolean(await liveServer(ctx)), restart: () => restart(ctx, {}) });
  if (voice) return setup();
  const code = await install(ctx, opts);
  if (opts['dry-run'] || (code && !all)) return code;
  if (!all) {
    if (!ctx.tty) return code;
    const a = await ctx.ask('Set up voice too? Downloads whisper.cpp and a ~150 MB speech model. [y/N] ');
    if (!/^y/i.test(a.trim())) return code;
  }
  return (await setup()) || code;
}

const COMMANDS = { install: installWithVoice, uninstall, status, restart, logs, update };
export const SERVICE_COMMANDS = Object.keys(COMMANDS);

// --- The real machine ---

// Never rejects: { code, stdout, stderr }, code -1 when it could not run.
function run(cmd, args, { timeout, cwd, env } = {}) {
  return new Promise((done) => {
    // npm is npm.cmd on Windows, which only a shell runs.
    execFile(cmd, args, { timeout, cwd, env: env && Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' && cmd === 'npm' }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || (err && typeof err.code !== 'number' ? err.message : '') });
    });
  });
}

export function defaultContext({ launchEnv = process.env, cmd = (sub) => `agent007 ${sub}` } = {}) {
  return {
    run,
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    user: launchEnv.USER || userInfo().username,
    env: launchEnv,
    cwd: process.cwd(),
    execPath: process.execPath,
    root: PKG_ROOT,
    bin: BIN,
    port: Number(process.env.PORT || 7007),
    host: process.env.HOST || '127.0.0.1',
    portState: async (...a) => (await import('./doctor.js')).portState(...a),
    readServer: () => readServerFile(),
    readLastServer: () => readServerFile(lastServerFile(launchEnv)),
    // The folder a process runs in; null when it cannot be read.
    procCwd: async (pid) => {
      if (process.platform === 'linux') { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
      const r = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: MANAGER_MS });
      return r.stdout.match(/^n(.+)$/m)?.[1] || null;
    },
    // doctor's Remote access lines for this port, as the just-installed service reads its settings.
    remoteCheck: async (port) => {
      const { checkRemote, defaultProbes } = await import('./doctor.js');
      return checkRemote({ ...defaultProbes({ env: launchEnv, installCommand: cmd('install') }), port });
    },
    callServer,
    version: () => readFileSync(join(PKG_ROOT, 'VERSION'), 'utf8').trim(),
    // The registry's `latest`, asked directly: npm's own packument cache can lag it by minutes.
    latest: async () => (await import('./doctor.js')).npmLatest(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    now: Date.now,
    log: (s) => console.log(s),
    err: (s) => console.error(s),
    write: (s) => process.stdout.write(s),
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (q) => new Promise(r => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); r(a); }); }),
    fetch: (...a) => fetch(...a),
    has: (n) => commandExists(n, launchEnv),
    cmd,
  };
}

export function runCommand(name, opts, ctx = defaultContext()) {
  return COMMANDS[name](ctx, opts);
}

// A service's log, kept to LOG_MAX_BYTES and one older copy. Copy then
// truncate, not rename: launchd and systemd keep writing to the open file.
export function capLog(file, max = LOG_MAX_BYTES) {
  try {
    if (statSync(file).size <= max) return false;
    // ponytail: lines written between the copy and the truncate are lost; a few, once per 5 MB.
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
    return true;
  } catch { return false; }
}
