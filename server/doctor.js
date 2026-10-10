// `agent-007 doctor`, and the short check every start runs (bin/agent-007.js).
//
// Report only: nothing here writes, deletes, installs, logs in, switches a gh
// account or uninstalls anything, and no token is ever printed. Each check
// returns lines of { status: 'ok' | 'fail' | 'na', text, fix? }. Everything
// that touches the machine comes in through `probes`, so the tests run no real
// CLI and no network. The defaults are the app's own: the Settings panel's CLI
// scan, the board's gh account walk, gitExec, Telegram's Bot API call. Only the
// port probe and the npm registry read are new here.
//
// Imported only after the settings files are loaded: state.js reads PORT when
// it loads.

import { existsSync, readFileSync, readdirSync, readlinkSync } from 'fs';
import { execFile } from 'child_process';
import { createServer } from 'net';
import path, { dirname, join } from 'path';
import { parseEnv } from 'util';
import { CONFIG_PATH, WORKTREE_DIR, PORT, HOST, WILDCARD_BIND_HOSTS, originHost, parsePublicUrl } from './state.js';
import { refreshAgentAccounts } from './agent-accounts.js';
import { commandPath, INSTALL_HINTS } from './command-path.js';
import { billionAgent, billionRuns } from './billion.js';
import { ghAccounts, ghAccountFor, ghAgentEnv, parseGithubRemote } from './jobs.js';
import { telegramGetMe } from './owner.js';
import { gitExec, resolveBaseBranch, commitsNotInBase } from './git.js';
import { configDir, tilde } from './settings.js';
import { jobAgent, jobRequiresPr, JOB_AGENTS } from '../lib/jobs.js';
import { installedService, parseServiceFile, remoteLines } from './service.js';
import { callServer } from './control.js';
import { tailscaleBin, serveTargets } from './tailscale.js';
import { whisperSetup } from './voice.js';
import { skillHomes, skillsDirs, skillDir } from './skills.js';

export const MARKS = { ok: '✓', fail: '✗', na: '–' };
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const LOGIN = { claude: 'claude auth login', codex: 'codex login' };
// Local git calls, and the one that asks the remote.
const LOCAL_GIT_MS = 3000;
const REMOTE_GIT_MS = 10_000;
const NET_MS = 5000;
const PORT_PAGE_MS = 1000;

const ok = (text) => ({ status: 'ok', text });
const na = (text) => ({ status: 'na', text });
const fail = (text, fix) => ({ status: 'fail', text, fix });
const firstLine = (s) => String(s ?? '').trim().split('\n')[0].slice(0, 200);
// A path as a fix line types it: ~-short when the shell needs no quotes,
// else the full path in single quotes, where nothing expands (nor would ~).
const shellPath = (path) => (/^[\w@%+=:,./~-]+$/.test(tilde(path)) ? tilde(path) : `'${path.replace(/'/g, `'\\''`)}'`);
// A URL's user:token@ never reaches the screen.
const redact = (s) => String(s).replace(/\/\/[^@\s/]+@/g, '//***@');

// "a.b.c" >= "x.y.z", numerically; missing parts are 0.
export function versionAtLeast(have, want) {
  const a = String(have).replace(/^v/, '').split('.').map(Number);
  const b = String(want).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

// --- Probes: the real machine ---

// 'free', 'agent-007' (answers with our page title), 'other', or the error
// code when the port cannot be listened on at all (EACCES, EADDRNOTAVAIL).
export function portState(port, host) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', async (err) => {
      if (err.code !== 'EADDRINUSE') return done(err.code || 'error');
      const at = WILDCARD_BIND_HOSTS.includes(host) ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
      try {
        const html = await (await fetch(`http://${at}:${port}/`, { signal: AbortSignal.timeout(PORT_PAGE_MS) })).text();
        done(/<title>Agent 007<\/title>/.test(html) ? 'agent-007' : 'other');
      } catch { done('other'); }
    });
    probe.listen(Number(port), host, () => probe.close(() => done('free')));
  });
}

// What `npm view <name> version` answers, read from the registry directly:
// npm itself writes a log and its cache under ~/.npm, and this only reports.
export async function npmLatest() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG.name.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(NET_MS) });
    return res.ok ? (await res.json())?.version || null : null;
  } catch { return null; }
}

