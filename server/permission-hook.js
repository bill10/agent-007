#!/usr/bin/env node
// Claude Code's PermissionRequest hook for a worker on one of Billion's cards
// (docs/BILLION.md, part 4). Runs as its own process whenever the worker is
// about to show a permission dialog: it hands the request to the Agent 007
// server, which asks Billion, and prints Billion's answer.
//
// Anything short of a clear answer prints nothing, and printing nothing means
// "no decision": the dialog appears for a person as it always did. So a
// server that is down, slow or confused can never approve anything.

import { readFileSync } from 'fs';

// The worker's own board MCP config (server/agent-mcp.js), passed as the one
// argument: it already holds the board's address and this agent's token, in a
// 0600 file. Not an environment variable — every process the agent starts
// would inherit that.
function board(configPath) {
  try {
    const server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers['agent-007-board'];
    return { url: server.url.replace(/\/mcp$/, '/hook/permission'), auth: server.headers.Authorization };
  } catch {
    return null;
  }
}
const target = board(process.argv[2]);
// A little past the server's own wait, which answers "no decision" when
// Billion is silent; the hook's timeout in the settings is longer still.
const WAIT_MS = 140_000;

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
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!res.ok) return;
    const body = await res.json();
    const behavior = body?.hookSpecificOutput?.decision?.behavior;
    if (behavior === 'allow' || behavior === 'deny') process.stdout.write(JSON.stringify(body));
  } catch {
    // No decision.
  }
});
