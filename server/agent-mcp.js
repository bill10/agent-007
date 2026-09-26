// Handing a spawned agent the board's MCP tool.
//
// Three pieces: where the board is reachable, a per-session MCP config file,
// and the flags that connect Claude Code and Codex to it. Separate from pty.js so it can be
// tested without importing node-pty.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { fileURLToPath } from 'url';
import { PORT, HOST, WILDCARD_BIND_HOSTS } from './state.js';

// Alongside config.json and users.json rather than in the worktree: a config
// file dropped into the repo the agent is working in would show up in
// `git status` and eventually in somebody's commit.
//
// Keyed by port, which is what makes sweepMcpConfigs() safe. Two Agent 007
// servers on one machine necessarily hold different ports, so a boot-time sweep
// of this directory can only ever delete files from a previous run of THIS
// instance — never a live file belonging to one running alongside it.
export const MCP_CONFIG_DIR = process.env.AGENT007_MCP_DIR
  || join(homedir(), '.agent-007', 'mcp', String(PORT));

// The server name the agent sees. Tools are namespaced by it
// (mcp__agent-007-board__post_job), so it must not collide with a server the
// user has configured themselves — `--mcp-config` merges with their own setup
// rather than replacing it, which is the whole reason we do not pass
// --strict-mcp-config (that would take away their MCP servers inside every
// agent this app spawns).
export const MCP_SERVER_NAME = 'agent-007-board';

// How long a worker's permission request waits for Billion (server/approvals.js),
// and the two limits that must outlast it so the server, answering "no
// decision", always gives up first: a CLI that times its hook out counts that
// as a deny. The hook script's own wait, then the CLI's timeout for the hook.
export const APPROVAL_WAIT_MS = 120_000;
export const HOOK_WAIT_MS = APPROVAL_WAIT_MS + 20_000;
export const HOOK_TIMEOUT_S = (APPROVAL_WAIT_MS + 30_000) / 1000;
// read_approval returns a request's whole input up to this many bytes of
// quoted UTF-8; past it the request stays owner-only on allow
// (server/approvals.js). Bytes, not characters: a token is at least a byte,
// so this stays under Claude Code's MCP output cap (25k tokens by default)
// whatever the text is. A result the CLI truncated would still count as seen.
export const READ_APPROVAL_BYTES = 20 * 1024;