export function defaultProbes({ env = process.env, settingsLine = null, installCommand = 'agent007 install' } = {}) {
  return {
    env,
    nodeVersion: process.versions.node,
    engines: PKG.engines?.node || '',
    version: VERSION,
    loadPty: () => import('node-pty'),
    which: (cmd) => commandPath(cmd, env),
    // The server's own scan: one run serves this check and the Settings panel.
    scanAgents: () => refreshAgentAccounts().then(s => s.agents),
    billionAgent: () => billionAgent(env),
    billionRuns: () => billionRuns(env),
    ghAccounts,
    ghAccountFor: (repoPath) => ghAccountFor(repoPath),
    git: (args, timeout, env) => gitExec(args, { timeout, env }),
    // What a board worker on a repo pushes with, for the account found for it.
    repoEnv: (account) => ghAgentEnv(account?.token),
    baseBranch: resolveBaseBranch,
    // From local refs only: the doctor never fetches.
    commitsNotInBase: (orphan) => commitsNotInBase(orphan, { fetch: false }),
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    port: PORT,
    host: HOST,
    portState,
    configPath: CONFIG_PATH,
    worktreeDir: WORKTREE_DIR,
    ...skillHomes(env),
    settingsLine,
    npmLatest,
    telegramGetMe: () => telegramGetMe(env),
    service: () => installedService(),
    // The running server's /control/status (agent007 status), or null.
    serverStatus: () => callServer('/control/status'),
    whichIn: (cmd, PATH) => commandPath(cmd, { PATH }),
    installCommand,
    settingsFile: join(configDir(env), '.env'),
    // `tailscale serve status --json`, or null without tailscale.
    tailscaleServe: () => new Promise((done) => {
      const bin = tailscaleBin(env);
      if (!bin) return done(null);
      execFile(bin, ['serve', 'status', '--json'], { timeout: NET_MS, encoding: 'utf8' }, (err, out) => {
        try { done(err ? null : JSON.parse(out)); } catch { done(null); }
      });
    }),
  };
}

// --- What is on the board, read straight from config.json (never loadConfig,
// which rewrites in-progress jobs as a restart would) ---

function readBoard(p) {
  if (!p.exists(p.configPath)) return { missing: true, repos: [], jobs: [], orphans: [] };
  try {
    const c = JSON.parse(p.readFile(p.configPath));
    const jobs = (Array.isArray(c.jobs) ? c.jobs : []).filter(j => j && j.state !== 'done');
    const isPath = (r) => typeof r === 'string' && r;
    // explorer: the repos added in the Explorer; the rest only cards name.
    const explorer = new Set((Array.isArray(c.repos) ? c.repos : []).map(r => r?.path).filter(isPath));
    const repos = [...new Set([...explorer, ...jobs.map(j => j.repoPath).filter(isPath)])];
    const orphans = (Array.isArray(c.orphans) ? c.orphans : []).filter(o => o && isPath(o.worktreePath) && isPath(o.repoPath));
    return { repos, jobs, explorer, orphans };
  } catch (err) {
    // Only where it broke: V8's message quotes the file's text, which may be anything.
    const at = /position (\d+)/.exec(err.message);
    return { error: `not valid JSON${at ? ` (at character ${at[1]})` : ''}`, repos: [], jobs: [] };
  }
}

// origin's URL per repo, asked once and shared by the gh and repo checks.
function originOf(p, cache) {
  return (repo) => {
    if (!cache.has(repo)) cache.set(repo, p.exists(repo) ? p.git(['-C', repo, 'remote', 'get-url', 'origin'], LOCAL_GIT_MS).then(s => s.trim() || null, () => null) : Promise.resolve(null));
    return cache.get(repo);
  };
}

// The gh account the walk finds per repo, asked once and shared by the gh and
// repo checks (null when none can see it).
function accountOf(p, cache) {
  return (repo) => {
    if (!cache.has(repo)) cache.set(repo, Promise.resolve().then(() => p.ghAccountFor(repo)).catch(() => null));
    return cache.get(repo);
  };
}

// --- The checks ---

export async function checkNode(p) {
  const want = (p.engines.match(/>=\s*([\d.]+)/) || [])[1];
  const lines = [!want || versionAtLeast(p.nodeVersion, want)
    ? ok(`Node ${p.nodeVersion}${want ? ` (needs ${want} or newer)` : ''}`)
    : fail(`Node ${p.nodeVersion} is older than ${want}, which Agent 007 needs`, `Install Node ${want} or newer from https://nodejs.org`)];
  try { await p.loadPty(); lines.push(ok('node-pty loads')); } catch (err) {
    lines.push(fail(`node-pty does not load: ${firstLine(err.message)}`, 'Reinstall Agent 007 (npm install); README "Troubleshooting" covers a failed node-pty build'));
  }
  return lines;
}

