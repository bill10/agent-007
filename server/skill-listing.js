// The skill listing this machine's Claude Code actually sends, for the
// "built-in" skill family (server/skill-families.js). Claude Code's bundled
// skills live in its binary and vary by version, so instead of a fixed list
// Agent 007 asks Claude Code itself: `claude -p` runs once against a stand-in
// API on 127.0.0.1, which keeps the first request's body, reads the listing
// out of it and answers with a minimal message. Nothing reaches Anthropic, no
// usage is spent, and request headers (where a credential would be) are never
// read, kept or logged. The result is cached in Agent 007's data dir by
// `claude --version`, so it is probed again only when Claude Code changes.
import { createServer } from 'http';
import { execFile, spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONFIG_DIR } from './state.js';
import { resolveExecutable } from './command-path.js';
import { ptyEnv } from '../lib/helpers.js';
import { installedPlugins } from './skill-families.js';

export const LISTING_FILE = join(CONFIG_DIR, 'skill-listing.json');
const PROBE_TIMEOUT_MS = 20_000;
const MARKER = 'The following skills are available for use with the Skill tool:';

// [{ name, description }] from a captured /v1/messages request body (a
// string), or null when it holds no skill listing. An entry is "- name: text"
// or a bare "- name"; a description's later lines belong to it.
export function parseListing(body) {
  let request;
  try { request = JSON.parse(body); } catch { return null; }
  const texts = [request?.system, ...(Array.isArray(request?.messages) ? request.messages.map(m => m?.content) : [])]
    .flatMap(c => typeof c === 'string' ? [c] : Array.isArray(c) ? c.map(p => p?.text) : [])
    .filter(t => typeof t === 'string');
  const text = texts.find(t => t.includes(MARKER));
  if (!text) return null;
  const block = text.slice(text.indexOf(MARKER) + MARKER.length).replace(/^\s*\n/, '').split(/\n\s*\n/)[0];
  const skills = [];
  for (const line of block.split('\n')) {
    const entry = /^- ([^\s:]+(?::[^\s:]+)?)(?::(?: (.*))?)?$/.exec(line);
    if (entry) skills.push({ name: entry[1], description: entry[2] || '' });
    else if (skills.length) skills.at(-1).description += ` ${line.trim()}`;
  }
  return skills.length ? skills : null;
}

const MESSAGE = JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

// Runs `claude -p` against the stand-in API and resolves its listing, or
// rejects with why not.
export function probeListing({ file = 'claude', env = process.env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'a007-skill-probe-'));   // no project skills in it
    let child = null;
    let timer = null;
    let settled = false;
    const done = (err, skills) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* gone */ }
      server.close();
      server.closeAllConnections?.();
      // Not at once on Windows, where the just-killed child may still hold it.
      setTimeout(() => { try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left in tmp */ } }, 0).unref?.();
      if (err) reject(err); else resolve(skills);
    };
    // Only the body is read: the headers, with whatever key Claude Code sends, are never touched.
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(MESSAGE);
        const skills = parseListing(Buffer.concat(chunks).toString('utf8'));
        if (skills) done(null, skills);
      });
    });
    server.on('error', err => done(err));
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      // In --settings too, which outranks an env block in the owner's settings.
      // A dummy key, and no Bedrock/Vertex/Foundry route, so the request can go nowhere else.
      const pinned = { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'agent-007-skill-probe', ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
      const childEnv = { ...ptyEnv(env), ...pinned, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete childEnv[key];
      // No hooks, MCP servers or plugins of the owner's (plugin skills are never
      // built-in), no transcript or memory folder left in ~/.claude/projects,
      // and every description in full.
      const enabledPlugins = Object.fromEntries([...installedPlugins()].map(id => [id, false]));
      const settings = JSON.stringify({ env: pinned, disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins, skillListingBudgetFraction: 1 });
      // ponytail: a Windows .cmd shim runs through cmd.exe, which can mangle the JSON;
      // the probe then fails and that machine simply has no built-in family.
      const win = process.platform === 'win32';
      const exe = resolveExecutable(file, env) || file;
      try {
        child = spawn(win ? `"${exe}"` : exe, ['-p', 'hi', '--strict-mcp-config', '--no-session-persistence', '--settings', settings],
          { cwd, env: childEnv, stdio: 'ignore', shell: win, windowsHide: true });
      } catch (err) { done(new Error(`could not start claude: ${err.message}`)); return; }
      child.on('error', err => done(new Error(err.code === 'ENOENT' ? 'claude is not installed' : `could not start claude: ${err.message}`)));
      child.on('exit', code => done(new Error(`claude exited (${code}) without sending a skill listing`)));
      timer = setTimeout(() => done(new Error(`claude sent no skill listing within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    });
  });
}

export function claudeVersion({ file = 'claude', env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const exe = resolveExecutable(file, env) || file;
    execFile(win ? `"${exe}"` : exe, ['--version'], { env: ptyEnv(env), timeout: 10_000, shell: win, windowsHide: true }, (err, stdout) => {
      const version = String(stdout || '').trim();
      if (err || !version) reject(new Error(err?.code === 'ENOENT' ? 'claude is not installed' : `claude --version failed${err ? `: ${err.message}` : ''}`));
      else resolve(version);
    });
  });
}

const readCache = (file) => {
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    return typeof cached?.version === 'string' && Array.isArray(cached.skills) ? cached : null;
  } catch { return null; }
};

// { version, skills } once probed, { version?, error } when the probe failed,
// null before the first refresh (the cache, until then).
let state;
let pending = null;
export function currentListing(file = LISTING_FILE) {
  if (state === undefined) state = readCache(file);
  return state;
}

// Probe when the installed version has none cached; a failure is not retried
// until the version changes (or the server restarts). One at a time.
export function refreshListing({ file = LISTING_FILE, version = claudeVersion, probe = probeListing } = {}) {
  if (pending) return pending;
  pending = (async () => {
    let v;
    try { v = await version(); } catch (err) { return (state = { error: err.message }); }
    if (state?.version === v) return state;
    const cached = readCache(file);
    if (cached?.version === v) return (state = cached);
    try {
      const skills = await probe();
      state = { version: v, skills };
      try { writeFileSync(file, JSON.stringify(state)); } catch { /* probed again next start */ }
    } catch (err) { state = { version: v, error: err.message }; }
    return state;
  })().finally(() => { pending = null; });
  return pending;
}
