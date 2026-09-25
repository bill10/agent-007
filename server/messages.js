// Agent-to-agent messages — how a Claude Code agent and a Codex agent (or any
// two of either) talk to each other.
//
// A message is typed into the recipient's terminal as a user turn. Neither CLI
// has an inbox this app could fill, and an agent never polls one, so typing it
// in is the only delivery both of them actually act on. That makes WHEN it is
// typed the whole design:
//
//  - only while the recipient rests at its prompt (WAITING). In MESSAGE a
//    dialog is on screen and the Enter would answer it — a permission prompt,
//    or a trust dialog that then saves the folder as trusted;
//  - not while a person is typing in that terminal, or their half-written
//    line would be sent with the message glued on;
//  - once per stop: the next message waits until the agent has taken the
//    last one and come back to its prompt.
//
// Anything that cannot go now waits in a per-session queue, which updateState
// (server/pty.js) retries every second. Kept free of node-pty and of the
// session Map so it is testable on its own: sessions come in as parameters.

import { parseCommand, detectState } from '../lib/helpers.js';
import { permissionFlagsFromCommand, sessionAgentFromCommand } from '../lib/jobs.js';
import { takesMcpConfig } from './agent-mcp.js';

export const MAX_MESSAGE_CHARS = 8000;
export const QUEUE_CAP = 20;
export const PAIR_LIMIT = 10;
export const PAIR_WINDOW_MS = 10 * 60 * 1000;
// ponytail: a quiet window, not real composer detection — neither CLI says
// whether its composer is empty. A person who stops typing mid-line for 30 s
// still gets the message appended to what they typed.
export const USER_TYPING_HOLD_MS = 30 * 1000;
// Between the paste and its Enter. Claude Code submits with no gap at all
// (checked against 2.x). Codex treats fast keystrokes as a paste burst in which
// Enter is a newline; with this gap codex-cli 0.155.1 takes paste and Enter as
// one turn (checked in review).
export const SUBMIT_DELAY_MS = 150;

const queues = new Map();   // recipient session id -> [formatted text]
const sends = new Map();    // `${from.id}>${to.id}` -> [timestamps]

// Everything but newline and tab. The text goes inside a bracketed paste, and a
// message carrying ESC[201~ would end the paste early and type the rest as raw
// keystrokes — arrow keys, Enter, whatever it liked.
const clean = (s) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

const sameOwner = (a, b) => (a.ownerId || null) === (b.ownerId || null);

// A plain shell tab would run the message as a command line.
const isAgent = (session) => takesMcpConfig(parseCommand(session.command || '').file);

// An agent that runs commands without asking anyone. A message is a prompt it
// acts on with its own permissions, so if any agent could message one, every
// agent could borrow them — a read-only job reading an untrusted issue could
// have it run whatever the issue said. Only another such agent may.
//
// ponytail: read off the command line only. A bare `claude` whose settings.json
// defaults to bypassPermissions, or a `codex` whose config.toml never asks,
// reads as guarded here; the user's own config usually applies to the sender
// too, but a repo's .claude/settings.json does not.
export function isUnguarded(session) {
  const command = session.command || '';
  const flags = permissionFlagsFromCommand(command);
  const value = (flag) => { const i = flags.indexOf(flag); return i === -1 ? undefined : flags[i + 1]; };
  if (flags.includes('--dangerously-skip-permissions') || value('--permission-mode') === 'bypassPermissions') return true;
  if (flags.includes('--dangerously-bypass-approvals-and-sandbox') || flags.includes('--approve-for-me')
    || value('--sandbox') === 'danger-full-access' || value('--ask-for-approval') === 'never') return true;
  if (sessionAgentFromCommand(command) !== 'codex') return false;
  // Codex also takes config overrides and profiles, which can set any of the
  // above where the allowlist cannot see it. What they set is unknown, so any
  // of them counts as never asking.
  const { args } = parseCommand(command);
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end))
    .some(a => /^(-c|--config|-p|--profile|--full-auto)(=|$)/.test(a) || /^-c\S/.test(a));
}

// Billion (server/billion.js) is the exception both rules make: every agent
// may message it. It is the one agent everyone reports to, it belongs to no
// one, and it never asks before acting — so a worker that read untrusted text
// can pass that text on to an agent with full access. Accepted in the design
// (docs/BILLION.md): messages arrive labelled as coming from an agent, and its
// charter treats them as information, never as instructions.
export function messageableAgents(from, sessions) {
  const fromUnguarded = isUnguarded(from);
  return [...sessions.values()].filter(s =>
    s.id !== from.id && !s.exited && isAgent(s)
    && (s.isBillion || (sameOwner(from, s) && (fromUnguarded || !isUnguarded(s)))));
}

