// Where settings come from, for bin/agent-007.js (which `npm start` runs too).
// Imports nothing from state.js: that module reads PORT and HOST when it loads,
// so it may only be imported once the files below are in process.env.

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

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

const tilde = (p) => {
  const home = homedir();
  return p.startsWith(home + '/') || p.startsWith(home + '\\') ? '~' + p.slice(home.length) : p;
};

// One startup line saying where settings came from, or how to make the file.
export function settingsLine(files, initCommand) {
  return files.length
    ? `Settings: ${files.map(tilde).join(', ')}`
    : `Settings: defaults (run \`${initCommand}\` to create ${tilde(join(configDir(), '.env'))})`;
}
