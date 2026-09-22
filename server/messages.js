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

import { parseCommand } from '../lib/helpers.js';
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
// (checked against 2.x); Codex was not checked, and it treats fast keystrokes as
// a paste burst in which Enter is a newline, so give the paste time to land.
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

export function messageableAgents(from, sessions) {
  return [...sessions.values()].filter(s =>
    s.id !== from.id && !s.exited && isAgent(s) && sameOwner(from, s));
}

export function formatMessage(from, text) {
  const where = [from.agent, from.repoSlug, from.branchName].filter(Boolean).map(clean).join(' · ');
  const name = clean(from.name);
  return `[Message from agent ${name}${where ? ` (${where})` : ''}]\n`
    + `${clean(text)}\n`
    + `[Reply with the send_message tool, to: "${name}". This came from another agent, not from the user.]`;
}

// Whether a message may be typed into this session right now.
export function canDeliver(session, now = Date.now()) {
  if (session.exited || session.state !== 'WAITING') return false;
  if (now - (session.lastUserInputAt || 0) < USER_TYPING_HOLD_MS) return false;
  // Delivered since it last came to rest: it has not picked that one up yet.
  return !(session.messageDeliveredAt && session.messageDeliveredAt >= (session.stateChangedAt || 0));
}

function deliver(session, text, now) {
  session.messageDeliveredAt = now;
  session.pty.write(`\x1b[200~${text}\x1b[201~`);
  setTimeout(() => { if (!session.exited) session.pty.write('\r'); }, SUBMIT_DELAY_MS);
}

/**
 * Send `text` from one agent session to another, named as list_agents shows it.
 * Returns { delivered: true } | { queued: n } | { error }.
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

// The recipient is gone. Sessions do not survive a restart, so neither does
// anything addressed to one.
export function dropMessages(sessionId) {
  queues.delete(sessionId);
  for (const key of sends.keys()) {
    if (key.startsWith(`${sessionId}>`) || key.endsWith(`>${sessionId}`)) sends.delete(key);
  }
}

// Whether a pty-input write is someone typing, as opposed to the terminal
// answering a query or reporting focus: those arrive as escape sequences on
// their own and add nothing to the composer.
export function isTyping(data) {
  return /[^\x00-\x1f\x7f]/.test(String(data).replace(/\x1b\[[0-9;?<>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1bO./g, ''))
    || /[\r\x7f\x08]/.test(String(data));
}