// Header fields lose newlines as well: a name is renamable, and one carrying a
// newline could start a line of its own outside the quoted body.
export const oneLine = (s) => clean(s).replace(/[\n\t]/g, ' ');

export function formatMessage(from, text) {
  const where = [from.agent, from.repoSlug, from.branchName].filter(Boolean).map(oneLine).join(' · ');
  const name = oneLine(from.name);
  // Every body line quoted, so a body cannot close the message with a footer
  // of its own and carry on as if it were the user speaking.
  const body = quoteLines(text).join('\n');
  return `[Message from agent ${name}${where ? ` (${where})` : ''}]\n`
    + `${body}\n`
    + `[Reply with the send_message tool, to: "${name}". This came from another agent, not from the user.]`;
}

// Agent text, quoted line by line so it cannot pass for anything but a quote.
export function quoteLines(text) {
  return clean(text).split('\n').map(line => `> ${line}`);
}

// A board notice: from the server, not an agent, so it names the board and
// carries no reply line. Quoted like a message body, since a card's summary is
// an agent's text.
export function formatNotice(headline, lines = []) {
  return [`[Job board] ${oneLine(headline)}`, ...lines.flatMap(quoteLines),
    '[This came from the Agent 007 job board, not the user.]'].join('\n');
}

// Queue text the server wrote (a board notice, an approval request) and
// deliver it when the session can take one. Not agent-to-agent, so neither
// the permission rule nor the pair limit applies; the queue cap does, and
// text over it is refused.
//
// Cleaned here, whoever wrote it: it goes into a bracketed paste, and a stray
// ESC[201~ anywhere in it — a tool name, a card title — would end the paste
// and type the rest as keystrokes of the user's own.
export function sendText(session, text, now = Date.now()) {
  if (!session || session.exited) return false;
  const queue = queues.get(session.id) || [];
  if (queue.length >= QUEUE_CAP) return false;
  queue.push(clean(text));
  queues.set(session.id, queue);
  flushMessages(session, now);
  return true;
}

// Take back text still waiting in a session's queue (an approval request that
// expired before it was typed).
export function unqueueText(sessionId, text) {
  const queue = queues.get(sessionId);
  const at = queue ? queue.indexOf(clean(text)) : -1;
  if (at === -1) return false;
  queue.splice(at, 1);
  if (!queue.length) queues.delete(sessionId);
  return true;
}

// A notice over the cap is dropped: the board still has the card.
export function sendNotice(session, headline, lines, now = Date.now()) {
  return sendText(session, formatNotice(headline, lines), now);
}

// Whether a message may be typed into this session right now.
export function canDeliver(session, now = Date.now()) {
  // Billion holds its mail until it says it is ready (billion_ready), so
  // nothing lands in the middle of its introduction.
  if (session.messagesHeld) return false;
  // Both: the stored state is up to a second old, and a dialog that opened
  // since is what this must not type into.
  if (session.exited || session.state !== 'WAITING' || detectState(session, { now }) !== 'WAITING') return false;
  if (now - (session.lastUserInputAt || 0) < USER_TYPING_HOLD_MS) return false;
  // A message left in the composer, its Enter skipped: another pasted after it
  // would be submitted with it. Held until a person has been at that terminal.
  if (session.messageUnsubmittedAt && (session.lastUserInputAt || 0) <= session.messageUnsubmittedAt) return false;
  // Delivered since it last came to rest: it has not picked that one up yet.
  return !(session.messageDeliveredAt && session.messageDeliveredAt >= (session.stateChangedAt || 0));
}

// From a timer or the state interval, so a pty torn down but not yet marked
// exited must not throw: nothing up the stack would catch it.
function write(session, data) {
  try { session.pty.write(data); return true; } catch { return false; }
}

