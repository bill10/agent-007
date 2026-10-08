#!/usr/bin/env node
// agent007 (or agent-007, the older name) — the command `npx @bill10/agent-007`
// (or a global install, a service from `agent007 install`, or `npm start` in a
// clone) runs.
//
// Loads settings (server/settings.js: ./.env, then ~/.agent-007/.env; the real
// environment and --port win over both), then starts server.js. Everything the
// server reads or writes resolves from the package or from ~/.agent-007, so it
// runs the same from node_modules as from a clone.

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { configDir, loadSettings, settingsLine } from '../server/settings.js';

// Each .env.example setting has a line here; test/cli.test.js checks that.
const HELP = `Usage: agent007 [--port <n>]
       agent007 init
       agent007 adduser "Display Name"
       agent007 handover
       agent007 doctor
       agent007 install [--dry-run | --voice | --remote | --public-url <url> | --all [--yes]]
       agent007 uninstall | status
       agent007 restart [--now] | logs [-f] [-n <lines>] | update [--now]

Starts Agent 007 at http://localhost:7007 (or --port). agent-007 is the same
command under its older name; in a clone, npm start -- <command>.

Commands:
  init             Create ~/.agent-007/.env, a commented settings template
  adduser          Create a login user and turn on login for the server
  handover         Write Billion's HANDOVER.md now, from the conversation of
                   the CLI it runs on (a switch writes one by itself)
  doctor           Check what Agent 007 needs (Node, claude/codex, gh, git,
                   your repos, the port, settings, Telegram, the service) and
                   say how to fix what is missing. Changes nothing. Exits 1 on
                   a problem

Run it as a service (macOS and Linux):
  install          Start Agent 007 at login and bring it back if it stops
                   (a LaunchAgent, or a systemd --user unit), with your login
                   shell's PATH. Run it again after moving node or a CLI.
                   --dry-run prints what it would write. In a terminal it then
                   asks whether to set up voice, and remote access when
                   Tailscale is installed
  install --voice  Voice only, no service: whisper.cpp + ffmpeg (Homebrew on
                   macOS; instructions on Linux and Windows), a speech model
                   downloaded to ~/.agent-007/whisper (asks first), and
                   WHISPER_MODEL in ~/.agent-007/.env. Works on Windows too
  install --remote Remote access only, no service: tailscale serve --bg
                   <port> (kept across reboots) and this machine's ts.net
                   name added to ALLOWED_ORIGINS in ~/.agent-007/.env, then a
                   restart. Needs Tailscale installed and logged in; never
                   replaces another site on the HTTPS port without asking.
                   --dry-run prints what it would do
  install --public-url <url>
                   Remote access through a reverse proxy or tunnel you run
                   (Cloudflare Tunnel + Access, caddy over WireGuard), no
                   Tailscale: PUBLIC_URL=<url> in ~/.agent-007/.env, then the
                   service, bound to 127.0.0.1. Point the proxy at
                   http://127.0.0.1:<port>; docs/REMOTE.md. With --all, takes
                   the place of Tailscale
  install --all    The service, voice and remote access, no questions;
                   --yes also accepts the default model's download
  uninstall        Stop and remove the service; ~/.agent-007 is kept
  status           Running or not, how, pid, version, port, uptime, workers,
                   remote access (PUBLIC_URL, the proxy's last request)
  restart          Restart it, in a terminal or as a service. Waits for board
                   workers mid-run to finish their step unless --now
  logs             The service's log (~/.agent-007/logs/server.log); -f follows
  update           git pull (a clone) or npm install -g (an install), then
                   restart

Options:
  -p, --port <n>   Port to listen on (overrides PORT)
  -h, --help       Show this help
  -v, --version    Print the version

Settings (default in brackets):
  PORT                    Port to listen on [7007]
  HOST                    Interface to bind; 0.0.0.0 to reach it from a phone
                          or over Tailscale [127.0.0.1]
  ALLOWED_ORIGINS         Extra hostnames the browser may use, comma-separated,
                          e.g. your tailnet name [none]
  PUBLIC_URL              The https address a reverse proxy or tunnel serves
                          the app at; allowed as an origin and used in links
                          (docs/REMOTE.md) [none]
  CLAUDE_PERMISSION_MODE  Mode Claude Code agents start in: auto, acceptEdits,
                          bypassPermissions, manual, dontAsk, plan [Claude's own]
  CODEX_PERMISSION_MODE   The same for Codex agents [Codex's own]
  AGENT_MESSAGING         open = any agent may message any other [guarded]
  RESPAWN_BOARD_WORKERS   0 = Billion's workers stay orphaned after a restart [on]
  BILLION                 0 turns off Billion, the always-on agent [on]
  BILLION_DIR             Billion's folder and repo [~/.agent-007/billion]
  BILLION_AGENT           claude or codex: the CLI Billion runs on. A switch
                          from the app holds until this changes [claude]
  BILLION_AUTO_SWITCH     0 = Billion stays on its CLI at a usage limit
                          instead of switching to the other [on]
  TELEGRAM_BOT_TOKEN      Bot token for Billion's questions on your phone [off]
  TELEGRAM_CHAT_ID        Your chat with that bot; only it reaches Billion [none]
  TELEGRAM_VOICE          mirror, always or never: Billion's messages as
                          voice (macOS say + ffmpeg) [mirror]
  SAY_VOICE               macOS voice for that, from say -v '?' [best
                          installed English Premium/Enhanced voice]
  SAY_RATE                How fast it speaks, words per minute, 120-300
                          [unset: the voice's own system speed]
  WHISPER_MODEL           whisper.cpp model file; your voice notes are
                          transcribed locally [off]
  WHISPER_CPP_BIN         whisper.cpp CLI if not on PATH [whisper-cli]
  TRUST_BOARD_WORKTREES   0 keeps Claude Code's and Codex's folder-trust
                          prompt for job board workers [on]
  SKILL_FAMILIES          0 lists every skill in full for the Claude Code
                          agents Agent 007 starts, no families [on]

Set them in the environment, in ~/.agent-007/.env (\`agent007 init\` writes it,
every setting explained and commented out), or in a .env in the current
directory. Highest first: flags, environment, ./.env, ~/.agent-007/.env.

State lives in ~/.agent-007 (AGENT007_CONFIG_DIR to move it).
See https://github.com/bill10/agent-007#settings
`;

