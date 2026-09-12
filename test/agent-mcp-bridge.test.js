import { afterEach, expect, it } from 'vitest';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { handleMcpMessage } from '../server/mcp.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });

it('connects a stdio client to the board, including discovery, posting and HTTP errors', async () => {
  const posted = [];
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    requests.push({ auth: req.headers.authorization, url: req.url, message });
    if (message.method === 'fail') { res.writeHead(401).end('private server details'); return; }
    const result = handleMcpMessage(message, {
      postJob: args => {
        posted.push(args);
        return { job: { id: 'job-1', title: args.title }, dispatcherRunning: false };
      },
    });
    if (result === null) res.writeHead(202).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  const dir = mkdtempSync(join(tmpdir(), 'board bridge '));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { 'agent-007-board': {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    headers: { Authorization: 'Bearer test-secret' },
  } } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/agent-mcp-bridge.js', import.meta.url)), path]);
  cleanups.push(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'post_job', arguments: { title: 'Fix bug', detail: 'Repro steps' } } },
    { jsonrpc: '2.0', id: 4, method: 'fail' },
  ];
  child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  expect(await exited).toBe(0);
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  expect(replies.map(reply => reply.id)).toEqual([1, 2, 3, 4]);
  expect(replies[0].result.serverInfo.name).toBe('agent-007-board');
  expect(replies[1].result.tools.map(tool => tool.name)).toContain('post_job');
  expect(replies[2].result.isError).toBe(false);
  expect(posted[0]).toMatchObject({ title: 'Fix bug', detail: 'Repro steps' });
  expect(replies[3].error.code).toBe(-32603);
  expect(requests).toHaveLength(5);
  expect(requests.every(req => req.auth === 'Bearer test-secret' && req.url === '/mcp')).toBe(true);
  expect(output + errors).not.toMatch(/test-secret|private server details/);
});

function bridgeConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'board-bridge-errors-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

async function runBridge(path, input = '') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/agent-mcp-bridge.js', import.meta.url)), path]);
  cleanups.push(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  // Config failures can close stdin before the parent finishes writing.
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  child.stdin.end(input);
  const code = await closed;
  return { code, output, errors, replies: output.trim() ? output.trim().split('\n').map(JSON.parse) : [] };
}

async function testEndpoint(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const path = bridgeConfig(JSON.stringify({ mcpServers: { 'agent-007-board': {
    url, headers: { Authorization: 'Bearer test-secret' },
  } } }));
  return { server, url, path };
}

it.each([
  ['missing file', undefined],
  ['invalid JSON', '{private-config-secret'],
  ['missing server', '{"mcpServers":{}}'],
  ['missing URL', '{"mcpServers":{"agent-007-board":{"headers":{"Authorization":"private-config-secret"}}}}'],
  ['missing credential', '{"mcpServers":{"agent-007-board":{"url":"http://localhost"}}}'],
])('fails safely for %s', async (_label, contents) => {
  const result = await runBridge(bridgeConfig(contents));
  expect(result.code).toBe(1);
  expect(result.output).toBe('');
  expect(result.errors).toBe('Could not read the board MCP config.\n');
});

it('ignores blank frames and recovers after malformed JSON, including a final frame without newline', async () => {
  const received = [];
  const { path } = await testEndpoint(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push(JSON.parse(raw));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: received.at(-1).id, result: {} }));
  });
  const result = await runBridge(path, '\n  \r\n{bad\n{"jsonrpc":"2.0","id":0,"method":"ping"}');
  expect(result.code).toBe(0);
  expect(result.replies).toEqual([
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    { jsonrpc: '2.0', id: 0, result: {} },
  ]);
  expect(received).toEqual([{ jsonrpc: '2.0', id: 0, method: 'ping' }]);
  expect(result.errors).toBe('');
});

it('suppresses notification replies on success, no-content responses, and failures', async () => {
  let requests = 0;
  const { path } = await testEndpoint(async (req, res) => {
    for await (const _chunk of req) { /* Drain the request body. */ }
    requests += 1;
    if (requests === 1) res.end('{"jsonrpc":"2.0","result":{}}');
    if (requests === 2) res.writeHead(204).end();
    if (requests === 3) res.writeHead(500).end('private-server-secret');
  });
  const result = await runBridge(path, Array(3).fill('{"jsonrpc":"2.0","method":"notifications/initialized"}\n').join(''));
  expect(result.code).toBe(0);
  expect(requests).toBe(3);
  expect(result.output).toBe('');
  expect(result.errors).toBe('');
});

it('redacts malformed upstream responses and socket failures and continues serving requests', async () => {
  let requests = 0;
  const { path } = await testEndpoint(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    requests += 1;
    if (requests === 1) res.end('private-server-secret');
    else if (requests === 2) req.socket.destroy();
    else res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  });
  const result = await runBridge(path, [1, 2, 3].map(id => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })).join('\n'));
  expect(result.code).toBe(0);
  expect(result.replies).toEqual([
    { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Board MCP request failed' } },
    { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Board MCP request failed' } },
    { jsonrpc: '2.0', id: 3, result: {} },
  ]);
  expect(result.output + result.errors).not.toMatch(/test-secret|private-server-secret/);
});

it('rejects redirects without forwarding credentials to their destination', async () => {
  let destinationRequests = 0;
  const destination = await testEndpoint((_req, res) => { destinationRequests += 1; res.end('{}'); });
  const { path } = await testEndpoint((_req, res) => res.writeHead(307, { Location: destination.url }).end());
  const result = await runBridge(path, '{"jsonrpc":"2.0","id":"redirect","method":"ping"}\n');
  expect(result.code).toBe(0);
  expect(result.replies).toEqual([
    { jsonrpc: '2.0', id: 'redirect', error: { code: -32603, message: 'Board MCP request failed' } },
  ]);
  expect(destinationRequests).toBe(0);
  expect(result.output + result.errors).not.toContain('test-secret');
});

it('exits cleanly on stdin EOF without making a request', async () => {
  let requests = 0;
  const { path } = await testEndpoint((_req, res) => { requests += 1; res.end('{}'); });
  expect(await runBridge(path)).toEqual({ code: 0, output: '', errors: '', replies: [] });
  expect(requests).toBe(0);
});
