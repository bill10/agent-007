// The board's MCP server — how an agent you are talking to can put a card on
// the job board when you ask it to.
//
// Why MCP and not a command on PATH: an agent does not enumerate its PATH, so a
// binary sitting there is invisible. An MCP tool arrives in the agent's tool
// list with a name and a description, which is real discovery — and it is a
// capability, not an instruction. Nothing tells an agent to post jobs; the tool
// is simply there when the user asks for one.
//
// Transport is streamable HTTP served from the app's own Express server (see
// server/http.js), so there is no child process anywhere: Claude Code connects
// to a URL. The alternative, stdio, would have Claude Code spawn a server per
// agent, which is a process to supervise for no gain when we already listen.
//
// Kept free of Express and of the job store so the protocol is testable on its
// own: handleMcpMessage takes a parsed message and a context, and returns the
// reply object (or null for a notification, which gets no reply by JSON-RPC).

// Echoed back from the client's own initialize when it sends one. MCP clients
// negotiate this, and answering with whatever the client asked for is the
// behaviour a single-tool server wants — there is nothing here that varies by
// protocol revision.
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export const SERVER_INFO = { name: 'agent-007-board', version: '1' };

// The description is the whole discovery mechanism, so it says what the tool is
// for and — deliberately — when to reach for it. "When the user asks" is the
// operative clause: a job board full of work an agent queued for itself is not
// what this is for.
export const POST_JOB_TOOL = {
  name: 'post_job',
  description:
    'Post a job card to the Agent 007 job board, in the To do column. Use this when '
    + 'the user asks you to add something to the board, queue work for later, or hand '
    + 'a task to another agent — not for work you are already doing. The board '
    + 'dispatches each card to a fresh agent in its own git worktree and branch, so '
    + 'the detail must be everything that agent needs to do the work unattended: it '
    + 'will not have this conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'One line naming the work, as it should read on the card.',
      },
      detail: {
        type: 'string',
        description:
          'Everything the agent picking this up needs: context, constraints, files, '
          + 'how to tell it is done. Written for someone who was not in this conversation.',
      },
      repo: {
        type: 'string',
        description:
          'Which repository to run the job in — a full path or just the folder name. '
          + 'Defaults to the repository this terminal is working in.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export const TOOLS = [POST_JOB_TOOL];

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// A tool that failed is not a protocol error: MCP reports it as a normal result
// with isError, so the model reads the reason and can correct itself. A JSON-RPC
// error would surface to the agent as "the tool is broken" instead.
const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

/**
 * Handle one JSON-RPC message.
 *
 * @param msg      parsed JSON-RPC request or notification
 * @param ctx      { session, postJob } — the agent this token belongs to, and
 *                 the injected board writer (server/jobs.js postJobForAgent,
 *                 bound to a broadcast), kept as a parameter so this module
 *                 never imports the job store.
 * @returns the reply object, or null when the message is a notification.
 */
export function handleMcpMessage(msg, ctx = {}) {
  const { id, method, params } = msg || {};
  // JSON-RPC notifications carry no id and MUST NOT be answered. The client
  // sends notifications/initialized right after the handshake.
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }

  if (isNotification) return null;

  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    if (name !== POST_JOB_TOOL.name) {
      return fail(id, -32602, `Unknown tool: ${name}`);
    }
    const args = params?.arguments || {};
    const result = ctx.postJob({
      title: args.title,
      detail: args.detail,
      repo: args.repo,
      session: ctx.session || null,
    });
    if (result.error) return ok(id, toolText(result.error, true));

    const where = result.repoName ? ` in ${result.repoName}` : '';
    const line = `Posted "${result.job.title}"${where} to the Agent 007 job board (To do).`;
    // The dispatcher note matters: with the board stopped the card sits there
    // doing nothing, and an agent reporting "queued it" without saying so would
    // leave the user believing work had started.
    const note = result.dispatcherRunning
      ? ''
      : ' The board dispatcher is stopped, so it waits there until the board is started.';
    return ok(id, toolText(line + note));
  }

  // Everything else, including the client's own discovery probes. JSON-RPC says
  // method-not-found; Claude Code handles it and carries on.
  return fail(id, -32601, `Method not found: ${method}`);
}
