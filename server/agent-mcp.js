// Handing a spawned agent the board's MCP tool.
//
// Three pieces: where the board is reachable, a per-session MCP config file,
// and the flags that point `claude` at it. Separate from pty.js so it can be
// tested without importing node-pty.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { PORT, HOST, WILDCARD_BIND_HOSTS } from './state.js';

// Alongside config.json and users.json rather than in the worktree: a config
// file dropped into the repo the agent is working in would show up in
// `git status` and eventually in somebody's commit.
export const MCP_CONFIG_DIR = process.env.AGENT007_MCP_DIR
  || join(homedir(), '.agent-007', 'mcp');

// The server name the agent sees. Tools are namespaced by it
// (mcp__agent-007-board__post_job), so it must not collide with a server the
// user has configured themselves — `--mcp-config` merges with their own setup
// rather than replacing it, which is the whole reason we do not pass
// --strict-mcp-config (that would take away their MCP servers inside every
// agent this app spawns).
export const MCP_SERVER_NAME = 'agent-007-board';

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

export function removeMcpConfig(sessionId) {
  try {
    rmSync(mcpConfigPath(sessionId), { force: true });
  } catch (err) {
    console.error(`Could not remove the MCP config for session ${sessionId}:`, err.message);
  }
}

// Only Claude Code takes `--mcp-config`. Verified against the other agents a
// user might reasonably type here: Gemini CLI has no per-invocation MCP config
// flag at all (only `gemini mcp add`, which mutates its persistent settings),
// and Codex configures MCP through ~/.codex/config.toml. Appending the flag to
// either would be an unknown-option error and a failed spawn, so the rule is:
// inject for `claude`, pass everything else through untouched.
export function takesMcpConfig(file) {
  return basename(String(file || '')) === 'claude';
}

/**
 * Insert `--mcp-config <path>` into an already-parsed argv.
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
  // The user may have passed their own. The flag is variadic (`<configs...>`),
  // so a second occurrence is ambiguous — extend theirs instead of adding one.
  const existing = args.indexOf('--mcp-config');
  if (existing !== -1) {
    return [...args.slice(0, existing + 1), configPath, ...args.slice(existing + 1)];
  }
  return ['--mcp-config', configPath, ...args];
}