function deliver(session, text, now) {
  session.messageDeliveredAt = now;
  write(session, `\x1b[200~${text}\x1b[201~`);
  // Checked again at the Enter: in those 150 ms a dialog may have opened, which
  // the Enter would answer, or a person may have started typing, whose text
  // would go with it. Left unsent, the message sits in the composer instead.
  // The screen is read afresh rather than through session.state, which lags a
  // second behind and reads WORKING for three after any output — the paste's
  // own echo included.
  setTimeout(() => {
    if (session.exited) return;
    if (detectState(session, { stateTimeoutMs: 0 }) === 'MESSAGE' || (session.lastUserInputAt || 0) > now) {
      session.messageUnsubmittedAt = Date.now();
      return;
    }
    write(session, '\r');
  }, SUBMIT_DELAY_MS);
}

/**
 * Send `text` from one agent session to another, named as list_agents shows it.
 * Returns { delivered: true, to } | { queued: n, to } | { error }, `to` being
 * the recipient session.
 */
export function sendMessage({ from, to, text, sessions, now = Date.now() }) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { error: 'The message is empty.' };
  if (body.length > MAX_MESSAGE_CHARS) {
    return { error: `The message is ${body.length} characters; the limit is ${MAX_MESSAGE_CHARS}.` };
  }
  const reachable = messageableAgents(from, sessions);
  const target = reachable.find(s => s.name === to);
  if (!target) {
    const names = reachable.map(s => s.name).join(', ');
    return { error: `No agent named "${to}" you can message. ${names ? `Agents you can reach: ${names}.` : 'There are no other agents running.'}` };
  }

  // Two agents that each answer every message would talk for ever.
  const key = `${from.id}>${target.id}`;
  const recent = (sends.get(key) || []).filter(t => now - t < PAIR_WINDOW_MS);
  if (recent.length >= PAIR_LIMIT) {
    return { error: `You have sent ${target.name} ${PAIR_LIMIT} messages in the last ${PAIR_WINDOW_MS / 60000} minutes, which is the limit. Tell the user what you need from ${target.name} instead.` };
  }
  const queue = queues.get(target.id) || [];
  if (queue.length >= QUEUE_CAP) {
    return { error: `${target.name} already has ${QUEUE_CAP} messages waiting for it. Try again once it has caught up.` };
  }

  recent.push(now);
  sends.set(key, recent);
  queue.push(formatMessage(from, body));
  queues.set(target.id, queue);
  return flushMessages(target, now) ? { delivered: true, to: target } : { queued: queue.length, to: target };
}

// Type the next waiting message into this session if it can take one now.
// Returns whether one was written. Called on every state check, so cheap when
// the queue is empty.
export function flushMessages(session, now = Date.now()) {
  const queue = queues.get(session.id);
  if (!queue?.length || !canDeliver(session, now)) return false;
  deliver(session, queue.shift(), now);
  if (!queue.length) queues.delete(session.id);
  return true;
}

export function pendingMessages(sessionId) {
  return queues.get(sessionId)?.length || 0;
}

// What list_agents shows about each agent `from` can reach. Picked, not
// spread: a session carries its pty and its board token. The job title comes
// in as a function so this module stays clear of the job store.
export function agentSummaries(from, sessions, jobTitle = () => null) {
  return messageableAgents(from, sessions).map(s => ({
    name: s.name, agent: s.agent, repoSlug: s.repoSlug, branchName: s.branchName, state: s.state,
    jobTitle: s.jobId ? jobTitle(s.jobId) : null,
    pending: pendingMessages(s.id),
  }));
}

// The recipient is gone. Sessions do not survive a restart, so neither does
// anything addressed to one.
export function dropMessages(sessionId) {
  queues.delete(sessionId);
  for (const key of sends.keys()) {
    if (key.startsWith(`${sessionId}>`) || key.endsWith(`>${sessionId}`)) sends.delete(key);
  }
}

// Whether a pty-input write is someone typing, as opposed to the terminal
// answering a query or reporting focus. Only those replies are left out;
// anything else counts, arrow keys and Tab included, since up-arrow recalls a
// history line into the composer as surely as typing it would.
const TERMINAL_REPLY_RE = new RegExp([
  /\x1b\[[IO]/.source,                        // focus in / out
  /\x1b\[\d+;\d+R/.source,                     // cursor position report
  /\x1b\[[?>=][\d;]*c/.source,                 // device attributes
  /\x1b\[\?[\d;]*\$y/.source,                  // mode report
  /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.source,     // OSC: colour and title replies
  /\x1bP[^\x1b]*\x1b\\/.source,                // DCS: terminal version and the like
].join('|'), 'g');

export function isTyping(data) {
  return String(data).replace(TERMINAL_REPLY_RE, '').length > 0;
}
