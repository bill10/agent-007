// The Billion tab's status line and step log: what Billion is doing, so a
// slow reply is never a blank screen (docs/BILLION.md, "Status line").
//
// The step log under the owner's pending message holds two kinds of step,
// each { text, at, kind }: Billion's own set_status lines (kind 'status'),
// and the tools it is using, read off its screen (kind 'tool'). A tool step
// is only ever one of the fixed phrases in toolStep ("Running a command",
// "Checking the job board"): the tool's name picks the phrase, and nothing
// of its arguments, output or Billion's reasoning gets through. The steps
// live in chat.json, so reconnects and server restarts show the same log.
import { redact, pendingOwnerMessages, updateOwnerProgress } from './owner.js';
import { screenTail } from './messages.js';

export const MAX_STATUS_CHARS = 140;
export const STATUS_TTL_MS = 30 * 60 * 1000;
// A reply that never comes (Billion answered in its terminal only) stops
// saying "working on your message" after this.
export const AWAIT_REPLY_MS = 60 * 60 * 1000;

let said = null;            // { text, at }
export const MAX_STEPS = 30;
let facts = () => ({});     // server.js: { billion, workers, nextRoundAt }
let last = '';

export function setStatusFacts(fn) { facts = fn; }

// set_status. '' clears. { ok } or { error }.
export function setBillionStatus(text, now = Date.now()) {
  if (typeof text !== 'string') return { error: 'text must be a string ("" clears it).' };
  const body = redact(text).replace(/\s+/g, ' ').trim();
  if (body.length > MAX_STATUS_CHARS) return { error: `The status is ${body.length} characters; keep it to ${MAX_STATUS_CHARS}.` };
  said = body ? { text: body, at: now } : null;
  const first = pendingOwnerMessages()[0];
  if (first && body) updateOwnerProgress(first.id, { text: body, at: new Date(now).toISOString(), kind: 'status' });
  return { ok: true, cleared: !body };
}

// --- Tool steps read off Billion's screen ---

