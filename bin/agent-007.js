#!/usr/bin/env node
// agent-007 — the command `npx @bill10/agent-007` (or a global install, or
// `npm start` in a clone) runs.
//
// Loads settings (server/settings.js: ./.env, then ~/.agent-007/.env; the real
// environment and --port win over both), then starts server.js. Everything the
// server reads or writes resolves from the package or from ~/.agent-007, so it
// runs the same from node_modules as from a clone.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { configDir, loadSettings, settingsLine } from '../server/settings.js';

// Each .env.example setting has a line here; test/cli.test.js checks that.
const HELP = `Usage: agent-007 [--port <n>]
       agent-007 init
       agent-007 adduser "Display Name"

Starts Agent 007 at http://localhost:7007 (or --port).

Commands:
  init             Create ~/.agent-007/.env, a commented settings template
  adduser          Create a login user and turn on login for the server

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
  CLAUDE_PERMISSION_MODE  Mode Claude Code agents start in: auto, acceptEdits,
                          bypassPermissions, manual, dontAsk, plan [Claude's own]
  CODEX_PERMISSION_MODE   The same for Codex agents [Codex's own]
  AGENT_MESSAGING         open = any agent may message any other [guarded]
  BILLION                 0 turns off Billion, the always-on agent [on]
  BILLION_DIR             Billion's folder and repo [~/.agent-007/billion]
  TRUST_BOARD_WORKTREES   0 keeps Claude Code's folder-trust prompt for job
                          board workers [on]

Set them in the environment, in ~/.agent-007/.env (\`agent-007 init\` writes it,
every setting explained and commented out), or in a .env in the current
directory. Highest first: flags, environment, ./.env, ~/.agent-007/.env.

State lives in ~/.agent-007 (AGENT007_CONFIG_DIR to move it).
See https://github.com/bill10/agent-007#settings
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
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
}
if (positionals.length && !['init', 'adduser'].includes(positionals[0])) {
  console.error(`Unknown command: ${positionals[0]}\n\n${HELP}`);
  process.exit(2);
}

const settingsFiles = loadSettings();

// Said the way it was launched, so it can be pasted back.
function initCommand() {
  if (process.env.npm_command === 'exec') return 'npx @bill10/agent-007 init';
  if (process.env.npm_lifecycle_event) return 'npm start -- init';
  if (basename(process.argv[1] || '') === 'agent-007') return 'agent-007 init';
  return 'npx @bill10/agent-007 init';
}

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
} else {
  // Said out loud: run from inside another project, its .env (a HOST=0.0.0.0,
  // say) would otherwise change this server without a word.
  console.log(`  ${settingsLine(settingsFiles, initCommand())}`);
  // Imported only now: server/state.js reads PORT when it loads.
  const { startup, gracefulShutdown } = await import('../server.js');
  startup();
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}
