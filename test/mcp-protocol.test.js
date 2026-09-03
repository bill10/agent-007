// The MCP protocol layer — what an agent's MCP client gets back from the board.
//
// handleMcpMessage takes a parsed JSON-RPC message and returns the reply, with
// the board writer injected, so every branch here is exercised without a server,
// a socket or a job store.

import { describe, it, expect, vi } from 'vitest';
import {
  handleMcpMessage, TOOLS, POST_JOB_TOOL, LIST_JOBS_TOOL, READ_JOB_TOOL, EDIT_JOB_TOOL,
  SERVER_INFO, DEFAULT_PROTOCOL_VERSION,
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
  it('offers the four board tools, with post_job needing a title', () => {
    const reply = handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {});
    expect(reply.result.tools).toEqual(TOOLS);
    expect(reply.result.tools.map(t => t.name)).toEqual(['post_job', 'list_jobs', 'read_job', 'edit_job']);
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

  it('passes the schedule through and reads back the cron and next run', () => {
    const postJob = fakePostJob({
      job: { id: 'job-1', title: 'Digest', schedule: '@daily', nextRunAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    const reply = call({ title: 'Digest', schedule: '@daily' }, postJob);
    expect(postJob.mock.calls[0][0].schedule).toBe('@daily');
    const text = reply.result.content[0].text;
    // The read-back is the whole point: a wrong cron is visible while someone
    // is still in the conversation to correct it.
    expect(text).toContain('@daily');
    expect(text).toMatch(/next /i);
    expect(text).not.toContain('(To do)');
  });

  it('hands a bad cron back as a tool error the agent can read', () => {
    const reply = call({ title: 'Digest', schedule: 'every friday' },
      fakePostJob({ error: 'A cron schedule has five fields', job: undefined }));
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/five fields/);
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

// Stand-ins for the read side, shaped like server/jobs.js returns.
const CARD = {
  id: 'job-1', title: 'Add rate limiting', state: 'todo', stateLabel: 'To do',
  type: 'one-time', schedule: null, nextRunAt: null, repo: 'alpha', status: 'queued',
  agentName: null, prUrl: null, postedByName: 'Bill', postedByAgent: 'Onyx',
  postedAt: '2026-09-03T09:00:00.000Z',
};

const callTool = (name, args, ctx) => handleMcpMessage(
  { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
  { session: SESSION, ...ctx },
);
const textOf = (reply) => reply.result.content[0].text;

describe('listing the board', () => {
  it('groups the cards by column and names the id of each', () => {
    const running = { ...CARD, id: 'job-2', title: 'Already going', state: 'in-progress', agentName: 'Slate', status: 'running' };
    const reply = callTool('list_jobs', {}, {
      listJobs: () => ({ jobs: [CARD, running], state: null, repoName: null, archived: 0 }),
    });
    const text = textOf(reply);
    expect(text).toMatch(/To do \(1\)[\s\S]*job-1  Add rate limiting/);
    expect(text).toMatch(/In progress \(1\)[\s\S]*job-2  Already going/);
    // The agent working a card and how it is doing is what gets asked about.
    expect(text).toContain('Slate running');
  });

  it('says an empty board is empty, and whether anything is archived behind it', () => {
    const reply = callTool('list_jobs', {}, {
      listJobs: () => ({ jobs: [], state: null, repoName: null, archived: 3 }),
    });
    expect(textOf(reply)).toMatch(/Nothing on the Agent 007 job board/);
    expect(textOf(reply)).toMatch(/3 finished card\(s\) are archived/);
  });

  it('passes the filters through and says which slice it answered with', () => {
    const listJobs = vi.fn(() => ({ jobs: [CARD], state: 'todo', repoName: 'alpha', archived: 0 }));
    const reply = callTool('list_jobs', { state: 'todo', repo: 'alpha' }, { listJobs });
    expect(listJobs).toHaveBeenCalledWith({ state: 'todo', repo: 'alpha' });
    expect(textOf(reply)).toContain('To do · alpha');
  });

  it('offers the columns as an enum, so a bad state is caught before the call', () => {
    expect(LIST_JOBS_TOOL.inputSchema.properties.state.enum).toEqual(['todo', 'in-progress', 'review', 'done']);
  });

  it('returns a refusal as a tool error, not a JSON-RPC error', () => {
    const reply = callTool('list_jobs', { state: 'backlog' }, {
      listJobs: () => ({ error: 'Unknown state "backlog"' }),
    });
    expect(reply.result.isError).toBe(true);
    expect(reply.error).toBeUndefined();
  });
});

describe('reading one card', () => {
  const full = {
    ...CARD, detail: 'Token bucket, 100/min.', repoPath: '/repos/alpha',
    branchName: 'board/add-rate-limiting', worktreePath: null, startedAt: null,
    reviewAt: null, prMergedAt: null, doneAt: null, lastRunAt: null, runCount: 0,
    lastError: 'worktree busy', prCheckError: null, attachments: ['spec.md'],
  };

  it('reads the card out with its detail, branch and error', () => {
    const readJob = vi.fn(() => ({ job: full }));
    const text = textOf(callTool('read_job', { id: 'job-1' }, { readJob }));
    expect(readJob).toHaveBeenCalledWith('job-1');
    expect(text).toContain('Token bucket, 100/min.');
    expect(text).toContain('board/add-rate-limiting');
    expect(text).toContain('spec.md');
    // Surfaced deliberately: a card that failed to dispatch otherwise looks
    // exactly like one waiting its turn.
    expect(text).toContain('last error: worktree busy');
  });

  it('warns when the card has left To do and can no longer be edited', () => {
    const reply = callTool('read_job', { id: 'job-1' }, {
      readJob: () => ({ job: { ...full, state: 'review', stateLabel: 'Review' } }),
    });
    expect(textOf(reply)).toMatch(/edit_job can no longer change it/);
    expect(textOf(callTool('read_job', { id: 'job-1' }, { readJob: () => ({ job: full }) })))
      .not.toMatch(/can no longer change it/);
  });

  it('renders a scheduled card\'s cron and next run in local time, not ISO', () => {
    const reply = callTool('read_job', { id: 'job-1' }, {
      readJob: () => ({ job: { ...full, type: 'scheduled', schedule: '@daily', nextRunAt: '2026-09-04T09:00:00.000Z' } }),
    });
    expect(textOf(reply)).toContain('schedule: @daily');
    expect(textOf(reply)).not.toContain('2026-09-04T09:00:00.000Z');
  });

  it('hands a missing card back as a tool error', () => {
    const reply = callTool('read_job', { id: 'nope' }, { readJob: () => ({ error: 'No job with id "nope"' }) });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply)).toMatch(/No job with id/);
  });
});

describe('editing a card', () => {
  it('passes only the fields it was given, and reports what changed', () => {
    const editJob = vi.fn(() => ({ job: { ...CARD, title: 'Retitled' }, changed: ['title'] }));
    const reply = callTool('edit_job', { id: 'job-1', title: 'Retitled' }, { editJob });
    expect(editJob).toHaveBeenCalledWith({
      id: 'job-1', title: 'Retitled', detail: undefined, repo: undefined, schedule: undefined,
    });
    expect(textOf(reply)).toMatch(/Updated title on "Retitled" \(alpha\), still in To do/);
  });

  it('reads back the schedule it set, and when it next fires', () => {
    const reply = callTool('edit_job', { id: 'job-1', schedule: '@daily' }, {
      editJob: () => ({
        job: { ...CARD, type: 'scheduled', schedule: '@daily', nextRunAt: '2026-09-04T09:00:00.000Z' },
        changed: ['schedule'],
      }),
    });
    expect(textOf(reply)).toContain('It runs @daily, next');
  });

  it('surfaces the To do rule as a tool error the agent can read', () => {
    const reply = callTool('edit_job', { id: 'job-1', title: 'Too late' }, {
      editJob: () => ({ error: '"Add rate limiting" is in Review, and only cards still in To do can be edited' }),
    });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply)).toMatch(/only cards still in To do can be edited/);
  });

  it('needs an id, and says the edit replaces the detail rather than appending', () => {
    expect(EDIT_JOB_TOOL.inputSchema.required).toEqual(['id']);
    expect(READ_JOB_TOOL.inputSchema.required).toEqual(['id']);
    expect(EDIT_JOB_TOOL.inputSchema.properties.detail.description).toMatch(/not appended/);
  });
});