// Billion's own notes, the only file names a step may show.
const NAMED_FILES = new Set(['STATE.md', 'COMPANY.md', 'owner.md', 'charter.md', 'CLAUDE.md', 'AGENTS.md']);
const fileName = (arg) => {
  const name = String(arg || '').trim().split(/[\\/]/).pop().replace(/[)"'`,].*$/, '');
  return NAMED_FILES.has(name) ? name : null;
};
// Claude Code's tool names and Codex's verbs, lower-cased, to what they do.
const TOOL_STEPS = {
  bash: 'Running a command', ran: 'Running a command', running: 'Running a command',
  read: (f) => (f ? `Reading ${f}` : 'Reading a file'),
  edit: (f) => (f ? `Updating ${f}` : 'Editing a file'), multiedit: (f) => (f ? `Updating ${f}` : 'Editing a file'),
  edited: (f) => (f ? `Updating ${f}` : 'Editing a file'), update: (f) => (f ? `Updating ${f}` : 'Editing a file'),
  updated: (f) => (f ? `Updating ${f}` : 'Editing a file'), write: (f) => (f ? `Updating ${f}` : 'Writing a file'),
  grep: 'Searching files', glob: 'Searching files', search: 'Searching files', searched: 'Searching files',
  explored: 'Looking through files', websearch: 'Searching the web', webfetch: 'Reading a web page',
  task: 'Starting a helper', agent: 'Starting a helper', todowrite: 'Planning the steps',
  // The board's tools (server/mcp.js). set_status and tell_owner are left
  // out: their words already show as Billion's own step and reply.
  list_jobs: 'Checking the job board', read_job: 'Reading a card', post_job: 'Posting a card',
  edit_job: 'Editing a card', close_job: 'Closing a card', finish_job: 'Finishing a card',
  list_agents: 'Checking the agents', send_message: 'Messaging an agent', withdraw_message: 'Withdrawing a message',
  read_agent_screen: "Reading a worker's screen", respawn_agent: 'Restarting a worker', merge_check: 'Checking a pull request',
  answer_permission: 'Answering a permission request', read_approval: 'Reading a permission request',
  notify_owner: 'Writing you a question', list_round_queue: 'Checking the round queue', drop_queued: 'Dropping a queued item',
  set_round_brief: 'Writing the round brief', resolve_question: 'Closing a question', reopen_question: 'Reopening a question',
  add_repo: 'Adding a repo', set_next_wake: 'Setting the next wake-up',
};

// One screen line as a step's text, or null. Claude Code draws a tool call as
// "⏺ Bash(npm test)" or "⏺ agent-007-board - list_jobs (MCP)(…)", Codex as
// "• Ran npm test" or "• Called agent-007-board.list_jobs(…)". Only the
// tool's name is looked up; the rest of the line is never shown (a file name
// only when it is one of Billion's notes). Prose ("⏺ I'll check…") and any
// tool not in TOOL_STEPS give null.
export function toolStep(line) {
  const claude = String(line).match(/^\s*⏺\s+(?:[\w.-]+\s-\s)?([A-Za-z][\w.-]*)(?:\s*\(MCP\))?\((.*)$/);
  const codex = String(line).match(/^\s*•\s+(Ran|Running|Edited|Explored|Read|Searched|Updated|Called)\b\s*(.*)$/);
  let name; let arg;
  if (claude) [name, arg] = [claude[1], claude[2]];
  else if (codex) [name, arg] = [codex[1], codex[2]];
  else return null;
  if (/^called$/i.test(name)) {
    const tool = arg.match(/^[\w.-]*?([a-z_]+)\s*\(/);
    if (!tool) return null;
    [name, arg] = [tool[1], ''];
  }
  name = name.split('.').pop().replace(/^mcp__[\w-]+?__/, '').toLowerCase();
  const step = Object.hasOwn(TOOL_STEPS, name) ? TOOL_STEPS[name] : null;
  return typeof step === 'function' ? step(fileName(arg)) : step;
}

// The screen lines already counted, per owner message (in memory only: a
// restart re-reads the screen as already seen).
const seen = new Map();   // message id -> Set of lines
const MAX_SEEN = 500;
const ANCHOR = '[Owner via';
export const STEP_TICK_MS = 2000;

// While Billion works on the owner's oldest waiting message (given to it, not
// still queued), each tool call new on its screen becomes a step of that
// message. On the first look at a message, only the lines after its own
// "[Owner via …]" are new; lines above it belong to the turn before.
export function noteScreenSteps(now = Date.now()) {
  const { billion } = facts() || {};
  // At its prompt Billion makes no steps, so chat.json is not even read.
  if (!billion || billion.exited || billion.state !== 'WORKING') return [];
  const first = pendingOwnerMessages()[0];
  for (const id of seen.keys()) if (id !== first?.id) seen.delete(id);
  if (!first || first.queued) return [];
  const lines = screenTail(billion.ringBuffer?.getAll?.().join('') || '', 200).split('\n');
  let known = seen.get(first.id);
  if (!known) {
    const anchor = lines.findLastIndex(line => line.includes(ANCHOR));
    known = new Set(anchor < 0 ? lines : lines.slice(0, anchor + 1));
    seen.set(first.id, known);
  }
  const added = [];
  for (const line of lines) {
    if (known.has(line)) continue;
    if (known.size < MAX_SEEN) known.add(line);
    const text = toolStep(line);
    if (text) added.push(text);
  }
  for (const text of added) updateOwnerProgress(first.id, { text, at: new Date(now).toISOString(), kind: 'tool' });
  return added;
}

// A tell_owner answers the owner request it names (reply_to: the short id a
// voice turn carries, or any longer prefix of a message id), even after the
// activity indicator has timed out. The reply's persisted replyTo closes it.
// A reply_to that names no waiting message binds to nothing (a follow-up to a
// turn already answered must not become the next turn's spoken answer). With
// no reply_to, the oldest waiting typed or Telegram message, else nothing: a
// Talk to Billion turn (an app voice turn) is answered only by a reply_to that
// names it, so an unrelated status note never takes its place. A Telegram voice
// note has no #id to name, so it is answered like a typed message. { id, missed }.
export const SHORT_ID_CHARS = 8;
export function billionReplied(replyTo) {
  const pending = pendingOwnerMessages();
  const wanted = typeof replyTo === 'string' ? replyTo.trim().replace(/^#/, '') : '';
  if (wanted) {
    const named = wanted.length >= SHORT_ID_CHARS && pending.find(m => m.id.startsWith(wanted));
    return named ? { id: named.id, missed: false } : { id: null, missed: true };
  }
  return { id: pending.find(m => !(m.voice && m.via === 'app'))?.id ?? null, missed: false };
}

export function statusPayload(now = Date.now()) {
  const { billion, workers = 0, nextRoundAt = null } = facts() || {};
  const running = !!billion && !billion.exited;
  const working = running && billion.state === 'WORKING';
  const awaiting = pendingOwnerMessages();
  const active = running ? awaiting.filter(m => now - Date.parse(m.at) < AWAIT_REPLY_MS) : [];
  const pending = active.map(m => m.id);
  return {
    type: 'billion-status',
    text: said && now - said.at < STATUS_TTL_MS ? said.text : '',
    running,
    working,
    workers,
    nextRoundAt,
    awaitingReply: pending.length > 0,
    // The owner's messages shown as pending, and the step log under each.
    pending,
    currentRequest: awaiting[0]?.id ?? null,
    steps: [], // Compatibility with older clients; raw screen lines are never sent.
    progress: Object.fromEntries(awaiting.map(m => [m.id, m.workDetails || []])),
  };
}

// Sent when it changed since the last one; the 10 s tick and every change call it.
export function publishStatus(broadcast, now = Date.now()) {
  const payload = statusPayload(now);
  const key = JSON.stringify(payload);
  if (key === last) return false;
  last = key;
  broadcast?.(payload);
  return true;
}

// For the tests: a fresh run.
export function _resetStatus() {
  said = null;
  facts = () => ({});
  last = '';
  seen.clear();
}
