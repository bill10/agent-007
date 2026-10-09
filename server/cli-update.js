// Settings' agent CLI versions (GET/POST /api/cli-updates): the installed
// claude and codex next to npm's latest, and Update, which runs the CLI's own
// `<cli> update`. Each CLI knows how it was installed (npm, Homebrew, its
// native build), so Agent 007 never guesses the install command. Agents
// already running keep the old binary until their next Restart.
//
// Codex's own in-terminal update prompt is off for every agent Agent 007
// starts (server/pty.js CODEX_NO_UPDATE_ARGS); this is where that update went.

import { execFile as nodeExecFile } from 'child_process';

export const CLI_PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
const LATEST_MS = 10 * 60_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;

const latestCache = new Map(); // cli -> { at, version }
const runs = new Map(); // cli -> { done, code, log }

export function resetCliUpdates() { latestCache.clear(); runs.clear(); }

// "2.1.295 (Claude Code)" and "codex-cli 0.157.0" both to "x.y.z".
export const versionOf = (text) => String(text || '').match(/\d+\.\d+\.\d+/)?.[0] || null;

async function npmVersion(pkg) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? (await res.json())?.version || null : null;
  } catch { return null; }
}

// Per installed CLI: { version, latest, updating?, finished?: { code, log } }.
export async function cliUpdates(agents, { fetchLatest = npmVersion, now = Date.now() } = {}) {
  const out = {};
  await Promise.all(Object.keys(CLI_PACKAGES).map(async (cli) => {
    const a = agents.find(x => x.cli === cli);
    if (!a) return;
    let c = latestCache.get(cli);
    if (!c || now - c.at > LATEST_MS) {
      c = { at: now, version: await fetchLatest(CLI_PACKAGES[cli]) };
      latestCache.set(cli, c);
    }
    const run = runs.get(cli);
    out[cli] = {
      version: versionOf(a.version), latest: c.version,
      ...(run && !run.done ? { updating: true } : {}),
      ...(run?.done ? { finished: { code: run.code, log: run.log } } : {}),
    };
  }));
  return out;
}

// { ok } once `<cli> update` is running, or { error }. One per CLI at a time.
export function startCliUpdate(cli, agents, { execFile = nodeExecFile, env = process.env } = {}) {
  if (!Object.hasOwn(CLI_PACKAGES, cli)) return { error: `Unknown CLI: ${String(cli).slice(0, 40)}` };
  const path = agents.find(a => a.cli === cli)?.path;
  if (!path) return { error: `${cli} is not installed.` };
  if (runs.get(cli)?.done === false) return { error: `${cli} is already updating.` };
  const run = { done: false, code: null, log: '' };
  runs.set(cli, run);
  const child = execFile(path, ['update'], { timeout: UPDATE_TIMEOUT_MS, env }, (err, stdout = '', stderr = '') => {
    run.done = true;
    run.code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
    run.log = `${stdout}\n${stderr}`.trim().split('\n').slice(-8).join('\n') || (err ? err.message : '');
    latestCache.delete(cli);
  });
  child?.stdin?.end();   // nothing to answer a prompt with: it fails rather than hangs
  return { ok: true };
}
