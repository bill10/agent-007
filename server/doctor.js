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

import { existsSync, readFileSync } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { CONFIG_PATH, WORKTREE_DIR, PORT, HOST, WILDCARD_BIND_HOSTS } from './state.js';
import { refreshAgentAccounts } from './agent-accounts.js';
import { commandPath, INSTALL_HINTS } from './command-path.js';
import { billionAgent, billionRuns } from './billion.js';
import { ghAccounts, ghAccountFor, ghAgentEnv, parseGithubRemote } from './jobs.js';
import { telegramGetMe } from './owner.js';
import { gitExec, resolveBaseBranch } from './git.js';
import { tilde } from './settings.js';
import { jobAgent, JOB_AGENTS } from '../lib/jobs.js';

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
async function npmLatest() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG.name.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(NET_MS) });
    return res.ok ? (await res.json())?.version || null : null;
  } catch { return null; }
}

export function defaultProbes({ env = process.env, settingsLine = null } = {}) {
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
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    port: PORT,
    host: HOST,
    portState,
    configPath: CONFIG_PATH,
    worktreeDir: WORKTREE_DIR,
    claudeDir: env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'),
    settingsLine,
    npmLatest,
    telegramGetMe: () => telegramGetMe(env),
  };
}

// --- What is on the board, read straight from config.json (never loadConfig,
// which rewrites in-progress jobs as a restart would) ---

function readBoard(p) {
  if (!p.exists(p.configPath)) return { missing: true, repos: [], jobs: [] };
  try {
    const c = JSON.parse(p.readFile(p.configPath));
    const jobs = (Array.isArray(c.jobs) ? c.jobs : []).filter(j => j && j.state !== 'done');
    const repos = [...new Set([
      ...(Array.isArray(c.repos) ? c.repos : []).map(r => r?.path),
      ...jobs.map(j => j.repoPath),
    ].filter(r => typeof r === 'string' && r))];
    return { repos, jobs };
  } catch (err) {
    return { error: firstLine(err.message), repos: [], jobs: [] };
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
    if (account?.loggedIn === null) return ok(`${where}, login not known`);
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
  const accounts = await p.ghAccounts();
  if (!accounts.length) return [fail('gh is installed but signed in to no account', 'gh auth login')];
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
    if (!p.exists(repo)) return fail(`${name} does not exist`, 'Remove it from the Explorer, or put the repo back at that path');
    try { await p.git(['-C', repo, 'rev-parse', '--git-dir'], LOCAL_GIT_MS); } catch {
      return fail(`${name} is not a git repository`, `git -C ${name} status`);
    }
    if (!await origin(repo)) return fail(`${name} has no origin remote`, `git -C ${name} remote add origin <url>`);
    const base = (await p.baseBranch(repo).catch(() => null)) || 'main';
    try {
      const env = parseGithubRemote(await origin(repo)) && p.which('gh') ? p.repoEnv(await account(repo)) : {};
      const heads = await p.git(['-C', repo, 'ls-remote', '--heads', 'origin', base], REMOTE_GIT_MS, env);
      return heads.trim()
        ? ok(`${name}: origin has ${base}`)
        : fail(`${name}: origin has no ${base} branch`, `git -C ${name} push -u origin ${base}`);
    } catch (err) {
      return fail(`${name}: could not reach origin (${redact(firstLine(err.stderr || err.message))})`, `git -C ${name} ls-remote origin`);
    }
  }))];
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
    : `version ${p.version}; ${fromNpm(latest)} is out (npx ${PKG.name}@latest, or git pull in a clone)`)];
}

export async function checkTelegram(p) {
  if (!(p.env.TELEGRAM_BOT_TOKEN || '').trim()) return [na('Telegram not configured')];
  const me = await p.telegramGetMe();
  if (!me) return [na('Telegram configured; api.telegram.org not reachable')];
  if (me.rejected) return [fail('Telegram rejects TELEGRAM_BOT_TOKEN', 'Copy the token again from @BotFather into ~/.agent-007/.env')];
  return [ok(`Telegram bot @${me.username} answers`)];
}

