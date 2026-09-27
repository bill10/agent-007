// HANDOVER.md: what Billion was saying when it moved from one CLI to the
// other (docs/BILLION.md, "Claude Code or Codex").
//
// Neither CLI can read the other's conversation, so at a switch the server
// copies the end of the old one into Billion's folder as plain text, read off
// the transcript the old CLI left behind. No model: the last messages as they
// were, not a summary. STATE.md stays the plan; this is only the thread.
//
// Not committed (server/billion.js keeps it out of git): it is the raw
// conversation, which can hold whatever the owner typed, and it is replaced
// at every switch, so in Billion's history it would be noise.

import { openSync, readSync, fstatSync, closeSync, writeFileSync } from 'fs';
import { join } from 'path';
import { newestTranscriptFile } from './agent-transcripts.js';

export const HANDOVER_FILE = 'HANDOVER.md';
export const HANDOVER_MESSAGES = 20;
const MESSAGE_CHARS = 2000;
// Only the end of a transcript is read: a long conversation runs to many
// megabytes, and the last twenty messages are near its end.
const TAIL_BYTES = 4 * 1024 * 1024;

export const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex' };

// Text the CLI typed into the conversation itself, not the owner or Billion:
// Codex's AGENTS.md and environment blocks, Claude Code's command echoes and
// reminders. All of them start with a tag or AGENTS.md's heading.
const CLI_TEXT = /^\s*(<[A-Za-z][\w-]*[\s>]|# AGENTS\.md instructions)/;

function readTail(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A cut start is half a line.
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

const texts = (content, types) => (typeof content === 'string' ? [content]
  : Array.isArray(content) ? content.filter(c => types.includes(c?.type) && typeof c.text === 'string').map(c => c.text) : []);

// One transcript line as { role, text }, or null for anything that is not a
// message the owner or Billion would recognise: tool calls and results,
// thinking, the CLI's own bookkeeping.
function claudeMessage(entry) {
  if (!['user', 'assistant'].includes(entry?.type) || entry.isMeta || entry.isSidechain) return null;
  return { role: entry.type, parts: texts(entry.message?.content, ['text']) };
}

function codexMessage(entry) {
  const p = entry?.type === 'response_item' ? entry.payload : null;
  if (p?.type !== 'message' || !['user', 'assistant'].includes(p.role)) return null;
  return { role: p.role, parts: texts(p.content, ['input_text', 'output_text']) };
}

// The last `limit` messages of a transcript's lines, oldest first. A CLI
// writes one message as several lines (Claude Code: one per content block),
// so neighbours with the same role are joined.
export function transcriptMessages(agent, text, limit = HANDOVER_MESSAGES) {
  const read = agent === 'codex' ? codexMessage : claudeMessage;
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = read(entry);
    const body = msg?.parts.filter(t => t.trim() && !CLI_TEXT.test(t)).join('\n\n').trim();
    if (!body) continue;
    const last = out[out.length - 1];
    if (last?.role === msg.role) last.text += `\n\n${body}`;
    else out.push({ role: msg.role, text: body });
  }
  return out.slice(-limit).map(m => ({
    ...m, text: m.text.length > MESSAGE_CHARS ? `${m.text.slice(0, MESSAGE_CHARS)} […]` : m.text,
  }));
}

export function handoverText({ from, to, file, messages, now = new Date() }) {
  const move = to && to !== from
    ? `when Billion moved from ${CLI_NAMES[from]} to ${CLI_NAMES[to]}`
    : `on request, from Billion's ${CLI_NAMES[from]} conversation`;
  const head = [
    '# Handover',
    '',
    `Written by Agent 007 on ${now.toISOString()} ${move}.`,
    '',
    'Read `STATE.md` first: it is your plan. Then this file, the end of your last',
    'conversation as plain text, then `git log -10` for your recent decisions.',
    'This file is not committed, and the next switch replaces it.',
    '',
  ];
  if (!file) return [...head, `No ${CLI_NAMES[from]} conversation was found for this folder, so there is nothing to hand over beyond STATE.md.`, ''].join('\n');
  const who = { user: 'Typed in (the owner, or mail from the board and agents)', assistant: 'Billion' };
  const body = messages.flatMap(m => [`### ${who[m.role]}`, '', ...m.text.split('\n').map(l => `> ${l}`.trimEnd()), '']);
  return [...head, `From \`${file}\`.`, '', `## The last ${messages.length} messages`, '', ...body].join('\n');
}

// Writes BILLION_DIR/HANDOVER.md from `from`'s newest conversation in `dir`.
// `homes` is for tests, which must not read the developer's own transcripts.
export function writeHandover(dir, { from, to, homes, now } = {}) {
  const file = newestTranscriptFile(from, dir, homes);
  const messages = file ? transcriptMessages(from, readTail(file)) : [];
  const path = join(dir, HANDOVER_FILE);
  writeFileSync(path, handoverText({ from, to, file, messages, now }));
  return { path, messages: messages.length };
}
