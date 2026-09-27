// Which AI agent CLIs are installed on this machine, and which accounts each is
// logged in with, for the Settings panel. Read-only: nothing here switches,
// adds or edits an account, and nothing writes under any CLI's config folder.
//
// An account is a login config folder: ~/.claude (or CLAUDE_CONFIG_DIR) and
// ~/.claude-* siblings, ~/.codex (or CODEX_HOME) and ~/.codex-* siblings,
// ~/.gemini. Every child process is a local status check with a timeout, run
// in parallel, so one slow or broken CLI never holds up the rest. No model
// calls, no network.
//
// What leaves this module is only: cli, version, path, and per account
// folder, isDefault, email, plan, org, loggedIn. Never a token, and emails are
// never logged.

import { execFile } from 'child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { commandPath } from './command-path.js';
import { ptyEnv } from '../lib/helpers.js';

export const CLIS = ['claude', 'codex', 'gemini', 'opencode', 'aider', 'hermes', 'cursor-agent', 'amp', 'goose', 'qwen', 'crush'];
const TIMEOUT_MS = 8000;

// { code, stdout, stderr } when the CLI ran (code is its exit status), null
// when it could not be started. A .cmd shim on Windows runs only through a
// shell; the arguments are fixed, and the path is quoted for one with spaces.
// There the timeout kills only cmd.exe, so the tree is taken down with it.
function runCli(file, args, { env, platform }) {
  return new Promise((done) => {
    const win = platform === 'win32';
    const child = execFile(win ? `"${file}"` : file, args, { env, shell: win, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => { clearTimeout(reap); done(err && typeof err.code !== 'number' ? null : { code: err ? err.code : 0, stdout, stderr }); });
    const reap = win && setTimeout(() => execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}), TIMEOUT_MS);
  });
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const firstLine = (s) => String(s ?? '').split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 80) || null;
const str = (v) => (typeof v === 'string' && v ? v : null);

// Home-dir siblings like ~/.claude-work or ~/.codex_personal that pass `real`.
function siblings(home, base, real) {
  let names = [];
  try { names = readdirSync(home); } catch {}
  return names
    .filter(n => n.startsWith(`${base}-`) || n.startsWith(`${base}_`))
    .map(n => join(home, n))
    .filter(p => isDir(p) && real(p))
    .sort();
}

// The folder agents use (the env override, else the home default) first, then
// the home default when the override moved it, then siblings. Only folders that exist.
function folders(home, base, override, real) {
  const def = override ? resolve(override) : join(home, base);
  return [...new Set([def, join(home, base), ...siblings(home, base, real)])]
    .filter(isDir)
    .map(folder => ({ folder, isDefault: folder === def }));
}

// Only the payload of the id_token JWT, decoded locally, and only its email
// claim. The file's contents go no further than this function.
export function codexEmail(folder, read = readFileSync) {
  try {
    const jwt = JSON.parse(read(join(folder, 'auth.json'), 'utf8'))?.tokens?.id_token;
    return str(JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'))?.email);
  } catch { return null; }
}

// Gemini CLI records its Google sign-in in google_accounts.json as { active: "<email>", old: [...] }.
export function geminiEmail(folder, read = readFileSync) {
  try { return str(JSON.parse(read(join(folder, 'google_accounts.json'), 'utf8'))?.active); } catch { return null; }
}

/**
 * One scan. Everything outside comes in, so the tests need no real HOME or CLI:
 * which(cli) is the path or null, run(file, args, { env, platform }) is runCli.
 */
export async function scanAgents({
  env = process.env, home = homedir(), platform = process.platform,
  which = (c) => commandPath(c, env, platform), run = runCli, timeoutMs = TIMEOUT_MS,
} = {}) {
  const exec = (file, args, extraEnv = {}) => {
    // The same environment an agent gets: none of the server's own secrets.
    const childEnv = { ...ptyEnv(env), ...extraEnv };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    let timer;
    const late = new Promise(r => { timer = setTimeout(() => r(null), timeoutMs); });
    return Promise.race([Promise.resolve(run(file, args, { env: childEnv, platform })).catch(() => null), late])
      .finally(() => clearTimeout(timer));
  };

  const claudeAccount = async (file, { folder, isDefault }) => {
    // The home default is what claude uses with CLAUDE_CONFIG_DIR unset (its login may be in the Keychain).
    const r = await exec(file, ['auth', 'status', '--json'], { CLAUDE_CONFIG_DIR: folder === join(home, '.claude') ? undefined : folder });
    let s = null;
    try { if (r) s = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch {}
    return { folder, isDefault, email: str(s?.email), plan: str(s?.subscriptionType), org: str(s?.orgName), loggedIn: s ? s.loggedIn === true : null };
  };

  const codexAccount = async (file, { folder, isDefault }) => {
    const r = await exec(file, ['login', 'status'], { CODEX_HOME: folder });
    const out = r ? `${r.stdout}\n${r.stderr}` : '';
    const plan = !r || r.code !== 0 ? null : /chatgpt/i.test(out) ? 'ChatGPT' : /api key/i.test(out) ? 'API key' : null;
    return { folder, isDefault, email: codexEmail(folder), plan, org: null, loggedIn: r ? r.code === 0 : null };
  };

  const accounts = {
    claude: (file) => Promise.all(folders(home, '.claude', env.CLAUDE_CONFIG_DIR,
      p => ['.claude.json', '.credentials.json', 'settings.json', 'projects'].some(f => existsSync(join(p, f))))
      .map(a => claudeAccount(file, a))),
    codex: (file) => Promise.all(folders(home, '.codex', env.CODEX_HOME, p => existsSync(join(p, 'auth.json')))
      .map(a => codexAccount(file, a))),
    gemini: async () => folders(home, '.gemini', null, () => false).map(({ folder, isDefault }) => {
      const email = geminiEmail(folder);
      // No active Google account may still mean an API key login, so logged out is not known.
      return { folder, isDefault, email, plan: null, org: null, loggedIn: email ? true : null };
    }),
  };

  const found = await Promise.all(CLIS.map(async (cli) => {
    const path = which(cli);
    if (!path) return null;
    const [v, accts] = await Promise.all([
      exec(path, ['--version']),
      (accounts[cli]?.(path) ?? Promise.resolve([])).catch(() => []),
    ]);
    return { cli, version: v && v.code === 0 ? firstLine(v.stdout) || firstLine(v.stderr) : null, path, accounts: accts };
  }));
  return found.filter(Boolean);
}

// Scanned once at server start and on Refresh; the panel shows the last one.
let cached = null;
let scanning = null;

export function refreshAgentAccounts(opts) {
  scanning ||= scanAgents(opts)
    .then(agents => (cached = { scannedAt: Date.now(), agents }))
    .catch(err => { console.error(`Agent accounts: scan failed: ${err?.message ?? err}`); return cached ?? { scannedAt: Date.now(), agents: [] }; })
    .finally(() => { scanning = null; });
  return scanning;
}

export function agentAccounts() {
  return cached ? Promise.resolve(cached) : refreshAgentAccounts();
}