export async function checkClis(p, board) {
  const scanned = await p.scanAgents();
  return JOB_AGENTS.map((cli) => {
    const uses = [
      p.billionRuns() && p.billionAgent() === cli && 'Billion runs on it',
      board.jobs.some(j => jobAgent(j) === cli) && 'a board card uses it',
    ].filter(Boolean);
    const needed = uses.length > 0;
    const why = needed ? `; ${uses.join(' and ')}` : '';
    const found = scanned.find(a => a.cli === cli);
    if (!found) return needed ? fail(`${cli} is not installed${why}`, INSTALL_HINTS[cli]) : na(`${cli} not installed (nothing uses it)`);
    const account = found.accounts.find(a => a.isDefault);
    const where = `${cli} ${found.version || '(version unknown)'} at ${tilde(found.path)}`;
    if (account?.loggedIn) return ok(`${where}, logged in${account.plan ? ` (${account.plan})` : ''}`);
    // null: the status command timed out or said something unreadable.
    if (account?.loggedIn === null) {
      return needed ? fail(`${where}, could not tell whether it is logged in${why}`, `${cli} ${cli === 'codex' ? 'login status' : 'auth status'}`) : na(`${where}, login not known (nothing uses it)`);
    }
    return needed ? fail(`${where}, not logged in${why}`, LOGIN[cli]) : na(`${where}, not logged in (nothing uses it)`);
  });
}

// fast: installed only. `gh auth status` and the account walk ask GitHub.
export async function checkGh(p, board, origin, { fast = false, account = accountOf(p, new Map()) } = {}) {
  const gh = p.which('gh');
  // fast: installed only. `gh auth status` and the account walk ask GitHub.
  if (gh && fast) return [ok('gh installed')];
  const github = (await Promise.all(board.repos.map(async (repo) => {
    const slug = parseGithubRemote(await origin(repo));
    return slug && { repo, slug: `${slug.owner}/${slug.name}` };
  }))).filter(Boolean);
  if (!gh) {
    return [github.length
      ? fail(`gh is not installed; the board finds pull requests with it (${github.length} GitHub repo${github.length === 1 ? '' : 's'})`, INSTALL_HINTS.gh)
      : na('gh not installed (no GitHub repo on the board)')];
  }
  if (!github.length) return [na('gh installed (no GitHub repo on the board)')];
  const accounts = await p.ghAccounts();
  if (!accounts.length) return [fail('gh is installed but signed in to no account (or GitHub is not reachable)', 'gh auth login')];
  // The walk takes an account named like the repo's owner on trust; the repo
  // check's ls-remote, run as that account, is what proves it can reach it.
  return [ok(`gh signed in as ${[...new Set(accounts)].join(', ')}`), ...await Promise.all(github.map(async ({ repo, slug }) => {
    const found = await account(repo);
    return found
      ? ok(`${slug}: board workers use ${found.login}`)
      : fail(`${slug}: no signed-in gh account can see it`, 'gh auth login (with an account that can see it; never gh auth switch)');
  }))];
}

export async function checkRepos(p, board, origin, account = accountOf(p, new Map())) {
  if (!p.which('git')) return [fail('git is not installed', 'Install git from https://git-scm.com')];
  const lines = [ok('git installed')];
  if (!board.repos.length) return [...lines, na('no repos on the board')];
  return [...lines, ...await Promise.all(board.repos.map(async (repo) => {
    const name = tilde(repo);
    const sh = shellPath(repo);
    if (!p.exists(repo)) {
      return fail(`${name} does not exist`, board.explorer?.has(repo)
        ? 'Remove it from the Explorer, or put the repo back at that path'
        : 'Edit or archive the board cards that name it, or put the repo back at that path');
    }
    try { await p.git(['-C', repo, 'rev-parse', '--git-dir'], LOCAL_GIT_MS); } catch {
      return fail(`${name} is not a git repository`, `git -C ${sh} status`);
    }
    if (!await origin(repo)) {
      // Worktrees need no remote; only a card that ends in a pull request does.
      return board.jobs.some(j => j.repoPath === repo && jobRequiresPr(j))
        ? fail(`${name} has no origin remote; a card on it needs a pull request`, `git -C ${sh} remote add origin <url>`)
        : na(`${name}: no origin remote (local only)`);
    }
    // null: no origin/HEAD and no local main or master; the board then
    // branches from HEAD, so any branch on the remote will do.
    const base = await p.baseBranch(repo).catch(() => null);
    try {
      const env = {
        ...(parseGithubRemote(await origin(repo)) && p.which('gh') ? p.repoEnv(await account(repo)) : {}),
        // GIT_TERMINAL_PROMPT stops only git's own prompts: an askpass helper
        // (an editor's terminal sets one), ssh's (a new host key, a
        // passphrase) and Git Credential Manager's sign-in would write or log
        // in, so none is asked. An ssh the owner chose is left alone.
        GIT_ASKPASS: '',
        GCM_INTERACTIVE: 'never',
        ...(p.env.GIT_SSH_COMMAND || p.env.GIT_SSH || await p.git(['-C', repo, 'config', 'core.sshCommand'], LOCAL_GIT_MS).then(Boolean, () => false)
          ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }),
      };
      const heads = await p.git(['-C', repo, 'ls-remote', '--heads', 'origin', ...(base ? [base] : [])], REMOTE_GIT_MS, env);
      if (heads.trim()) return ok(`${name}: origin has ${base || 'branches'}`);
      return base
        ? fail(`${name}: origin has no ${base} branch`, `git -C ${sh} push -u origin ${base}`)
        : fail(`${name}: origin has no branches yet`, `git -C ${sh} push -u origin HEAD`);
    } catch (err) {
      return fail(`${name}: could not reach origin (${redact(firstLine(err.stderr || err.message))})`, `git -C ${sh} ls-remote origin`);
    }
  }))];
}

