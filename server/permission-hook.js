#!/usr/bin/env node
// The PermissionRequest hook (Claude Code's and Codex's) for a worker on one of Billion's cards
// (docs/BILLION.md, part 4). Runs as its own process whenever the worker is
// about to show a permission dialog: it hands the request to the Agent 007
// server, which asks Billion, and prints Billion's answer.
//
// Anything short of a clear answer prints nothing, and printing nothing means
// "no decision": the dialog appears for a person as it always did. So a
// server that is down, slow or confused can never approve anything.

import { readFileSync } from 'fs';
import { MCP_SERVER_NAME, HOOK_WAIT_MS, CODEX_HOOK_CONFIG_ENV } from './agent-mcp.js';

// The worker's own board MCP config (server/agent-mcp.js), passed as the one
// argument: it already holds the board's address and this agent's token, in a
// 0600 file. Not the token in an environment variable — every process the
// agent starts would inherit that. Codex hashes the hook's command, which must
// then be the same for every worker, so a Codex worker names its file in
// CODEX_HOOK_CONFIG_ENV instead: a path only, to a file its processes could
// open anyway.
function board(configPath) {
  try {
    const server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers[MCP_SERVER_NAME];
    return { url: server.url.replace(/\/mcp$/, '/hook/permission'), auth: server.headers.Authorization };
  } catch {
    return null;
  }
}
const target = board(process.argv[2] || process.env[CODEX_HOOK_CONFIG_ENV]);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  if (!target) return;
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: target.auth },
      body: input,
      signal: AbortSignal.timeout(HOOK_WAIT_MS),
    });
    if (!res.ok) return;
    const body = await res.json();
    const behavior = body?.hookSpecificOutput?.decision?.behavior;
    if (behavior === 'allow' || behavior === 'deny') process.stdout.write(JSON.stringify(body));
  } catch {
    // No decision.
  }
});
