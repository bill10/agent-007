// The Codex side of account rotation (server/account-rotation.js). A Codex
// login is one file, <CODEX_HOME>/auth.json (tokens.id_token, access_token,
// refresh_token, account_id); the config, sessions, skills and history next to
// it are the workspace and never move. A snapshot is that file's text plus the
// account fields read out of it. Activating one writes the text over the
// default home's auth.json, atomically and 0600, through a symlink if it is
// one. Anything else reading that file (another tool symlinked to it) follows.
//
// Codex 0.157's TUI talks to a shared background app server (`codex
// app-server --managed-daemon`) that keeps the login in memory, so a switch
// also stops that daemon (stopCodexDaemon); the next `codex` starts it again
// on the new auth.json. `codex login status` (exit 0 when logged in) is the
// check on both sides. No secret reaches a log, an argument or the browser.
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { runCommand } from './account-migration.js';
import { expandHome } from '../lib/helpers.js';

export const codexHomeOf = (env = process.env, home = homedir()) => (env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex'));
const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };
const claims = (jwt) => { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')) || {}; } catch { return {}; } };

// { accountId, email } from auth.json's text. The account id is the token's
// ChatGPT workspace plus its user, so two people in one Team workspace stay apart.
export function codexIdentity(text) {
  const tokens = JSON.parse(text)?.tokens;
  const c = claims(tokens?.id_token), openai = c['https://api.openai.com/auth'] || {};
  const account = tokens?.account_id || openai.chatgpt_account_id;
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  if (!tokens?.refresh_token || typeof account !== 'string' || !account || !email) throw new Error('Not a ChatGPT login.');
  return { accountId: `${account}:${openai.chatgpt_user_id || openai.user_id || c.sub || ''}`, email };
}

const loggedIn = async (folder, { env, platform, run }) =>
  (await run('codex', ['login', 'status'], { env: { ...env, CODEX_HOME: folder }, platform })).code === 0;

// folder null: the default Codex home, the one the app's sessions use.
export async function captureCodexLogin(folderInput = null, deps = {}) {
  const { home = homedir(), env = process.env, platform = process.platform, run = runCommand } = deps;
  const folder = folderInput === null ? codexHomeOf(env, home) : expandHome(folderInput, home).replace(/(?<=.)[\\/]+$/, '');
  if (!/^[/\\]|^[A-Za-z]:[/\\]/.test(folder)) throw new Error('Give an absolute path to a Codex login folder.');
  let secret, id;
  try { secret = readFileSync(join(folder, 'auth.json'), 'utf8'); id = codexIdentity(secret); }
  catch { throw new Error('Could not read the Codex login.'); }
  if (!(await loggedIn(folder, { env, platform, run }))) throw new Error('This Codex account needs to log in again.');
  return { ...id, secret, folder };
}

export async function activateCodexLogin(snapshot, deps = {}) {
  const { home = homedir(), env = process.env, platform = process.platform, run = runCommand } = deps;
  const folder = codexHomeOf(env, home);
  const file = join(folder, 'auth.json');
  if (!existsSync(file)) throw new Error('The default Codex login is missing. Sign in before switching.');
  if (!snapshot?.secret || !snapshot.accountId || !snapshot.email) throw new Error('The saved Codex login is incomplete.');
  const target = realOr(file);   // keep a symlinked auth.json a symlink
  // A fresh name, created here (wx): never a file or link someone left there.
  const tmp = join(dirname(target), `.auth.json.${randomBytes(8).toString('hex')}.tmp`);
  try { writeFileSync(tmp, snapshot.secret, { mode: 0o600, flag: 'wx' }); renameSync(tmp, target); }
  catch (err) { rmSync(tmp, { force: true }); throw err; }
  if (readFileSync(file, 'utf8') !== snapshot.secret) throw new Error('The Codex login write did not verify.');
  if (!(await loggedIn(folder, { env, platform, run })) || codexIdentity(readFileSync(file, 'utf8')).accountId !== snapshot.accountId) {
    throw new Error('The selected Codex login did not verify.');
  }
}

// Stops Codex's shared background server so it reloads auth.json on its next
// start. Only called with every app Codex session stopped and no other codex
// process running (server/claude-processes.js lets the daemon itself through).
export async function stopCodexDaemon({ env = process.env, platform = process.platform, run = runCommand } = {}) {
  const { code } = await run('codex', ['app-server', 'daemon', 'stop'], { env, platform });
  if (code !== 0) throw new Error('Could not stop the Codex background server. No account was switched.');
}
