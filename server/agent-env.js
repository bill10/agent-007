// The environment every agent terminal is spawned with.
//
// Its job is one feature: an agent you are talking to can post a card to the
// job board when you ask it to. That needs three things in the child process —
// the `agent-007-job` command on PATH, the address of this server, and a token
// that identifies the calling agent (server/auth.js mints it, server/http.js
// resolves it).
//
// Separate from pty.js so it can be tested without importing node-pty.

import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PORT, HOST, WILDCARD_BIND_HOSTS } from './state.js';

// A directory holding exactly one script, rather than bin/: prepending bin/
// would also hand every agent `adduser.js`. PATH rather than documentation
// alone, because an agent will not discover a command it has to be told the
// absolute path of first.
export const AGENT_CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-cli');

// Agents run on this machine, so the board is reachable over loopback — which
// also keeps the token off the network when HOST is a tailnet address. A
// non-wildcard bind is the one case where loopback may not be listening, so
// use the bind address itself there.
export function boardBaseUrl() {
  const host = WILDCARD_BIND_HOSTS.includes(HOST) ? '127.0.0.1' : HOST;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${PORT}`;
}

export function agentEnv({ sessionId, name, repoPath, worktreePath, branchName, agentToken } = {}) {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    PATH: `${AGENT_CLI_DIR}${delimiter}${process.env.PATH || ''}`,
    AGENT007_URL: boardBaseUrl(),
    AGENT007_TOKEN: agentToken || '',
    AGENT007_SESSION_ID: sessionId || '',
    AGENT007_AGENT_NAME: name || '',
    AGENT007_REPO: repoPath || '',
    AGENT007_WORKTREE: worktreePath || '',
    AGENT007_BRANCH: branchName || '',
  };
}
