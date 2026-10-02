// Where settings come from, for bin/agent-007.js (which `npm start` runs too).
// Imports nothing from state.js: that module reads PORT and HOST when it loads,
// so it may only be imported once the files below are in process.env.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { parseEnv } from 'util';

// Everything the app saves, and the settings file `agent-007 init` writes.
export function configDir(env = process.env) {
  return env.AGENT007_CONFIG_DIR || join(homedir(), '.agent-007');
}

// ./.env first, then <config dir>/.env. process.loadEnvFile never overwrites a
// variable that is already set, so the real environment beats ./.env, and
// ./.env beats the config-dir file. Returns the files it loaded.
export function loadSettings() {
  const files = [];
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
    files.push(resolve('.env'));
  }
  // Resolved after ./.env, which may set AGENT007_CONFIG_DIR.
  const shared = join(configDir(), '.env');
  if (existsSync(shared) && !files.includes(resolve(shared))) {
    process.loadEnvFile(shared);
    files.push(resolve(shared));
  }
  return files;
}

export const tilde = (p) => {
  const home = homedir();
  return p.startsWith(home + '/') || p.startsWith(home + '\\') ? '~' + p.slice(home.length) : p;
};

// One startup line saying where settings came from, or how to make the file.
export function settingsLine(files, initCommand) {
  return files.length
    ? `Settings: ${files.map(tilde).join(', ')}`
    : `Settings: defaults (run \`${initCommand}\` to create ${tilde(join(configDir(), '.env'))})`;
}

// Settings a service would lose: it runs in another folder (the config dir, for
// an install), so a ./.env here stops applying. Appends each key of `from` that
// `to` does not set, its line as written, and never changes a key `to` has.
// Returns the keys copied. ponytail: a multi-line quoted value is not copied.
export function carryOverEnv(from, to) {
  if (!existsSync(from) || resolve(from) === resolve(to)) return [];
  const have = existsSync(to) ? parseEnv(readFileSync(to, 'utf8')) : {};
  const lines = readFileSync(from, 'utf8').split(/\r?\n/);
  const src = parseEnv(lines.join('\n'));
  const add = [];
  for (const key of Object.keys(src)) {
    if (key in have) continue;
    // The one line that sets it alone, or none (a multi-line value) to copy.
    const line = lines.findLast(l => new RegExp(`^\\s*(export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(l));
    if (line && parseEnv(line)[key] === src[key]) add.push([key, line.trim()]);
  }
  if (!add.length) return [];
  // Owner-only when this makes the file: it may now hold a token.
  mkdirSync(dirname(resolve(to)), { recursive: true });
  const old = existsSync(to) ? readFileSync(to, 'utf8') : '';
  appendFileSync(to, `${old && !old.endsWith('\n') ? '\n' : ''}\n# Carried over from ${tilde(resolve(from))}\n${add.map(([, l]) => l).join('\n')}\n`, { mode: 0o600 });
  return add.map(([k]) => k);
}
