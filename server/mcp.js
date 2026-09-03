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
// Every tool is a thin wrapper over one injected board function: this module
// owns the wire text an agent reads, and nothing about how cards are stored.

// lib/jobs.js is the pure half of the board — no store, no Express — so the
// column names come from there rather than being spelled out a second time.
import { JOB_STATES, STATE_LABELS } from '../lib/jobs.js';

// Echoed back from the client's own initialize when it sends one. MCP clients
// negotiate this, and answering with whatever the client asked for is the
// behaviour this server wants — there is nothing here that varies by protocol
// revision.
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
    + 'will not have this conversation. Pass `schedule` to make it a recurring job '
    + 'that runs on a cron schedule instead of once.',
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
      schedule: {
        type: 'string',
        description:
          'Optional. Supplying this makes the card a SCHEDULED job that runs again '
          + 'on every match instead of once: a five-field cron expression in the '
          + "server's local time (\"0 9 * * 1-5\" = 09:00 on weekdays), or one of "
          + '@hourly, @daily, @weekly, @monthly, @yearly. A scheduled job need not be '
          + 'a coding task and is not expected to open a pull request. Omit this for '
          + 'ordinary work that should happen once.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

// Reading the board is a separate tool from writing to it so an agent can be
// asked "what is on the board?" without the answer costing a card. The board is
// one shared wall — every connected client sees every card — so these show the
// whole board rather than only what this agent posted.
export const LIST_JOBS_TOOL = {
  name: 'list_jobs',
  description:
    'List the cards on the Agent 007 job board — To do, In progress and Review, '
    + 'with the id of each. Use this when the user asks what is on the board, what '
    + 'is queued or running, or before editing a card, since editing needs the id. '
    + 'Finished cards are archived off the board: pass state "done" to see those.',
  inputSchema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: JOB_STATES,
        description:
          'Optional. Show only this column: todo, in-progress, review, or done '
          + '(the finished archive). Omit for the whole board, archive excluded.',
      },
      repo: {
        type: 'string',
        description:
          'Optional. Show only cards for this repository — a full path or just the '
          + 'folder name. Omit for every repository the board knows.',
      },
    },
    additionalProperties: false,
  },
};