// Orphaned worktrees kept for nothing: clean, and every commit's content
// already on origin/<base> (squash-merged, rebased, or none at all). Older
// builds kept one per finished card as "unpushed". Report only: the Explorer's
// delete button removes one, and a restart releases an "unpushed" one whose
// card is finished. An orphan an open card may still re-adopt is left out. Local
// refs only, so a PR merged since the last fetch reads as kept; the squash
// test may leave git an unreferenced object or two, which gc removes.
export async function checkOrphans(p, board) {
  const orphans = board.orphans || [];
  if (!orphans.length) return [ok('no orphaned worktrees')];
  const open = (o) => board.jobs.some(j => j.repoPath === o.repoPath && j.branchName === o.branchName
    && (j.state === 'in-progress' || j.state === 'review'));
  const stale = (await Promise.all(orphans.map(async (o) => {
    if (open(o)) return null;
    if (!p.exists(o.worktreePath)) return { o, why: 'its folder is gone' };
    try {
      if ((await p.git(['-C', o.worktreePath, 'status', '--porcelain'], LOCAL_GIT_MS)).trim()) return null;
    } catch { return null; }
    const base = await p.baseBranch(o.repoPath).catch(() => null);
    const ahead = await Promise.resolve().then(() => p.commitsNotInBase(o)).catch(() => -1);
    return base && ahead === 0 ? { o, why: `its work is already on origin/${base}` } : null;
  }))).filter(Boolean);
  const kept = orphans.length - stale.length;
  const lines = stale.map(({ o, why }) => fail(
    `orphan ${o.name || o.branchName} (${tilde(o.worktreePath)}) is kept as "${o.reason || 'orphaned'}", but ${why}`,
    o.reason === 'unpushed'
      ? 'Delete it in the Explorer (the orphan\'s delete button), or restart Agent 007, which releases it'
      : 'Delete it in the Explorer (the orphan\'s delete button)',
  ));
  if (kept) lines.push(ok(`${kept} orphaned worktree${kept === 1 ? '' : 's'} kept: uncommitted files, work not on the base branch, or a card that may re-adopt it`));
  return lines;
}

// starting: another Agent 007 on the port is a problem, since this one cannot listen.
export async function checkPort(p, { starting = false } = {}) {
  const state = await p.portState(p.port, p.host);
  if (state === 'free') return [ok(`port ${p.port} is free`)];
  if (state === 'agent-007') {
    return [starting
      ? fail(`port ${p.port} is held by another Agent 007, already running`, `Open that one, or start this one with --port ${Number(p.port) + 1}`)
      : ok(`port ${p.port} is held by this Agent 007 (it is running)`)];
  }
  if (state === 'other') return [fail(`port ${p.port} is in use by another program`, `Stop it, or start Agent 007 with --port ${Number(p.port) + 1} (or PORT=)`)];
  return [fail(`cannot listen on ${p.host} port ${p.port} (${state})`, 'Pick another PORT (one over 1024), or a HOST this machine has')];
}

export function checkSettings(p, board) {
  const lines = p.settingsLine ? [ok(p.settingsLine)] : [];
  const where = tilde(p.configPath);
  if (board.missing) lines.push(na(`${where} not created yet (the first start makes it)`));
  else if (board.error) lines.push(fail(`${where} does not parse: ${board.error}`, `Fix the JSON in ${where}, or move it aside and restart (the board starts empty)`));
  else lines.push(ok(`${where} parses (${board.repos.length} repo${board.repos.length === 1 ? '' : 's'}, ${board.jobs.length} open card${board.jobs.length === 1 ? '' : 's'})`));
  return lines;
}

// VERSION is A.B.C.D; npm carries A.B.(C*1000+D) (CONTRIBUTING.md "Versions").
export const toNpm = (v) => { const [a, b, c, d = 0] = String(v).split('.').map(Number); return `${a}.${b}.${c * 1000 + d}`; };
export const fromNpm = (v) => { const [a, b, c] = String(v).split('.').map(Number); return `${a}.${b}.${Math.floor(c / 1000)}.${c % 1000}`; };