// Agents run on this machine, so the board is reachable over loopback — which
// also keeps the token off the network when HOST is a tailnet address. A
// non-wildcard bind is the one case where loopback may not be listening, so use
// the bind address itself there.
export function boardBaseUrl() {
  const host = WILDCARD_BIND_HOSTS.includes(HOST) ? '127.0.0.1' : HOST;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketed}:${PORT}`;
}

export function mcpConfigPath(sessionId) {
  return join(MCP_CONFIG_DIR, `${sessionId}.json`);
}

export function mcpConfigBody(agentToken) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: `${boardBaseUrl()}/mcp`,
        // The token rides in a header, not in the agent's environment. An env
        // var is inherited by every child process the agent starts — a test
        // run, an install script in a repo under review — and any of them could
        // read it. A 0600 file that only the MCP client opens at startup is a
        // meaningfully smaller blast radius.
        headers: { Authorization: `Bearer ${agentToken}` },
      },
    },
  };
}

// Written before the spawn, removed when the PTY exits. Returns the path, or
// null if it could not be written — in which case the agent simply spawns
// without the tool, which is a missing convenience and not a failed spawn.
export function writeMcpConfig(sessionId, agentToken) {
  try {
    mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const path = mcpConfigPath(sessionId);
    writeFileSync(path, JSON.stringify(mcpConfigBody(agentToken), null, 2), { mode: 0o600 });
    // writeFileSync's mode is masked by umask and ignored entirely if the file
    // already existed, so set it explicitly: this file holds a live credential.
    chmodSync(path, 0o600);
    return path;
  } catch (err) {
    console.error(`Could not write the MCP config for session ${sessionId}:`, err.message);
    return null;
  }
}

// The --settings that routes a Claude Code worker's permission dialogs to
// Billion (server/approvals.js): a PermissionRequest hook running
// server/permission-hook.js with this session's MCP config. Claude Code only;
// Codex takes its hook differently and is not wired yet (docs/BILLION.md).
const PERMISSION_HOOK = fileURLToPath(new URL('./permission-hook.js', import.meta.url));
// The two board tools the job prompt tells a worker on Billion's card to use:
// finishing its card, and asking Billion. Asking permission for those would
// only send Billion (or the owner) a request to approve its own instructions.
export const WORKER_BOARD_TOOLS = ['finish_job', 'send_message'];
const shellQuote = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
// Forward slashes on Windows, which node takes as well: a backslash means
// something different to each shell a hook might run under (doubled by the
// quoting above, cmd.exe would read two), so the paths carry none.
export const hookPath = (p, platform = process.platform) => (platform === 'win32' ? String(p).replace(/\\/g, '/') : String(p));
export function withApprovalHook(file, args, configPath) {
  if (!configPath || agentName(file) !== 'claude' || args.includes('--settings')) return args;
  const settings = {
    permissions: { allow: WORKER_BOARD_TOOLS.map(tool => `mcp__${MCP_SERVER_NAME}__${tool}`) },
    hooks: {
      PermissionRequest: [{
        matcher: '*',
        hooks: [{ type: 'command', command: [process.execPath, PERMISSION_HOOK, configPath].map(p => shellQuote(hookPath(p))).join(' '), timeout: HOOK_TIMEOUT_S }],
      }],
    },
  };
  return ['--settings', JSON.stringify(settings), ...args];
}

// The Codex side of the same pre-allow: per-run -c overrides, one separate argv
// element each, so ~/.codex/config.toml is never touched. Only these tools;
// everything else on the server keeps Codex's default (ask). Must come after
// withMcpConfig's server table on the command line, which replaces the table.
export function withCodexWorkerTools(file, args, configPath) {
  if (!configPath || agentName(file) !== 'codex') return args;
  return [
    ...WORKER_BOARD_TOOLS.flatMap(tool => ['-c', `mcp_servers.${MCP_SERVER_NAME}.tools.${tool}.approval_mode="approve"`]),
    ...args,
  ];
}

export function removeMcpConfig(sessionId) {
  try {
    rmSync(mcpConfigPath(sessionId), { force: true });
  } catch (err) {
    console.error(`Could not remove the MCP config for session ${sessionId}:`, err.message);
  }
}

// Called once at boot. Files are normally removed when their PTY exits, but a
// crash or a plain restart kills every agent without that handler running, so
// each previous run leaves its credentials behind and they accumulate for ever.
// They are dead credentials — resolveAgentToken only honours a token belonging
// to a live session — but a directory of files that LOOK like live tokens is
// not something to leave lying around.
//
// Safe because no session exists yet at boot, and because the directory is
// per-port: it cannot contain a file belonging to another running instance.
export function sweepMcpConfigs() {
  try {
    rmSync(MCP_CONFIG_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error('Could not clear stale MCP configs:', err.message);
  }
}

// Claude reads the JSON config directly; Codex launches a stdio bridge with
// per-invocation TOML overrides. Neither changes the user's persistent config.
const WINDOWS_EXEC_EXT = /\.(cmd|exe|bat|ps1)$/i;

function agentName(file) {
  return basename(String(file || '')).replace(WINDOWS_EXEC_EXT, '');
}

export function takesMcpConfig(file) {
  return ['claude', 'codex'].includes(agentName(file));
}

const CODEX_BRIDGE = fileURLToPath(new URL('./agent-mcp-bridge.js', import.meta.url));

/**
 * Insert the agent-specific board MCP options into an already-parsed argv.
 *
 * Works on argv rather than on the command string: the string is what the user
 * typed and what the UI displays, and threading a path through quoting rules
 * that parseCommand then has to unpick is a bug waiting to happen.
 *
 * Placed immediately after the binary rather than appended, so it cannot end up
 * trailing a positional prompt argument. (Claude Code does accept flags after a
 * positional, but this way the question never arises.)
 */
export function withMcpConfig(file, args, configPath) {
  if (!configPath || !takesMcpConfig(file)) return args;
  if (agentName(file) === 'codex') {
    // JSON strings/arrays are also valid TOML here, including Windows paths.
    // Only this server's table is overridden; other MCP servers remain intact.
    const server = `mcp_servers.${MCP_SERVER_NAME}`;
    return [
      '-c', `${server}={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([CODEX_BRIDGE, configPath])},enabled=true}`,
      ...args,
    ];
  }
  // The user may have passed their own. The flag is variadic (`<configs...>`),
  // so a second occurrence is ambiguous — extend theirs instead of adding one.
  const existing = args.indexOf('--mcp-config');
  if (existing !== -1) {
    return [...args.slice(0, existing + 1), configPath, ...args.slice(existing + 1)];
  }
  return ['--mcp-config', configPath, ...args];
}
