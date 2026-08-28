// The MCP protocol layer — what an agent's MCP client gets back from the board.
//
// handleMcpMessage takes a parsed JSON-RPC message and returns the reply, with
// the board writer injected, so every branch here is exercised without a server,
// a socket or a job store.

import { describe, it, expect, vi } from 'vitest';
import {
  handleMcpMessage, TOOLS, POST_JOB_TOOL, SERVER_INFO, DEFAULT_PROTOCOL_VERSION,
} from '../server/mcp.js';

const SESSION = { id: 'session-1', name: 'Onyx', repoPath: '/repos/alpha' };

// Stand-in for postJobForAgent bound to a broadcast.
function fakePostJob(result = {}) {
  return vi.fn(() => ({
    job: { id: 'job-1', title: 'Add rate limiting' },
    repoName: 'alpha',
    dispatcherRunning: true,
    ...result,
  }));
}

const call = (args, postJob, session = SESSION) => handleMcpMessage(
  { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'post_job', arguments: args } },
  { session, postJob },
);

describe('handshake', () => {
  it('echoes the protocol version the client asked for', () => {
    const reply = handleMcpMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, {});
    expect(reply.result.protocolVersion).toBe('2025-03-26');
    expect(reply.result.serverInfo).toEqual(SERVER_INFO);
    expect(reply.result.capabilities.tools).toBeTruthy();
  });

  it('falls back to a known version when the client names none', () => {
    const reply = handleMcpMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }, {});
    expect(reply.result.protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
  });

  it('answers notifications with nothing at all', () => {
    // JSON-RPC forbids replying to a notification, and the client sends
    // notifications/initialized immediately after the handshake. Answering it
    // is a protocol violation, not a harmless extra.
    expect(handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, {})).toBeNull();
  });

  it('reports method-not-found for anything else, rather than failing the connection', () => {
    // Claude Code probes methods this server does not implement (server/discover
    // was observed live). A JSON-RPC error is the correct answer and the client
    // carries on; throwing would drop the whole session.
    const reply = handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'server/discover' }, {});
    expect(reply.error.code).toBe(-32601);
    expect(reply.result).toBeUndefined();
  });
});

describe('tools/list', () => {
  it('offers exactly the post_job tool, with title required', () => {
    const reply = handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {});
    expect(reply.result.tools).toEqual(TOOLS);
    expect(reply.result.tools.map(t => t.name)).toEqual(['post_job']);
    expect(POST_JOB_TOOL.inputSchema.required).toEqual(['title']);
  });

  it('describes the tool as something to reach for when asked', () => {
    // The description is the entire discovery mechanism — it is what the agent
    // reads to decide whether this tool applies. If it ever stops saying that
    // this is for work the USER asks to queue, agents start filing their own.
    expect(POST_JOB_TOOL.description).toMatch(/when the user asks/i);
  });

  it('warns that the job agent will not have this conversation', () => {
    // A card whose detail assumes the reader was present is a job that stalls
    // on its first question.
    expect(POST_JOB_TOOL.description).toMatch(/unattended|not have this conversation/i);
  });
});

describe('tools/call post_job', () => {
  it('passes the arguments through and credits the calling agent', () => {
    const postJob = fakePostJob();
    call({ title: 'Add rate limiting', detail: 'Token bucket.', repo: 'alpha' }, postJob);
    expect(postJob).toHaveBeenCalledWith({
      title: 'Add rate limiting', detail: 'Token bucket.', repo: 'alpha', session: SESSION,
    });
  });

  it('reports the repo the card landed in', () => {
    const reply = call({ title: 'Add rate limiting' }, fakePostJob());
    expect(reply.result.content[0].text).toContain('Posted "Add rate limiting" in alpha');
    expect(reply.result.isError).toBe(false);
  });

  it('says so when the dispatcher is stopped', () => {
    // Otherwise the agent tells its user "queued" and they believe work has
    // started, when the card is just sitting there.
    const reply = call({ title: 'X' }, fakePostJob({ dispatcherRunning: false }));
    expect(reply.result.content[0].text).toMatch(/dispatcher is stopped/);
  });

  it('returns a refusal as a tool error, not a JSON-RPC error', () => {
    // isError lets the model read the reason and correct itself; a JSON-RPC
    // error reads as "the tool is broken" and it stops trying.
    const reply = call({ title: '' }, fakePostJob({ error: 'Title is required', job: undefined }));
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toBe('Title is required');
  });

  it('rejects an unknown tool name', () => {
    const reply = handleMcpMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } },
      { session: SESSION, postJob: fakePostJob() },
    );
    expect(reply.error.code).toBe(-32602);
  });

  it('survives a call with no arguments object', () => {
    const postJob = fakePostJob({ error: 'Title is required' });
    const reply = handleMcpMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'post_job' } },
      { session: SESSION, postJob },
    );
    expect(reply.result.isError).toBe(true);
  });
});