export function checkPlugins(p) {
  const file = join(p.claudeDir, 'plugins', 'installed_plugins.json');
  let plugins;
  try { plugins = JSON.parse(p.readFile(file))?.plugins || {}; } catch { return [na('no Claude Code plugin registrations')]; }
  const inside = (dir, path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const lines = [];
  for (const [name, entries] of Object.entries(plugins)) {
    for (const e of Array.isArray(entries) ? entries : []) {
      if (e?.scope !== 'local' || typeof e.projectPath !== 'string') continue;
      const gone = !p.exists(e.projectPath);
      if (!gone && !inside(p.worktreeDir, e.projectPath)) continue;
      // The uninstall applies to the folder it runs in, so a gone one comes back first.
      const where = tilde(e.projectPath);
      lines.push(fail(`stray local plugin ${name} registered for ${where}${gone ? ' (folder no longer exists)' : ' (a board worktree)'}`,
        `${gone ? `mkdir -p ${where} && ` : ''}cd ${where} && claude plugin uninstall ${name} --scope local${gone ? ` && rmdir ${where}` : ''} (README "Troubleshooting")`));
    }
  }
  return lines.length ? lines : [ok('no stray local plugin registrations')];
}

// --- Running them ---

// Each check, in order, as [title, run(ctx)]. fast: the subset a start runs,
// none of which talks to the network.
function checks(fast) {
  const all = [
    ['Node', (c) => checkNode(c.p)],
    ['Agent CLIs', (c) => checkClis(c.p, c.board)],
    ['GitHub', (c) => checkGh(c.p, c.board, c.origin, { fast, account: c.account })],
    ['Repos', (c) => checkRepos(c.p, c.board, c.origin, c.account), 'slow'],
    ['Port', (c) => checkPort(c.p, { starting: fast })],
    ['Settings', (c) => checkSettings(c.p, c.board)],
    ['Version', (c) => checkVersion(c.p), 'slow'],
    ['Telegram', (c) => checkTelegram(c.p), 'slow'],
    ['Plugins', (c) => checkPlugins(c.p), 'slow'],
  ];
  return fast ? all.filter(c => !c[2]) : all;
}

// [{ title, lines }] in check order. budgetMs: a check not done by then is
// dropped without a word (the start never waits on one); a check that throws
// says so as one ✗.
export async function runDoctor({ probes, fast = false, budgetMs = Infinity } = {}) {
  const p = probes || defaultProbes();
  const c = { p, board: readBoard(p), origin: originOf(p, new Map()), account: accountOf(p, new Map()) };
  let timer;
  const late = Number.isFinite(budgetMs) ? new Promise(r => { timer = setTimeout(() => r(null), budgetMs); }) : null;
  const results = await Promise.all(checks(fast).map(async ([title, check]) => {
    const done = Promise.resolve().then(() => check(c)).catch(err => [fail(`${title} check failed: ${redact(firstLine(err?.message))}`)]);
    const lines = await (late ? Promise.race([done, late]) : done);
    return lines && { title, lines };
  }));
  clearTimeout(timer);
  return results.filter(Boolean);
}

export const failed = (results) => results.some(r => r.lines.some(l => l.status === 'fail'));

// The `doctor` report: one line per check, a fix under each ✗.
export function formatReport(results) {
  return results.flatMap(({ lines }) => lines.flatMap(l => [
    `${MARKS[l.status]} ${l.text}`,
    ...(l.status === 'fail' && l.fix ? [`    fix: ${l.fix}`] : []),
  ])).join('\n');
}

// What a start prints: only the ✗ lines, or nothing at all.
export function formatStartup(results, doctorCommand) {
  const bad = results.flatMap(r => r.lines).filter(l => l.status === 'fail');
  if (!bad.length) return '';
  return [...bad.flatMap(l => [`  ${MARKS.fail} ${l.text}`, ...(l.fix ? [`      ${l.fix}`] : [])]),
    `  Run \`${doctorCommand}\` for details.`].join('\n');
}
