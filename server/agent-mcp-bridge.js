// Codex's stdio transport forwards to the board's existing JSON HTTP endpoint.
// Only the config path is in argv; the session credential stays in its 0600 file.
import { readFileSync } from 'fs';
import { createInterface } from 'readline';

let server;
try {
  server = JSON.parse(readFileSync(process.argv[2], 'utf8')).mcpServers['agent-007-board'];
  if (!server?.url || !server.headers?.Authorization) throw new Error('Missing config');
} catch {
  console.error('Could not read the board MCP config.');
  process.exit(1);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' } }) + '\n');
    continue;
  }
  const hasId = message && Object.hasOwn(message, 'id');
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...server.headers, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream' },
      body: line,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Board request failed');
    if (response.status === 202 || response.status === 204) continue;
    const body = await response.json();
    if (hasId) process.stdout.write(JSON.stringify(body) + '\n');
  } catch {
    // Never echo response bodies or exception details: they may contain secrets.
    if (hasId) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      error: { code: -32603, message: 'Board MCP request failed' } }) + '\n');
  }
}