export const READ_JOB_TOOL = {
  name: 'read_job',
  description:
    'Read one card on the Agent 007 job board in full, including the detail the '
    + 'job agent is given, its branch and pull request, and any error the board hit. '
    + 'Use this when the user asks what a card says or how it is going. Ids come '
    + 'from list_jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The card id, as list_jobs reports it.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

export const EDIT_JOB_TOOL = {
  name: 'edit_job',
  description:
    'Change a card that is still in To do: its title, detail, repository or '
    + 'schedule. Only To do cards can be edited — once the board has dispatched a '
    + 'card its agent has already been handed the text, so a later edit would leave '
    + 'the card describing work nobody was asked to do. Pass only the fields that '
    + 'change; the rest are left alone. Ids come from list_jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The card id, as list_jobs reports it.' },
      title: { type: 'string', description: 'Replaces the line naming the work.' },
      detail: {
        type: 'string',
        description:
          'Replaces the whole detail body — this is not appended to what is there, '
          + 'so read the card first if you mean to add to it.',
      },
      repo: {
        type: 'string',
        description: 'Move the card to another repository — a full path or folder name.',
      },
      schedule: {
        type: 'string',
        description:
          'Replaces the cron schedule (five fields, or an @shorthand). Pass an empty '
          + 'string to turn a scheduled card back into one that runs once.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

export const TOOLS = [POST_JOB_TOOL, LIST_JOBS_TOOL, READ_JOB_TOOL, EDIT_JOB_TOOL];

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// A tool that failed is not a protocol error: MCP reports it as a normal result
// with isError, so the model reads the reason and can correct itself. A JSON-RPC
// error would surface to the agent as "the tool is broken" instead.
const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

// When a card fired, in the reader's own clock. The stored value is ISO; an
// agent reporting "next 2026-09-04T09:00:00.000Z" to a person is making them do
// the conversion.
const when = (iso) => (iso ? new Date(iso).toLocaleString() : null);

// One line per card: what it is, and the id needed to read or edit it. Kept
// lean deliberately — who posted it and the whole detail body are what read_job
// is for, and a board of twenty cards is answering "what is queued?", not
// twenty questions.
function summaryLine(job) {
  const bits = [job.repo];
  if (job.type === 'scheduled') {
    bits.push(`scheduled ${job.schedule}${job.nextRunAt ? `, next ${when(job.nextRunAt)}` : ''}`);
  }
  // The live state of the agent working it, when there is one, is the part a
  // person actually asks about ("is it stuck?").
  if (job.agentName) bits.push(`${job.agentName}${job.status ? ` ${job.status}` : ''}`);
  if (job.prUrl) bits.push(job.prUrl);
  return `  ${job.id}  ${job.title}\n    ${bits.filter(Boolean).join(' · ')}`;
}

const CALLS = {
  [POST_JOB_TOOL.name]: (args, ctx) => {
    const result = ctx.postJob({
      title: args.title,
      detail: args.detail,
      repo: args.repo,
      schedule: args.schedule,
      session: ctx.session || null,
    });
    if (result.error) return toolText(result.error, true);

    const where = result.repoName ? ` in ${result.repoName}` : '';
    // Read back the schedule the board actually stored, and when it next fires.
    // A cron expression is easy to get subtly wrong ("0 0 * * 0" is not weekly
    // to everyone), and a concrete next-run time is what makes the mistake
    // visible while the user is still in the conversation to correct it.
    const fires = result.job.schedule
      ? ` on a schedule (${result.job.schedule}${result.job.nextRunAt ? `, next ${when(result.job.nextRunAt)}` : ''})`
      : '';
    const column = result.job.schedule ? '' : ' (To do)';
    const line = `Posted "${result.job.title}"${where}${fires} to the Agent 007 job board${column}.`;
    // The dispatcher note matters: with the board stopped the card sits there
    // doing nothing, and an agent reporting "queued it" without saying so would
    // leave the user believing work had started.
    const note = result.dispatcherRunning
      ? ''
      : ' The board dispatcher is stopped, so it waits there until the board is started.';
    // The id, because editing a card needs it and the agent has it right here.
    return toolText(`${line}${note}\nid: ${result.job.id}`);
  },

  [LIST_JOBS_TOOL.name]: (args, ctx) => {
    const result = ctx.listJobs({ state: args.state, repo: args.repo });
    if (result.error) return toolText(result.error, true);

    const scope = [result.state ? STATE_LABELS[result.state] : null, result.repoName]
      .filter(Boolean).join(' · ');
    if (!result.jobs.length) {
      // An empty board and a filtered-out board read the same otherwise, and
      // the archive is invisible by default — say which this is.
      const archive = result.archived ? ` ${result.archived} finished card(s) are archived (state: "done").` : '';
      return toolText(`Nothing on the Agent 007 job board${scope ? ` for ${scope}` : ''}.${archive}`);
    }
    // Grouped by column in board order, so the shape of the answer is the shape
    // of the board the user is looking at.
    const groups = JOB_STATES
      .map(state => [state, result.jobs.filter(job => job.state === state)])
      .filter(([, jobs]) => jobs.length)
      .map(([state, jobs]) => `${STATE_LABELS[state]} (${jobs.length})\n${jobs.map(summaryLine).join('\n')}`);
    const head = `${result.jobs.length} card(s) on the Agent 007 job board${scope ? ` — ${scope}` : ''}:`;
    const archive = result.archived
      ? `\n\n${result.archived} finished card(s) are archived off the board (state: "done").`
      : '';
    return toolText(`${head}\n\n${groups.join('\n\n')}${archive}`);
  },

  [READ_JOB_TOOL.name]: (args, ctx) => {
    const result = ctx.readJob(args.id);
    if (result.error) return toolText(result.error, true);
    const job = result.job;
    const lines = [
      `${job.title}`,
      `id: ${job.id}`,
      `column: ${job.stateLabel}${job.status ? ` (${job.status})` : ''}`,
      `repo: ${job.repo}${job.repoPath && job.repoPath !== job.repo ? ` — ${job.repoPath}` : ''}`,
      job.type === 'scheduled'
        ? `schedule: ${job.schedule}${job.nextRunAt ? ` — next ${when(job.nextRunAt)}` : ''}`
          + `${job.runCount ? ` — run ${job.runCount} time(s), last ${when(job.lastRunAt)}` : ''}`
        : 'schedule: runs once',
      `posted: ${when(job.postedAt)}`
        + `${job.postedByName ? ` by ${job.postedByName}` : ''}`
        + `${job.postedByAgent ? ` (typed by ${job.postedByAgent})` : ''}`,
      job.agentName ? `agent: ${job.agentName}, started ${when(job.startedAt)}` : null,
      job.branchName ? `branch: ${job.branchName}` : null,
      job.worktreePath ? `worktree: ${job.worktreePath}` : null,
      job.prUrl ? `pull request: ${job.prUrl}${job.prMergedAt ? ` (merged ${when(job.prMergedAt)})` : ''}` : null,
      job.attachments.length ? `attachments: ${job.attachments.join(', ')}` : null,
      // Surfaced, not swallowed: a card that failed to dispatch looks identical
      // to one waiting its turn unless the reason is said out loud.
      job.lastError ? `last error: ${job.lastError}` : null,
      job.prCheckError ? `pull request check: ${job.prCheckError}` : null,
      job.state === 'todo' ? null : 'This card has left To do, so edit_job can no longer change it.',
      '',
      job.detail || '(no detail on this card)',
    ];
    return toolText(lines.filter(line => line !== null).join('\n'));
  },

  [EDIT_JOB_TOOL.name]: (args, ctx) => {
    const result = ctx.editJob({
      id: args.id,
      title: args.title,
      detail: args.detail,
      repo: args.repo,
      schedule: args.schedule,
    });
    if (result.error) return toolText(result.error, true);
    const job = result.job;
    const fires = job.type === 'scheduled'
      ? ` It runs ${job.schedule}${job.nextRunAt ? `, next ${when(job.nextRunAt)}` : ''}.`
      : '';
    return toolText(
      `Updated ${result.changed.join(', ')} on "${job.title}" (${job.repo}), still in To do.${fires}`,
    );
  },
};

/**
 * Handle one JSON-RPC message.
 *
 * @param msg      parsed JSON-RPC request or notification
 * @param ctx      { session, postJob, listJobs, readJob, editJob } — the agent
 *                 this token belongs to, and the injected board functions
 *                 (server/jobs.js, the write ones bound to a broadcast), kept
 *                 as parameters so this module never imports the job store.
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
    const handler = CALLS[params?.name];
    if (!handler) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    return ok(id, handler(params?.arguments || {}, ctx));
  }

  // Everything else, including the client's own discovery probes. JSON-RPC says
  // method-not-found; Claude Code handles it and carries on.
  return fail(id, -32601, `Method not found: ${method}`);
}