// Being behind is not a fault, so never ✗: the newer version is named.
export async function checkVersion(p) {
  const latest = await p.npmLatest();
  if (!latest) return [na(`version ${p.version} (npm not reachable, latest unknown)`)];
  return [ok(versionAtLeast(toNpm(p.version), latest)
    ? `version ${p.version}, the latest`
    : `version ${p.version}; ${fromNpm(latest)} is out (agent007 update, or npx ${PKG.name}@latest)`)];
}

export async function checkTelegram(p) {
  if (!(p.env.TELEGRAM_BOT_TOKEN || '').trim()) return [na('Telegram not configured')];
  const me = await p.telegramGetMe();
  if (!me) return [na('Telegram configured; api.telegram.org not reachable')];
  if (me.rejected) return [fail('Telegram rejects TELEGRAM_BOT_TOKEN', 'Copy the token again from @BotFather into ~/.agent-007/.env')];
  return [ok(`Telegram bot @${me.username} answers`)];
}

export function checkWhisper(p, { whisperSetupFn = whisperSetup } = {}) {
  const telegram = (p.env.TELEGRAM_BOT_TOKEN || '').trim();
  const setup = whisperSetupFn(p.env);
  const hasFFmpeg = p.which('ffmpeg');

  if (!telegram) {
    return [na('whisper.cpp (recommended): only used for Telegram voice notes (Telegram not set up)')];
  }

  if (setup.missing) {
    return [na(`whisper.cpp (recommended, not required): not set up; voice notes over Telegram get a 'not set up' reply; ${setup.missing}`)];
  }

  if (!hasFFmpeg) {
    return [na(`whisper.cpp (recommended): ${setup.bin}, model ${tilde(setup.model)}; ffmpeg not on PATH (brew install ffmpeg to enable transcription)`)];
  }

  return [ok(`whisper.cpp (recommended): ${setup.bin}, model ${tilde(setup.model)}; voice notes over Telegram are transcribed`)];
}