// As launched, before any settings file: what a restart or a service starts
// from, so an edited .env is read again rather than frozen in.
const launchEnv = { ...process.env };
const SERVICE_COMMANDS = ['install', 'uninstall', 'status', 'restart', 'logs', 'update'];

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'dry-run': { type: 'boolean' },
      now: { type: 'boolean' },
      voice: { type: 'boolean' },
      remote: { type: 'boolean' },
      'public-url': { type: 'string' },
      all: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      follow: { type: 'boolean', short: 'f' },
      lines: { type: 'string', short: 'n' },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}
const { values, positionals } = parsed;

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  console.log(readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim());
  process.exit(0);
}

if (values.port !== undefined) {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port must be a whole number from 1 to 65535, not "${values.port}"`);
    process.exit(2);
  }
  // Before the files load, which never overwrite a variable already set.
  process.env.PORT = String(port);
  launchEnv.PORT = String(port);
}
// Starting with it is PUBLIC_URL for this run; install writes it to the settings file instead.
if (values['public-url'] !== undefined && positionals[0] !== 'install') {
  process.env.PUBLIC_URL = values['public-url'];
  launchEnv.PUBLIC_URL = values['public-url'];
}
if (positionals.length && !['init', 'adduser', 'handover', 'doctor', ...SERVICE_COMMANDS].includes(positionals[0])) {
  console.error(`Unknown command: ${positionals[0]}\n\n${HELP}`);
  process.exit(2);
}

const settingsFiles = loadSettings();

// Said the way it was launched, so it can be pasted back.
// A service runs bin/agent-007.js itself: a clone's is `npm start`, an install's `agent007`.
function ownCommand(sub) {
  const said = (() => {
    if (process.env.npm_command === 'exec') return `npx @bill10/agent-007 ${sub}`;
    if (process.env.npm_lifecycle_event) return `npm start -- ${sub}`;
    const name = basename(process.argv[1] || '');
    if (name === 'agent007' || name === 'agent-007') return `${name} ${sub}`;
    if (process.env.AGENT007_SERVICE) return existsSync(new URL('../.git', import.meta.url)) ? `npm start -- ${sub}` : `agent007 ${sub}`;
    return `npx @bill10/agent-007 ${sub}`;
  })();
  return said.trim().replace(/ --$/, '');
}
const initCommand = () => ownCommand('init');

if (positionals[0] === 'init') {
  const file = join(configDir(), '.env');
  mkdirSync(configDir(), { recursive: true });
  try {
    // wx: never overwrite someone's settings.
    writeFileSync(file, readFileSync(new URL('../.env.example', import.meta.url)), { flag: 'wx' });
    console.log(`Created ${file}\nEvery setting in it is commented out, so nothing changes yet. Edit it, then restart agent-007.`);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    console.log(`${file} already exists, left as it is. Edit it, then restart agent-007.`);
  }
} else if (positionals[0] === 'adduser') {
  // adduser.js reads the display name from argv[2..].
  process.argv = [process.argv[0], fileURLToPath(new URL('./adduser.js', import.meta.url)), ...positionals.slice(1)];
  await import('./adduser.js');
} else if (positionals[0] === 'handover') {
  // Imported only now, like server.js: server/state.js reads settings when it loads.
  const { billionDir, billionAgent } = await import('../server/billion.js');
  const { writeHandover } = await import('../server/billion-handover.js');
  const { path, messages } = writeHandover(billionDir(), { from: billionAgent() });
  console.log(`Wrote ${path} (${messages} messages)`);
} else if (positionals[0] === 'doctor') {
  const { runDoctor, defaultProbes, formatSection, formatSummary, useColor, failed } = await import('../server/doctor.js');
  const color = useColor(process.stdout, process.env);
  // Each section prints as it finishes, in a fixed order.
  const results = await runDoctor({
    probes: defaultProbes({ settingsLine: settingsLine(settingsFiles, initCommand()), installCommand: ownCommand('install') }),
    onSection: (section) => process.stdout.write(formatSection(section, { color })),
  });
  // Exit once written (a pipe on macOS is asynchronous), not on its own: a
  // probe that has not timed out yet would hold the loop open.
  process.stdout.write(`${formatSummary(results, { color })}\n`, () => process.exit(failed(results) ? 1 : 0));
} else if (SERVICE_COMMANDS.includes(positionals[0])) {
  const { runCommand, defaultContext } = await import('../server/service.js');
  process.exitCode = await runCommand(positionals[0], values, defaultContext({ launchEnv, cmd: ownCommand }));
} else {
  // Said out loud: run from inside another project, its .env (a HOST=0.0.0.0,
  // say) would otherwise change this server without a word.
  console.log(`  ${settingsLine(settingsFiles, initCommand())}`);
  // The fast checks run while server.js loads, and the start waits for them
  // no longer than STARTUP_CHECK_MS in all. Only problems are printed.
  const STARTUP_CHECK_MS = 2000;
  const doctor = import('../server/doctor.js').then(d => d.runDoctor({ fast: true, budgetMs: STARTUP_CHECK_MS })
    // With --port, so doctor checks this port and not PORT's.
    .then(results => d.formatStartup(results, ownCommand(values.port ? `doctor --port ${values.port}` : 'doctor'), { color: d.useColor() })))
    .catch(() => '');
  // Imported only now: server/state.js reads PORT when it loads.
  const { startup, gracefulShutdown } = await import('../server.js');
  const { RESTART_EXIT } = await import('../server/control.js');
  if (process.env.AGENT007_LOG) {
    // Under the service: its log, kept to a size now and every hour.
    const { capLog } = await import('../server/service.js');
    capLog(process.env.AGENT007_LOG);
    setInterval(() => capLog(process.env.AGENT007_LOG), 3600_000).unref();
  } else if (!process.env.AGENT007_RESTARTED) {
    // In a terminal, `agent007 restart` makes the server exit with
    // RESTART_EXIT; start it again here, in the same terminal, until it exits
    // for any other reason. The old process waits (blocked, its loops
    // stopped) and leaves with the new one's exit code.
    process.on('exit', (code) => {
      let status = code;
      while (status === RESTART_EXIT) {
        status = spawnSync(process.execPath, [...process.execArgv.filter(a => !a.startsWith('--watch')), ...process.argv.slice(1)], {
          stdio: 'inherit', env: { ...launchEnv, AGENT007_RESTARTED: '1' },
        }).status ?? 1;
      }
      process.exitCode = status;
    });
  }
  const problems = await doctor;
  if (problems) console.log(problems);
  startup();
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}
