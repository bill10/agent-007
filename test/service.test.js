import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  plist, systemdUnit, parseServiceFile, parseServiceState, serviceDefinition, loginShellPath, mergePath,
  checkoutDecision, waitForIdle, runCommand, capLog, formatUptime, serviceFilePath, LABEL, UNIT,
} from '../server/service.js';
import { readServerFile, writeServerFile } from '../server/control.js';
import { removeTempDir } from './temp-dir.js';

const ROOT = process.cwd();
// The "restarted" server's pid: one that is alive on every platform (there is
// no pid 1 on Windows), and not this process's.
const NEW_PID = process.ppid;
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// No real launchctl, systemctl, git or npm: `run` answers from `answer` and
// records every call. HOME is a temp folder, so nothing lands in ~/Library.
function fakeCtx(over = {}) {
  const home = over.home || tmp('a007-svc-home-');
  const calls = [];
  const out = [];
  let clock = 0;
  const ctx = {
    calls, out, home,
    run: async (cmd, args, opts) => {
      calls.push([cmd, ...args].join(' '));
      return { code: 0, stdout: '', stderr: '', ...(await over.answer?.(cmd, args, opts)) };
    },
    platform: 'linux',
    uid: 501,
    user: 'ada',
    env: { HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin', AGENT007_CONFIG_DIR: join(home, '.agent-007') },
    cwd: over.cwd || tmp('a007-svc-cwd-'),
    execPath: '/opt/node/bin/node',
    root: '/opt/app',
    bin: '/opt/app/bin/agent-007.js',
    port: 7007,
    host: '127.0.0.1',
    portState: async () => 'free',
    readServer: () => null,
    callServer: async () => null,
    version: () => '1.0.0.0',
    sleep: async () => {},
    now: () => (clock += 1000),
    log: (s) => out.push(s),
    err: (s) => out.push(`ERR ${s}`),
    write: (s) => out.push(s),
    cmd: (sub) => `agent007 ${sub}`.trim(),
    ...over,
  };
  return ctx;
}
const LOGIN_PATH = '/home/ada/.nvm/versions/node/v22/bin:/home/ada/.local/bin:/usr/bin';
const loginShell = (cmd) => (cmd === '/bin/zsh' ? { stdout: `welcome!\n__A007_PATH__${LOGIN_PATH}__A007_PATH__\n` } : {});

describe('service definition', () => {
  const def = {
    args: ['/Users/a b/.nvm/node', '/Users/a b/app/bin/agent-007.js'],
    env: { PATH: '/x:/y', HOME: '/Users/a b', AGENT007_SERVICE: 'launchd', AGENT007_LOG: '/Users/a b/.agent-007/logs/server.log', HOST: 'a&b<c>' },
    cwd: '/Users/a b/app',
    log: '/Users/a b/.agent-007/logs/server.log',
  };

  it('plist: absolute node and bin, the PATH, the log, KeepAlive; XML-escaped and read back', () => {
    const text = plist(def);
    expect(text).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(text).toContain('<string>/Users/a b/.nvm/node</string>');
    expect(text).toContain('<key>PATH</key><string>/x:/y</string>');
    expect(text).toContain('<key>StandardOutPath</key><string>/Users/a b/.agent-007/logs/server.log</string>');
    expect(text).toContain('<key>KeepAlive</key><true/>');
    expect(text).toContain('a&amp;b&lt;c&gt;');
    expect(parseServiceFile(text)).toEqual({ args: def.args, env: def.env });
  });

  it('systemd unit: quoted args, % and $ escaped, append to the log, Restart=always; read back', () => {
    const odd = { ...def, args: ['/n/node', '/a 100%/$HOME/bin.js'], env: { ...def.env, PATH: '/p%q:/r"s' } };
    const text = systemdUnit(odd);
    expect(text).toContain('ExecStart="/n/node" "/a 100%%/$$HOME/bin.js"');
    expect(text).toContain('Environment="PATH=/p%%q:/r\\"s"');
    expect(text).toContain('StandardOutput=append:/Users/a b/.agent-007/logs/server.log');
    expect(text).toContain('Restart=always');
    expect(text).toContain('WantedBy=default.target');
    expect(parseServiceFile(text)).toEqual({ args: odd.args, env: odd.env });
  });

  it('bakes PORT/HOST only when set; log under the config dir; a clone runs in itself, an install in the config dir', () => {
    const base = { kind: 'systemd', execPath: '/n/node', bin: '/c/bin/agent-007.js', path: '/p', home: '/h' };
    const clone = serviceDefinition({ ...base, root: ROOT, launchEnv: { AGENT007_CONFIG_DIR: '/cfg' } });
    expect(clone.args).toEqual(['/n/node', '/c/bin/agent-007.js']);
    expect(clone.env).toEqual({ PATH: '/p', HOME: '/h', AGENT007_SERVICE: 'systemd', AGENT007_LOG: join('/cfg', 'logs', 'server.log'), AGENT007_CONFIG_DIR: '/cfg' });
    expect(clone.cwd).toBe(ROOT);
    const npm = serviceDefinition({ ...base, root: tmp('a007-pkg-'), launchEnv: { AGENT007_CONFIG_DIR: '/cfg', PORT: '8008', HOST: '0.0.0.0' } });
    expect(npm.env).toMatchObject({ PORT: '8008', HOST: '0.0.0.0' });
    expect(npm.cwd).toBe('/cfg');
  });

  it('PATH comes from a bare login shell, read between markers; node\'s folder first, no repeats', async () => {
    let seen;
    const run = async (cmd, args, opts) => { seen = { cmd, args, opts }; return loginShell(cmd); };
    expect(await loginShellPath(run, { SHELL: '/bin/zsh', HOME: '/h', USER: 'ada', PATH: '/junk/node_modules/.bin' })).toBe(LOGIN_PATH);
    expect(seen.args[0]).toBe('-ilc');
    expect(seen.opts.env).toEqual({ HOME: '/h', USER: 'ada', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
    expect(await loginShellPath(async () => ({ code: 1, stdout: '' }), {})).toBe(null);
    expect(mergePath('/opt/node/bin/node', '/a:/opt/node/bin:/b:/a')).toBe('/opt/node/bin:/a:/b');
  });

  it('service state from launchctl print and systemctl show', () => {
    expect(parseServiceState('launchd', `gui/501/${LABEL} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tendpoints = {\n\t\tstate = active\n\t}\n}`))
      .toEqual({ running: true, state: 'running', pid: 4242 });
    expect(parseServiceState('launchd', '\tstate = not running\n')).toEqual({ running: false, state: 'not', pid: null });
    expect(parseServiceState('systemd', 'ActiveState=active\nMainPID=99\n')).toEqual({ running: true, state: 'active', pid: 99 });
    expect(parseServiceState('systemd', 'ActiveState=failed\nMainPID=0\n')).toEqual({ running: false, state: 'failed', pid: null });
  });

  it('uptime reads short', () => {
    expect([12, 125, 7260, 90000].map(formatUptime)).toEqual(['12s', '2m', '2h 1m', '1d 1h']);
  });
});

describe('install / uninstall', () => {
  it('linux: writes the unit under the temp HOME, then daemon-reload, enable, restart and linger', async () => {
    const ctx = fakeCtx({ answer: (cmd, args) => (cmd === 'loginctl' && args[0] === 'show-user' ? { stdout: 'yes\n' } : loginShell(cmd)) });
    expect(await runCommand('install', {}, ctx)).toBe(0);
    const file = join(ctx.home, '.config', 'systemd', 'user', UNIT);
    const { args, env } = parseServiceFile(readFileSync(file, 'utf8'));
    expect(args).toEqual(['/opt/node/bin/node', '/opt/app/bin/agent-007.js']);
    expect(env.PATH).toBe(`/opt/node/bin:${LOGIN_PATH}`);
    expect(env.AGENT007_LOG).toBe(join(ctx.home, '.agent-007', 'logs', 'server.log'));
    expect(ctx.calls.filter(c => !c.startsWith('/bin/zsh'))).toEqual([
      'systemctl --user daemon-reload', `systemctl --user enable ${UNIT}`, `systemctl --user restart ${UNIT}`, 'loginctl show-user ada -p Linger --value',
    ]);
    expect(ctx.out.join('\n')).toContain('Installed');

    expect(await runCommand('uninstall', {}, ctx)).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(ctx.calls).toContain(`systemctl --user disable --now ${UNIT}`);
    expect(existsSync(join(ctx.home, '.agent-007', 'logs'))).toBe(true);
  });

  it('linger off and not fixable: says how to fix it', async () => {
    const ctx = fakeCtx({ answer: (cmd) => (cmd === 'loginctl' ? { stdout: 'no\n' } : loginShell(cmd)) });
    expect(await runCommand('install', {}, ctx)).toBe(0);
    expect(ctx.calls).toContain('loginctl enable-linger ada');
    expect(ctx.out.join('\n')).toContain('sudo loginctl enable-linger ada');
  });

  it('macOS: bootout, then bootstrap, retrying while launchd answers EIO', async () => {
    let tries = 0;
    const ctx = fakeCtx({
      platform: 'darwin',
      answer: (cmd, args) => {
        if (cmd === 'launchctl' && args[0] === 'print') return { code: 113 };
        if (cmd === 'launchctl' && args[0] === 'bootstrap') return { code: ++tries < 3 ? 5 : 0 };
        return loginShell(cmd);
      },
    });
    expect(await runCommand('install', {}, ctx)).toBe(0);
    const file = join(ctx.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    expect(serviceFilePath('launchd', ctx.home)).toBe(file);
    expect(parseServiceFile(readFileSync(file, 'utf8')).env.AGENT007_SERVICE).toBe('launchd');
    expect(ctx.calls.filter(c => c.startsWith('launchctl bootstrap'))).toHaveLength(3);
    expect(ctx.calls[1]).toBe(`launchctl bootout gui/501/${LABEL}`);
  });

  it('--dry-run prints the file and writes nothing', async () => {
    const ctx = fakeCtx({ answer: loginShell });
    expect(await runCommand('install', { 'dry-run': true }, ctx)).toBe(0);
    expect(ctx.out.join('\n')).toContain('ExecStart="/opt/node/bin/node" "/opt/app/bin/agent-007.js"');
    expect(existsSync(join(ctx.home, '.config'))).toBe(false);
    expect(ctx.calls.filter(c => !c.startsWith('/bin/zsh'))).toEqual([]);
  });

  it('refuses while a server runs in a terminal, or the port is taken; Windows and npx are not supported', async () => {
    const info = { pid: process.pid, port: 7007, token: 't' };
    const terminal = fakeCtx({ readServer: () => info, callServer: async () => ({ pid: process.pid, port: 7007, service: null }) });
    expect(await runCommand('install', {}, terminal)).toBe(1);
    expect(terminal.out.join('\n')).toMatch(/already running in a terminal .*Ctrl-C/);
    const taken = fakeCtx({ portState: async () => 'other' });
    expect(await runCommand('install', {}, taken)).toBe(1);
    expect(taken.out.join('\n')).toContain('Port 7007 is in use by another program');
    const win = fakeCtx({ platform: 'win32' });
    expect(await runCommand('install', {}, win)).toBe(1);
    expect(win.out.join('\n')).toMatch(/not supported on win32 yet\. Run it in a terminal/);
    const npx = fakeCtx({ root: '/home/ada/.npm/_npx/abc/node_modules/@bill10/agent-007' });
    expect(await runCommand('install', {}, npx)).toBe(1);
    expect(npx.out.join('\n')).toContain('npm install -g @bill10/agent-007');
    for (const c of [terminal, taken, win, npx]) expect(existsSync(join(c.home, '.config'))).toBe(false);
  });

  it("carries the old folder's ./.env into the config dir's, never overwriting a key and never printing a value", async () => {
    const ctx = fakeCtx({ answer: loginShell });
    writeFileSync(join(ctx.cwd, '.env'), '# old terminal setup\nALLOWED_ORIGINS=mac-mini.tail1.ts.net\nexport PORT=7010\nTELEGRAM_BOT_TOKEN="123:secret" # bot\nHOST=0.0.0.0\nKEY="multi\nline"\n');
    const shared = join(ctx.home, '.agent-007', '.env');
    mkdirSync(join(ctx.home, '.agent-007'), { recursive: true });
    writeFileSync(shared, '# HOST=\nHOST=127.0.0.1');
    expect(await runCommand('install', {}, ctx)).toBe(0);
    const text = readFileSync(shared, 'utf8');
    expect(text).toContain('HOST=127.0.0.1\n\n# Carried over from');
    expect(text).toContain('\nALLOWED_ORIGINS=mac-mini.tail1.ts.net\nexport PORT=7010\nTELEGRAM_BOT_TOKEN="123:secret" # bot\n');
    expect(text).not.toContain('0.0.0.0');
    expect(text).not.toContain('multi');
    expect(ctx.out.join('\n')).toContain('Copied ALLOWED_ORIGINS, PORT, TELEGRAM_BOT_TOKEN from');
    expect(ctx.out.join('\n')).not.toContain('secret');
    const made = fakeCtx({ answer: loginShell, cwd: ctx.cwd });
    expect(await runCommand('install', {}, made)).toBe(0);
    if (process.platform !== 'win32') expect(statSync(join(made.home, '.agent-007', '.env')).mode & 0o777).toBe(0o600);
    // Again: nothing left to copy, so nothing is appended or said.
    const again = fakeCtx({ answer: loginShell, home: ctx.home, cwd: ctx.cwd });
    expect(await runCommand('install', {}, again)).toBe(0);
    expect(readFileSync(shared, 'utf8')).toBe(text);
    expect(again.out.join('\n')).not.toContain('Copied');
  });

  it('uninstall with nothing installed says so', async () => {
    const ctx = fakeCtx();
    expect(await runCommand('uninstall', {}, ctx)).toBe(0);
    expect(ctx.out).toEqual(['No Agent 007 service is installed.']);
  });
});

describe('status / restart', () => {
  const live = (over = {}) => ({ pid: process.pid, version: '1.0.0.0', port: 7007, service: null, uptime: 3700, sessions: 3, workers: 0, ...over });

  it('status: how it runs, pid, version, port, uptime, workers, log', async () => {
    const ctx = fakeCtx({ readServer: () => ({ pid: process.pid, token: 't' }), callServer: async () => live({ service: 'systemd', workers: 2 }) });
    writeFileSync(join(mkdirSync(join(ctx.home, '.config', 'systemd', 'user'), { recursive: true }), UNIT), '');
    expect(await runCommand('status', {}, ctx)).toBe(0);
    const text = ctx.out.join('\n');
    expect(text).toContain('Agent 007 1.0.0.0 is running as a service (systemd).');
    expect(text).toContain(`pid ${process.pid}, port 7007, up 1h 1m`);
    expect(text).toContain('workers running: 2');
    expect(text).toContain('server.log');
    const off = fakeCtx();
    expect(await runCommand('status', {}, off)).toBe(3);
    expect(off.out.join('\n')).toMatch(/not running\.\n {2}service: not installed \(agent007 install/);
  });

  it('restart waits for mid-run workers, then asks the server, then reports the new pid', async () => {
    let workers = [2, 2, 1, 0];
    let restarted = false;
    const ctx = fakeCtx({
      readServer: () => ({ pid: restarted ? NEW_PID : process.pid, token: 't' }),
      callServer: async (path, { method } = {}) => {
        if (method === 'POST') { restarted = true; return { ok: true }; }
        return restarted ? live({ pid: NEW_PID, version: '1.1.0.0' }) : live({ workers: workers.shift() ?? 0 });
      },
    });
    expect(await runCommand('restart', {}, ctx)).toBe(0);
    const text = ctx.out.join('\n');
    expect(text.match(/mid-run/g)).toHaveLength(2);
    expect(text).toContain(`Restarted: pid ${process.pid} → ${NEW_PID}, version 1.0.0.0 → 1.1.0.0.`);
  });

  it('--now skips the wait; nothing running and no service is an error', async () => {
    let restarted = false;
    const ctx = fakeCtx({
      readServer: () => ({ pid: restarted ? NEW_PID : process.pid, token: 't' }),
      callServer: async (path, { method } = {}) => {
        if (method === 'POST') { restarted = true; return { ok: true }; }
        return restarted ? live({ pid: NEW_PID }) : live({ workers: 5 });
      },
    });
    expect(await runCommand('restart', { now: true }, ctx)).toBe(0);
    expect(ctx.out.join('\n')).not.toContain('mid-run');
    const none = fakeCtx();
    expect(await runCommand('restart', {}, none)).toBe(1);
  });

  it('waitForIdle: logs when the count changes, returns at 0, null when the server goes away', async () => {
    const seq = [{ workers: 3 }, { workers: 3 }, { workers: 1 }, { workers: 0 }];
    const logs = [];
    let sleeps = 0;
    expect(await waitForIdle({ getStatus: async () => seq.shift(), sleep: async () => { sleeps++; }, log: (s) => logs.push(s) })).toEqual({ workers: 0 });
    expect(sleeps).toBe(3);
    expect(logs.map(l => l.split(' mid-run')[0])).toEqual(['3 workers are', '1 worker is']);
    expect(await waitForIdle({ getStatus: async () => null, sleep: async () => {}, log: () => {} })).toBe(null);
  });
});

describe('update', () => {
  it('decides from what git says', () => {
    expect(checkoutDecision({ dirty: ' M server.js', upstream: 'origin/main' }).error).toMatch(/local changes:\n M server.js/);
    expect(checkoutDecision({ dirty: '', upstream: null }).error).toMatch(/tracks no remote branch/);
    expect(checkoutDecision({ dirty: '', upstream: 'origin/main', ahead: 1, behind: 2 }).error).toMatch(/diverged \(1 local commit, 2 new upstream\)/);
    expect(checkoutDecision({ dirty: '', upstream: 'origin/main', ahead: 0, behind: 0 })).toEqual({ upToDate: true });
    expect(checkoutDecision({ dirty: '', upstream: 'origin/main', ahead: 3, behind: 0 })).toEqual({ upToDate: true });
    expect(checkoutDecision({ dirty: '', upstream: 'origin/main', ahead: 0, behind: 4 })).toEqual({ pull: true });
  });

  // A checkout: root has a .git.
  const checkout = () => { const root = tmp('a007-clone-'); mkdirSync(join(root, '.git')); return root; };
  const gitAnswers = ({ dirty = '', counts = '0\t2', lockChanges = false } = {}) => {
    let pulled = false;
    return (cmd, args) => {
      if (cmd !== 'git') return {};
      const sub = args[2];
      if (sub === 'status') return { stdout: dirty };
      if (sub === 'rev-parse' && args.includes('@{u}')) return { stdout: 'origin/main\n' };
      if (sub === 'rev-list') return { stdout: `${counts}\n` };
      if (sub === 'rev-parse') return { stdout: lockChanges && pulled ? 'new\n' : 'old\n' };
      if (sub === 'pull') { pulled = true; return {}; }
      return {};
    };
  };

  it('checkout: pull --ff-only, npm install only when the lock changed, old → new', async () => {
    let version = '1.0.0.0';
    const ctx = fakeCtx({ root: checkout(), answer: (cmd, args) => { if (args[2] === 'pull') version = '1.1.0.0'; return gitAnswers()(cmd, args); }, version: () => version });
    expect(await runCommand('update', {}, ctx)).toBe(0);
    expect(ctx.calls.some(c => c.endsWith('pull --ff-only'))).toBe(true);
    expect(ctx.calls.some(c => c.startsWith('npm'))).toBe(false);
    expect(ctx.out.join('\n')).toContain('Updated 1.0.0.0 → 1.1.0.0.');
    expect(ctx.out.join('\n')).toContain('not running');

    const locked = fakeCtx({ root: checkout(), answer: gitAnswers({ lockChanges: true }) });
    expect(await runCommand('update', {}, locked)).toBe(0);
    expect(locked.calls).toContain('npm install');
  });

  it('checkout: refuses on local changes or a diverged branch, pulls nothing', async () => {
    for (const answers of [gitAnswers({ dirty: ' M x' }), gitAnswers({ counts: '1\t1' })]) {
      const ctx = fakeCtx({ root: checkout(), answer: answers });
      expect(await runCommand('update', {}, ctx)).toBe(1);
      expect(ctx.calls.some(c => c.includes('pull'))).toBe(false);
    }
    const current = fakeCtx({ root: checkout(), answer: gitAnswers({ counts: '0\t0' }) });
    expect(await runCommand('update', {}, current)).toBe(0);
    expect(current.out).toEqual(['Already up to date (1.0.0.0).']);
  });

  it('checkout with a running server: updates, then restarts it', async () => {
    let restarted = false;
    const ctx = fakeCtx({
      root: checkout(),
      answer: gitAnswers(),
      readServer: () => ({ pid: restarted ? NEW_PID : process.pid, token: 't' }),
      callServer: async (path, { method } = {}) => {
        if (method === 'POST') { restarted = true; return { ok: true }; }
        return { pid: restarted ? NEW_PID : process.pid, version: '1.0.0.0', workers: 0, port: 7007 };
      },
    });
    expect(await runCommand('update', { now: true }, ctx)).toBe(0);
    expect(restarted).toBe(true);
  });

  it('npm global: installs the registry latest exactly; a copy outside npm root -g is refused; npx needs nothing', async () => {
    const root = tmp('a007-global-');
    mkdirSync(join(root, '@bill10', 'agent-007'), { recursive: true });
    const globalCtx = ({ installs = '1.2.0.0', latest = async () => '1.2.0', start = '1.0.0.0' } = {}) => {
      let version = start;
      return fakeCtx({
        root: join(root, '@bill10', 'agent-007'),
        answer: (cmd, args) => {
          if (args[0] === 'root') return { stdout: `${root}\n` };
          if (args[0] === 'install') version = installs;
          return {};
        },
        version: () => version,
        latest,
      });
    };
    const ctx = globalCtx();
    expect(await runCommand('update', {}, ctx)).toBe(0);
    expect(ctx.calls).toEqual(['npm root -g', 'npm install -g @bill10/agent-007@1.2.0 --prefer-online']);
    expect(ctx.out.join('\n')).toContain('Updated 1.0.0.0 → 1.2.0.0.');

    // npm's stale cache reinstalls the old version: said plainly, never "up to date", no restart.
    const stale = globalCtx({ installs: '1.0.0.0' });
    expect(await runCommand('update', {}, stale)).toBe(1);
    expect(stale.out.join('\n')).toMatch(/ERR npm installed 1\.0\.0\.0, not 1\.2\.0\.0.*Retry: npm install -g @bill10\/agent-007@1\.2\.0 --prefer-online/);
    expect(stale.out.join('\n')).not.toContain('up to date');

    const current = globalCtx({ latest: async () => '1.0.0' });
    expect(await runCommand('update', {}, current)).toBe(0);
    expect(current.out.join('\n')).toContain('Already up to date (1.0.0.0).');
    expect(current.calls).toEqual(['npm root -g']);

    const offline = globalCtx({ latest: async () => null });
    expect(await runCommand('update', {}, offline)).toBe(1);
    expect(offline.out.join('\n')).toMatch(/ERR Could not reach the npm registry/);
    expect(offline.out.join('\n')).not.toContain('up to date');

    const elsewhere = fakeCtx({ root: '/somewhere/node_modules/@bill10/agent-007', answer: () => ({ stdout: `${root}\n` }) });
    expect(await runCommand('update', {}, elsewhere)).toBe(1);
    expect(elsewhere.calls).toEqual(['npm root -g']);

    const npx = fakeCtx({ env: { npm_command: 'exec' } });
    expect(await runCommand('update', {}, npx)).toBe(0);
    expect(npx.out.join('\n')).toContain('npx runs the latest version each time');
    expect(npx.calls).toEqual([]);
  });
});

describe('logs', () => {
  it('prints the last lines; caps a log over the limit to one older copy', async () => {
    const home = tmp('a007-logs-');
    const cfg = join(home, '.agent-007');
    mkdirSync(join(cfg, 'logs'), { recursive: true });
    const file = join(cfg, 'logs', 'server.log');
    writeFileSync(file, Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const ctx = fakeCtx({ home, env: { AGENT007_CONFIG_DIR: cfg } });
    expect(await runCommand('logs', { lines: '3' }, ctx)).toBe(0);
    expect(ctx.out).toEqual(['line 77\nline 78\nline 79\n']);
    expect(capLog(file, 10)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('');
    expect(readFileSync(`${file}.1`, 'utf8')).toMatch(/^line 0\n/);
    expect(capLog(file, 10)).toBe(false);
    const none = fakeCtx({ env: { AGENT007_CONFIG_DIR: join(home, 'nope') } });
    expect(await runCommand('logs', {}, none)).toBe(1);
  });
});

describe('server.json', () => {
  it.skipIf(process.platform === 'win32')('is owner-only even when an older one was readable by others', () => {
    const file = join(tmp('a007-sj-'), 'server.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    writeServerFile({ port: 7007, host: '127.0.0.1', token: 'tok', file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readServerFile(file)).toMatchObject({ pid: process.pid, port: 7007, token: 'tok' });
  });
});

// The real thing in a terminal: a server started from bin/agent-007.js,
// `restart` asking it over the control channel, and bin bringing it back in
// the same process tree. Temp HOME and config dir; BILLION off.
describe('restart in a terminal', () => {
  it('status sees it; restart brings it back on a new pid; status and a name of agent007 say so', async () => {
    const home = tmp('a007-restart-home-');
    const cfg = join(home, '.agent-007');
    const env = { ...process.env, HOME: home, USERPROFILE: home, AGENT007_CONFIG_DIR: cfg, BILLION: '0' };
    delete env.npm_command; delete env.npm_lifecycle_event;
    const port = await new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
    // Not execFileSync: the server's output has to keep arriving meanwhile.
    const cli = (args) => new Promise((done) => execFile(process.execPath, [join(ROOT, 'bin/agent-007.js'), ...args], { cwd: home, env, encoding: 'utf8' },
      (err, stdout, stderr) => done({ code: err ? err.code : 0, out: stdout + stderr })));
    const child = spawn(process.execPath, [join(ROOT, 'bin/agent-007.js'), '--port', String(port)], { cwd: home, env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const until = async (cond, what) => {
      for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 100)); }
      throw new Error(`${what}:\n${out}`);
    };
    try {
      await until(() => readServerFile(join(cfg, 'server.json')), 'no server.json');
      const first = readServerFile(join(cfg, 'server.json'));
      expect(first.port).toBe(port);
      const status = await cli(['status']);
      expect(status.out).toContain('is running in a terminal');
      expect(status.code).toBe(0);
      const restarted = await cli(['restart']);
      expect(restarted.out).toMatch(new RegExp(`Restarted: pid ${first.pid} → \\d+`));
      expect(restarted.code).toBe(0);
      await until(() => out.split('is running at').length === 3, 'no second start line');
      expect(out).toContain('Restarting...');
      expect(child.exitCode).toBe(null);
      if (process.platform !== 'win32') {
        // Installed as agent007, it says agent007 back.
        const link = join(home, 'agent007');
        symlinkSync(join(ROOT, 'bin/agent-007.js'), link);
        const named = await new Promise((done) => execFile(process.execPath, [link, 'status'], { cwd: home, env, encoding: 'utf8' }, (e, o) => done(o)));
        expect(named).toContain('agent007 install');
      }
    } finally {
      // The newest server; the old process waits on it and leaves with it.
      const now = readServerFile(join(cfg, 'server.json'));
      try { if (now) process.kill(now.pid); } catch {}
      await until(() => child.exitCode !== null, 'did not exit').catch(() => child.kill());
      await removeTempDir(home);
    }
  }, 60000);
});