// Whether `child` is `dir` or inside it. path.relative, not a string prefix:
// on Windows it ignores case and takes / for \, as Claude Code's recorded
// projectPath may differ from WORKTREE_DIR in either. A sibling folder
// (worktrees-old) or another drive is outside.
export function insideDir(dir, child, api = path) {
  const rel = api.relative(api.resolve(dir), api.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

export function checkPlugins(p) {
  const file = join(p.claudeDir, 'plugins', 'installed_plugins.json');
  let plugins;
  try { plugins = JSON.parse(p.readFile(file))?.plugins || {}; } catch { return [na('no Claude Code plugin registrations')]; }
  const lines = [];
  for (const [name, entries] of Object.entries(plugins)) {
    for (const e of Array.isArray(entries) ? entries : []) {
      if (e?.scope !== 'local' || typeof e.projectPath !== 'string') continue;
      const gone = !p.exists(e.projectPath);
      if (!gone && !insideDir(p.worktreeDir, e.projectPath)) continue;
      // The uninstall applies to the folder it runs in, so a gone one comes back first.
      const where = shellPath(e.projectPath);
      lines.push(fail(`stray local plugin ${name} registered for ${tilde(e.projectPath)}${gone ? ' (folder no longer exists)' : ' (a board worktree)'}`,
        `${gone ? `mkdir -p ${where} && ` : ''}cd ${where} && claude plugin uninstall ${name} --scope local${gone ? ` && rmdir ${where}` : ''} (README "Troubleshooting")`));
    }
  }
  return lines.length ? lines : [ok('no stray local plugin registrations')];
}

// Extras the board's workers use but nothing needs: an info line each, never ✗.
// Add more here.
const RECOMMENDED = [{ cmd: 'agent-browser', why: 'board cards use it for screenshots of UI changes' }];

const RECOMMENDED_SKILLS = [{ skill: 'impeccable', why: 'UI design skill' }];

// Links in a skills folder whose target is gone, as [name, target].
function brokenLinks(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter(e => e.isSymbolicLink() && !existsSync(join(dir, e.name)))
    .map(e => [e.name, (() => { try { return readlinkSync(join(dir, e.name)); } catch { return '?'; } })()]);
}

// The ship skill (gstack's) is how a card that needs a pull request finishes.
export function checkSkills(p, board) {
  const lines = [];
  for (const cli of JOB_AGENTS.filter(c => c === 'claude' || c === 'codex')) {
    const uses = [
      p.billionRuns() && p.billionAgent() === cli && 'Billion runs on it',
      board.jobs.some(j => jobAgent(j) === cli && jobRequiresPr(j)) && 'a board card that needs a pull request uses it',
    ].filter(Boolean);
    const stack = join(p.claudeDir, 'skills', 'gstack');
    const fix = `install gstack (https://github.com/garrytan/gstack), then: ${shellPath(p.exists(stack) ? stack : join(p.claudeDir, 'skills', 'gstack'))}/setup --host ${cli}`;
    const found = skillDir(p, cli, 'ship');
    if (found) lines.push(ok(`gstack for ${cli}: ship skill at ${tilde(found)}`));
    else if (uses.length) lines.push(fail(`gstack for ${cli}: no working ship skill; ${uses.join(' and ')}`, fix));
    else lines.push(na(`gstack for ${cli}: no ship skill (nothing needs it)`));
    for (const dir of skillsDirs(p, cli)) {
      const broken = brokenLinks(dir);
      if (broken.length) lines.push(fail(`${broken.length} skill${broken.length === 1 ? '' : 's'} in ${tilde(dir)} ${broken.length === 1 ? 'is a broken link' : 'are broken links'} (e.g. ${broken[0][0]} → ${broken[0][1]})`, fix));
    }
  }
  // recommended: the report files these under their own heading.
  const rec = (l) => ({ ...l, recommended: true });
  for (const { skill, why } of RECOMMENDED_SKILLS) {
    for (const cli of ['claude', 'codex']) {
      const found = skillDir(p, cli, skill);
      lines.push(rec(found ? ok(`${skill} (recommended) for ${cli}: ${tilde(found)}; ${why}`) : na(`${skill} (recommended) for ${cli}: not installed; ${why}`)));
    }
  }
  for (const { cmd, why } of RECOMMENDED) lines.push(rec(p.which(cmd) ? ok(`${cmd} (recommended): installed; ${why}`) : na(`${cmd} (recommended): not installed; ${why}`)));
  return lines;
}

// The service `agent007 install` wrote, if any: its node and bin still
// there, and each CLI found here found on its baked-in PATH too (a service
// starts with none of the login shell's). Nothing when none is installed.
export function checkService(p) {
  const svc = p.service();
  if (!svc) return [];
  const { args: [node, bin], env } = parseServiceFile(svc.text);
  const fix = `${p.installCommand} (writes it again, with your login shell's PATH now)`;
  const lines = [];
  for (const [what, file] of [['node', node], ['Agent 007', bin]]) {
    if (!file || !p.exists(file)) lines.push(fail(`the service runs ${what} from ${file ? tilde(file) : 'nowhere'}, which is gone`, fix));
  }
  const missing = ['claude', 'codex', 'gh'].filter(cmd => p.which(cmd) && !p.whichIn(cmd, env.PATH || ''));
  for (const cmd of missing) lines.push(fail(`the service cannot find ${cmd}: ${tilde(p.which(cmd))} is not on its PATH`, fix));
  return lines.length ? lines : [ok(`service ${tilde(svc.file)} runs ${tilde(node)} and finds what this shell finds`)];
}

// A browser on `tailscale serve`'s https://<name>.ts.net sends that name as its
// Origin, which the server turns away unless ALLOWED_ORIGINS lists it. The
// service reads its own settings (its unit's env, then ~/.agent-007/.env), not
// this shell's ./.env, so with one installed those are what count.
export async function checkRemote(p) {
  const svc = p.service() && parseServiceFile(p.service().text);
  const fromFile = (file, key) => (p.exists(file) ? parseEnv(p.readFile(file))[key] : undefined);
  // A clone's service runs in the clone, so its ./.env counts too.
  const setting = (key) => (svc
    ? svc.env[key] ?? fromFile(join(dirname(dirname(svc.args[1] || '/')), '.env'), key) ?? fromFile(p.settingsFile, key)
    : p.env[key]);
  const proxy = await checkProxy(p, setting, Boolean(svc));
  const cfg = await p.tailscaleServe();
  if (!cfg) return proxy.length ? proxy : [na('Tailscale not found, or `tailscale serve status` failed, and no PUBLIC_URL: remote access not checked')];
  const { names, targets } = serveTargets(cfg, p.port);
  if (!names.size) {
    return proxy.length ? proxy : [targets.length
      ? fail(`tailscale serve does not proxy port ${p.port} (it serves: ${targets.join(', ')})`, `Point it here: tailscale serve --bg ${p.port}`)
      : na(`tailscale serve does not proxy port ${p.port} (it serves nothing), and no PUBLIC_URL: remote access is off`)];
  }
  const origins = setting('ALLOWED_ORIGINS');
  const allowed = (origins || '').split(',').map(o => o.trim()).filter(Boolean).map(o => (o === '*' ? o : originHost(o)));
  const shown = origins ? [na(`ALLOWED_ORIGINS${svc ? ' (as the service reads it)' : ''}: ${origins}`)] : [];
  return [...names].map(name => (allowed.includes('*') || allowed.includes(originHost(name))
    ? ok(`tailscale serve sends https://${name} to port ${p.port}, and ALLOWED_ORIGINS lets it in`)
    : fail(`tailscale serve sends https://${name} to port ${p.port}, but ALLOWED_ORIGINS${svc ? ' (as the service reads it)' : ''} does not list ${originHost(name)}: remote browsers are turned away`,
      `Add ALLOWED_ORIGINS=${[origins, originHost(name)].filter(Boolean).join(',')} to ${tilde(p.settingsFile)}, then ${svc ? p.installCommand.replace(/install$/, 'restart') : 'restart Agent 007'}`))).concat(shown, proxy);
}

// Reverse-proxy mode (PUBLIC_URL, docs/REMOTE.md): the address, the port kept
// off the network, and whether the running server has had a request through
// the proxy. Nothing when PUBLIC_URL is unset.
async function checkProxy(p, setting, svc) {
  const raw = setting('PUBLIC_URL');
  if (!raw?.trim()) return [];
  const where = svc ? ' (as the service reads it)' : '';
  const url = parsePublicUrl(raw);
  if (!url) return [fail(`PUBLIC_URL${where}=${raw} is not an http(s) URL, so the server ignores it`, `Set PUBLIC_URL=https://<your proxy's hostname> in ${tilde(p.settingsFile)}`)];
  const host = setting('HOST') || '127.0.0.1';
  const lines = [
    url.startsWith('https:')
      ? ok(`remote access: reverse proxy at ${url} (PUBLIC_URL${where})`)
      : fail(`remote access: reverse proxy at ${url}, which is not https: browsers keep the microphone (voice, Talk) to https and localhost`, 'Terminate https at the proxy and set PUBLIC_URL to the https address'),
  ];
  if (WILDCARD_BIND_HOSTS.includes(host)) lines.push(fail(`HOST=${host}: port ${p.port} is reachable without going through the proxy, which is what signs people in`, `Set HOST=127.0.0.1 (or the WireGuard address) in ${tilde(p.settingsFile)}`));
  const s = await p.serverStatus?.();
  if (!s) lines.push(na('Agent 007 is not running here: proxy headers not checked'));
  else if (s.publicUrl !== url) lines.push(fail(`the running server has PUBLIC_URL ${s.publicUrl || 'unset'}, not ${url}`, svc ? p.installCommand.replace(/install$/, 'restart') : 'Restart Agent 007'));
  else if (!s.proxy) lines.push(na(`no request has come through the proxy since the server started: open ${url}, then run doctor again`));
  else if (s.proxy.proto !== 'https') lines.push(fail(`the proxy forwards requests as ${s.proxy.proto}, not https (X-Forwarded-Proto)`, 'Have the proxy send X-Forwarded-Proto: https (cloudflared and caddy do by default)'));
  else lines.push(ok(remoteLines(s, Date.now())[1].trim()));
  return lines;
}

// --- Running them ---

// The headings of the report, in the order they print. Every check below names
// one; a check's lines all land under it.
export const SECTIONS = ['System', 'Agents', 'GitHub', 'Repos', 'Skills', 'Settings & service', 'Telegram & voice', 'Recommended'];

// Each check, grouped in SECTIONS order. fast: the subset a start runs, none
// of which talks to the network.
function checks(fast) {
  const all = [
    { title: 'Node', section: 'System', run: (c) => checkNode(c.p) },
    // checkRepos leads with the git line (System); Repos below keeps the rest,
    // and none when git is missing (that line is the only one).
    { title: 'Git', section: 'System', run: async (c) => (await checkRepos(c.p, { repos: [], jobs: [] }, c.origin, c.account)).slice(0, 1) },
    { title: 'Port', section: 'System', run: (c) => checkPort(c.p, { starting: fast }) },
    { title: 'Agent CLIs', section: 'Agents', run: (c) => checkClis(c.p, c.board) },
    { title: 'GitHub', section: 'GitHub', run: (c) => checkGh(c.p, c.board, c.origin, { fast, account: c.account }) },
    { title: 'Repos', section: 'Repos', slow: true, run: async (c) => (await checkRepos(c.p, c.board, c.origin, c.account)).slice(1) },
    { title: 'Stale orphans', section: 'Repos', slow: true, run: (c) => checkOrphans(c.p, c.board) },
    { title: 'Skills', section: 'Skills', run: (c) => checkSkills(c.p, c.board).filter(l => !l.recommended) },
    { title: 'Plugins', section: 'Skills', slow: true, run: (c) => checkPlugins(c.p) },
    { title: 'Settings', section: 'Settings & service', run: (c) => checkSettings(c.p, c.board) },
    { title: 'Service', section: 'Settings & service', run: (c) => checkService(c.p) },
    { title: 'Remote access', section: 'Settings & service', slow: true, run: (c) => checkRemote(c.p) },
    { title: 'Version', section: 'Settings & service', slow: true, run: (c) => checkVersion(c.p) },
    { title: 'Telegram', section: 'Telegram & voice', slow: true, run: (c) => checkTelegram(c.p) },
    { title: 'Whisper', section: 'Telegram & voice', slow: true, run: (c) => checkWhisper(c.p) },
    { title: 'Recommended', section: 'Recommended', run: (c) => checkSkills(c.p, c.board).filter(l => l.recommended) },
  ];
  return fast ? all.filter(c => !c.slow) : all;
}

// [{ title, section, lines }] in SECTIONS order. All checks start at once;
// onSection({ heading, results }) is called for each section, in order, as
// soon as it and every section before it is done, so a slow check holds back
// only what prints after it. budgetMs: a check not done by then is dropped
// without a word (the start never waits on one); a check that throws says so
// as one ✗.
export async function runDoctor({ probes, fast = false, budgetMs = Infinity, onSection } = {}) {
  // The budget runs from here, so reading config.json counts against it too.
  let timer;
  const late = Number.isFinite(budgetMs) ? new Promise(r => { timer = setTimeout(() => r(null), budgetMs); }) : null;
  const p = probes || defaultProbes();
  const c = { p, board: readBoard(p), origin: originOf(p, new Map()), account: accountOf(p, new Map()) };
  const started = checks(fast).map(({ title, section, run }) => {
    const done = Promise.resolve().then(() => run(c)).catch(err => [fail(`${title} check failed: ${redact(firstLine(err?.message))}`)]);
    return (late ? Promise.race([done, late]) : done).then(lines => lines && { title, section, lines });
  });
  const results = [];
  for (const heading of SECTIONS) {
    const idx = checks(fast).flatMap((k, i) => k.section === heading ? [i] : []);
    const here = (await Promise.all(idx.map(i => started[i]))).filter(r => r && r.lines.length);
    results.push(...here);
    if (here.length) onSection?.({ heading, results: here });
  }
  clearTimeout(timer);
  return results;
}

export const failed = (results) => results.some(r => r.lines.some(l => l.status === 'fail'));

// Color only on a terminal, unless told otherwise: FORCE_COLOR (not 0/false)
// turns it on anywhere, else NO_COLOR (any value) turns it off. Plain ANSI:
// util.styleText strips codes by the stream's own idea of color on newer Nodes.
export function useColor(stream = process.stdout, env = process.env) {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return !['0', 'false'].includes(env.FORCE_COLOR);
  if (env.NO_COLOR) return false;
  return Boolean(stream?.isTTY);
}

const paint = (on, code, s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

// One check line, the fix indented under a ✗. ✓ colors its mark, ✗ the whole
// line and its fix, – the whole line, dim.
function formatLine(l, color) {
  const text = `${MARKS[l.status]} ${l.text}`;
  if (l.status === 'ok') return [`${paint(color, 32, MARKS.ok)} ${l.text}`];
  if (l.status === 'na') return [paint(color, 2, text)];
  return [paint(color, 31, text), ...(l.fix ? [paint(color, 31, `    fix: ${l.fix}`)] : [])];
}

// A section as printed: bold heading, its lines, a blank line after.
export function formatSection({ heading, results }, { color = false } = {}) {
  return `${[paint(color, 1, heading), ...results.flatMap(r => r.lines.flatMap(l => formatLine(l, color)))].join('\n')}\n\n`;
}

// "All good", or the counts: a problem is a ✗, a note a –.
export function formatSummary(results, { color = false } = {}) {
  const lines = results.flatMap(r => r.lines);
  const problems = lines.filter(l => l.status === 'fail').length;
  const notes = lines.filter(l => l.status === 'na').length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!problems && !notes) return paint(color, 32, 'All good');
  if (!problems) return paint(color, 32, `All good, ${plural(notes, 'note')}`);
  return paint(color, 31, `${plural(problems, 'problem')}, ${plural(notes, 'note')}`);
}

// The `doctor` report in one piece (what runDoctor streams, joined).
export function formatReport(results, opts = {}) {
  const sections = SECTIONS.map(heading => ({ heading, results: results.filter(r => r.section === heading) })).filter(s => s.results.length);
  return `${sections.map(s => formatSection(s, opts)).join('')}${formatSummary(results, opts)}`;
}

// What a start prints: only the ✗ lines, or nothing at all.
export function formatStartup(results, doctorCommand, { color = false } = {}) {
  const bad = results.flatMap(r => r.lines).filter(l => l.status === 'fail');
  if (!bad.length) return '';
  return [...bad.flatMap(l => [`  ${paint(color, 31, MARKS.fail)} ${l.text}`, ...(l.fix ? [`      ${l.fix}`] : [])]),
    `  Run \`${doctorCommand}\` for details.`].join('\n');
}
