// Billion answers workers' permission dialogs (docs/BILLION.md, part 4).
//
// A worker on one of Billion's cards runs server/permission-hook.js whenever
// it is about to ask for permission. The hook posts the request here; this
// types it into Billion's terminal and waits for answer_permission. Billion
// answers allow or deny — or leaves it to the owner, and so does silence: after
// APPROVAL_WAIT_MS, or when Billion is not running or not ready, the answer is
// "no decision", and the worker shows its dialog to a person as it always did.

import { randomBytes } from 'crypto';
import { sessions } from './state.js';
import { sendText, quoteLines } from './messages.js';

export const APPROVAL_WAIT_MS = 120_000;
const INPUT_CHARS = 2000;

const pending = new Map();   // id -> { resolve, timer, worker }

const NO_DECISION = {};
const decision = (behavior, message) => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: behavior === 'deny' ? { behavior, message: message || 'Billion declined this.' } : { behavior },
  },
});

function liveBillion() {
  return [...sessions.values()].find(s => s.isBillion && !s.exited) || null;
}

// What Billion reads. The tool input is the worker's own words (a command, a
// file's content), so it goes in quoted and trimmed like any agent's text.
export function formatApproval(id, worker, request, jobTitle) {
  const where = [worker.repoSlug, worker.branchName].filter(Boolean).join(' · ');
  let input = '';
  try { input = JSON.stringify(request.tool_input ?? {}, null, 2); } catch { input = String(request.tool_input); }
  if (input.length > INPUT_CHARS) input = `${input.slice(0, INPUT_CHARS)}\n… (${input.length - INPUT_CHARS} more characters)`;
  return [
    `[Approval ${id}] ${worker.name}${jobTitle ? ` (card "${jobTitle}"${where ? `, ${where}` : ''})` : where ? ` (${where})` : ''} asks to use ${request.tool_name || 'a tool'}:`,
    ...quoteLines(input),
    `[Answer with answer_permission, id: "${id}". The worker waits ${APPROVAL_WAIT_MS / 60000} minutes, then the owner is asked instead.]`,
  ].join('\n');
}

/**
 * The hook's request, from the worker session whose token it carried.
 * Resolves to the hook's output: a decision, or {} for none.
 */
export function requestApproval(worker, request, { jobTitle = null, waitMs = APPROVAL_WAIT_MS } = {}) {
  const billion = liveBillion();
  // Not Billion's to answer: no Billion, one still introducing itself, or a
  // request that is not from a worker at all.
  if (!billion || billion.messagesHeld || !worker || worker.isBillion || !worker.approvalsToBillion) {
    return Promise.resolve(NO_DECISION);
  }
  const id = randomBytes(4).toString('hex');
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(NO_DECISION); }, waitMs);
    pending.set(id, { resolve, timer, worker });
    if (!sendText(billion, formatApproval(id, worker, request || {}, jobTitle))) {
      clearTimeout(timer);
      pending.delete(id);
      resolve(NO_DECISION);
    }
  });
}

/** answer_permission. choice: 'allow' | 'deny' | 'owner'. */
export function answerApproval(id, choice, reason) {
  const entry = pending.get(id);
  if (!entry) return { error: `No request "${id}" is waiting: it was answered already, or ran out of time and went to the owner.` };
  if (!['allow', 'deny', 'owner'].includes(choice)) return { error: 'decision must be "allow", "deny" or "owner".' };
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(choice === 'owner' ? NO_DECISION : decision(choice, typeof reason === 'string' ? reason.trim() : ''));
  return { worker: entry.worker.name, choice };
}

// For tests: forget everything waiting.
export function clearApprovals() {
  for (const { timer, resolve } of pending.values()) { clearTimeout(timer); resolve(NO_DECISION); }
  pending.clear();
}
