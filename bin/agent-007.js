#!/usr/bin/env node
// agent-007 — the command `npx agent-007` (or a global install) runs.
//
// Loads ./.env from the current directory when there is one (the same file
// `npm start` reads in a clone; variables already in the environment win),
// applies --port over both, then starts server.js. Everything the server reads
// or writes resolves from the package or from ~/.agent-007, so it runs the
// same from node_modules as from a clone.

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const HELP = `Usage: agent-007 [--port <n>]
       agent-007 adduser "Display Name"

Starts Agent 007 at http://localhost:7007 (or --port).

Options:
  -p, --port <n>   Port to listen on (overrides PORT)
  -h, --help       Show this help
  -v, --version    Print the version

Settings come from environment variables, or a .env file in the current
directory: PORT, HOST, ALLOWED_ORIGINS, CLAUDE_PERMISSION_MODE,
CODEX_PERMISSION_MODE, AGENT_MESSAGING, BILLION, BILLION_DIR.
See https://github.com/bill10/agent-007#configuration

State lives in ~/.agent-007 (AGENT007_CONFIG_DIR to move it).
\`adduser\` creates a login user and turns on login for the server.
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

if (existsSync('.env')) process.loadEnvFile('.env');

if (positionals[0] === 'adduser') {
  // adduser.js reads the display name from argv[2..].
  process.argv = [process.argv[0], fileURLToPath(new URL('./adduser.js', import.meta.url)), ...positionals.slice(1)];
  await import('./adduser.js');
} else {
  if (positionals.length) {
    console.error(`Unknown command: ${positionals[0]}\n\n${HELP}`);
    process.exit(2);
  }
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`--port must be a whole number from 1 to 65535, not "${values.port}"`);
      process.exit(2);
    }
    process.env.PORT = String(port);
  }
  // Imported only now: server/state.js reads PORT when it loads.
  const { startup, gracefulShutdown } = await import('../server.js');
  startup();
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}
