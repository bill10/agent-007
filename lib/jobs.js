// Pure job-board logic — schema, dispatch selection, PR parsing, status derivation.
// Kept free of I/O and shared state so it is testable in isolation; the stateful
// dispatcher (timers, spawning, git) lives in server/jobs.js.

import { randomBytes } from 'crypto';

// Every state a job can be in. A job's *state* is workflow position only —
// "the agent is stuck waiting for you" is deliberately NOT a state here (see
// deriveJobStatus): it is a live property of the agent, not a place the card
// moves to.
//
// `done` is the one state with no column. A job whose PR has merged is finished
// work, and leaving its card on the board means the Review column slowly fills
// with things nobody has to look at again — the column stops meaning "needs
// your review". The job itself is kept, not deleted: it is the record of what
// an agent did and where the PR is, reachable through the Finished jobs view.
export const JOB_STATES = ['todo', 'in-progress', 'review', 'done'];

// Defaults for the dispatcher. Exported so the UI can show them and tests can
// override without touching module state.
export const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;  // scan cadence
export const MAX_AGENTS_PER_REPO = 2;               // concurrent board agents
export const STALLED_AFTER_MS = 3 * 60 * 1000;      // quiet WAITING -> "stalled"

// Board agents run in auto mode: the classifier decides what is safe to do
// unattended and escalates the rest to the user, which is what a job agent
// needs — it is working alone in its own worktree on a throwaway branch, and
// everything it produces lands in a reviewable PR.
export const DEFAULT_PERMISSION_MODE = 'auto';

// The modes `claude --permission-mode` accepts. buildJobCommand interpolates
// this value into a command string that parseCommand splits into argv, so an
// unvalidated value from the wire becomes extra FLAGS on the spawned agent
// (e.g. "auto --dangerously-skip-permissions"). No shell is involved, so this
// is not shell injection — but it is argv injection, and the allowlist closes
// it. Keep in sync with `claude --permission-mode` choices.
export const PERMISSION_MODES = [
  'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan',
];

export function isValidPermissionMode(mode) {
  return PERMISSION_MODES.includes(mode);
}

// Branch name derived from the job title, so a glance at `git branch` says what
// each branch is for. The `<gituser>/` prefix is added by createWorktree.
//
// Kept to [a-z0-9-] and length-bounded: that side-steps every git ref rule at
// once (no `..`, no leading `-`, no `~^:?*[`, no trailing `.lock`) rather than
// trying to enumerate them, and keeps the name readable in a branch listing.
export const MAX_BRANCH_SLUG_LEN = 40;

export function branchSlugFromTitle(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BRANCH_SLUG_LEN)
    .replace(/-+$/, '');           // a trim mid-word can leave a trailing dash
  // A title of only punctuation or non-Latin script slugs to nothing; a job
  // still needs a branch, so fall back rather than failing the dispatch.
  return slug || 'job';
}

export function newJobId() {
  return `job-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

// Bound the stored text so a paste of a whole log file can't bloat config.json.
export const MAX_TITLE_LEN = 200;
export const MAX_DETAIL_LEN = 20000;

export function createJob({ title, detail, repoPath, postedBy, postedByName, postedByAgent }) {
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  if (!cleanTitle) return { error: 'Title is required' };
  if (!repoPath) return { error: 'Repository is required' };
  return {
    job: {
      id: newJobId(),
      title: cleanTitle,
      detail: String(detail || '').trim().slice(0, MAX_DETAIL_LEN),
      repoPath,
      state: 'todo',
      // Who posted it and when (requirement 3).
      postedBy: postedBy || null,
      postedByName: postedByName || null,
      // Set when an agent typed the card on a person's behalf, via the board's
      // MCP tool. Kept separate from postedByName rather than folded into it:
      // postedBy* is the human the work belongs to, and the board still needs
      // to show that a machine, not they, put it there.
      postedByAgent: postedByAgent || null,
      postedAt: new Date().toISOString(),
      // Who is working on it and when they started (requirement 3). Null until
      // dispatched; kept after the PR lands so Review cards still show credit.
      agentSessionId: null,
      agentName: null,
      startedAt: null,
      branchName: null,
      worktreePath: null,
      prUrl: null,
      prNumber: null,
      reviewAt: null,
      // Why the board cannot check for this job's PR, when that is the case.
      // Separate from lastError: both can be true at once, and one must not
      // silence the other.
      prCheckError: null,
      prCheckErrorAt: null,
      // When the PR merged, and when the card left the board. Separate because
      // they answer different questions: prMergedAt is a fact about GitHub and
      // is what stops the merge sweep re-finishing a job the user has manually
      // put back on the board; doneAt is when this board stopped showing it.
      prMergedAt: null,
      doneAt: null,
    },
  };
}

// --- Dispatch selection ---

// How many jobs a repo currently has in flight. A job's agent is always closed
// when its PR opens, so in-progress jobs and live board agents are the same
// set — counting jobs is enough, and there is no second source of truth to keep
// in sync.
//
// One exclusion: a job whose agent has died. A session that no longer exists
// cannot be occupying a slot, and cards are deliberately never auto-reverted to
// To do, so without this a single crashed agent would block its repo forever.
export function countInFlightByRepo(jobs, liveSessionIds = null) {
  const counts = new Map();
  for (const job of jobs) {
    if (job.state !== 'in-progress') continue;
    if (liveSessionIds && !liveSessionIds.has(job.agentSessionId)) continue;
    counts.set(job.repoPath, (counts.get(job.repoPath) || 0) + 1);
  }
  return counts;
}

export function selectDispatchableJobs(jobs, { maxPerRepo = MAX_AGENTS_PER_REPO, availableRepos = null, liveSessionIds = null } = {}) {
  const counts = countInFlightByRepo(jobs, liveSessionIds);
  const selected = [];
  const todo = jobs
    .filter(j => j.state === 'todo')
    .sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
  for (const job of todo) {
    // A repo that has been removed (or whose path vanished) can't be spawned
    // into; leave the job queued rather than failing it.
    if (availableRepos && !availableRepos.has(job.repoPath)) continue;
    const inFlight = counts.get(job.repoPath) || 0;
    if (inFlight >= maxPerRepo) continue;
    counts.set(job.repoPath, inFlight + 1);
    selected.push(job);
  }
  return selected;
}

// --- Prompt ---

// Delivered as a single argv to `claude`, never as simulated keystrokes, so it
// cannot race whatever the TUI happens to be showing. The preamble nudges the
// agent toward assumptions over questions (each question is a stall the user
// has to come clear by hand), points it at /ship as the single finishing step —
// /ship already merges, tests, reviews and fix-loops internally, so anything
// run ahead of it pays for that work twice — and tells it how the job gets
// marked done. It deliberately does not name the skills /ship subsumes: a
// dispatched agent arrives with no memory of them, and naming one to forbid it
// is what puts it on the table.
export function buildJobPrompt(job) {
  const parts = [job.title];
  if (job.detail) parts.push('', job.detail);
  parts.push(
    '',
    '---',
    'This task was dispatched from the Agent 007 job board. You are in a dedicated',
    'git worktree on your own branch, so work directly here.',
    '',
    'Prefer making a reasonable assumption over asking a question — every question',
    'stalls the job until a human notices. Record any assumptions you made in the',
    'pull request description.',
    '',
    'When the work is finished, run /ship. It is the whole path from there to the',
    'pull request, so nothing else needs running first.',
    '',
    'The board watches for the pull request /ship opens and moves this job to',
    'Review when it appears.',
    '',
    'Do not end your turn until /ship has opened that pull request. There is no',
    'one waiting to read a progress report and tell you to continue — if you stop',
    'to describe what you would do next, the job simply stalls there. If you find',
    'yourself about to write a summary ending in what comes next, do that thing',
    'instead. The only reasons to stop early are a question you genuinely cannot',
    'answer yourself, or a failure you cannot get past.',
  );
  return parts.join('\n');
}

export function buildJobCommand(job, { permissionMode = DEFAULT_PERMISSION_MODE } = {}) {
  // Validated here as well as at the settings boundary: this is the function
  // that builds the argv, so it is the last place that can guarantee the mode
  // is a single token and not a smuggled second flag.
  const mode = isValidPermissionMode(permissionMode) ? permissionMode : DEFAULT_PERMISSION_MODE;
  // Double quotes with escaped inner quotes/backslashes: parseCommand() in
  // helpers.js unescapes exactly this form.
  const escaped = buildJobPrompt(job).replace(/([\\"])/g, '\\$1');
  return `claude --permission-mode ${mode} "${escaped}"`;
}

// --- Live status (derived, never stored) ---

// Why derived: the card's workflow state is durable, but "needs you" is a fact
// about a live PTY that changes second to second and is meaningless once the
// server restarts. Storing it would guarantee a stale badge.
export function deriveJobStatus(job, session, { now = Date.now(), stalledAfterMs = STALLED_AFTER_MS } = {}) {
  if (job.state !== 'in-progress') return null;
  if (!session || session.exited) return 'gone';
  // MESSAGE is already exactly "agent is asking the user something" — the same
  // signal that turns the tab dot orange and gives the office character a
  // thought bubble (see MESSAGE_PATTERNS in lib/helpers.js).
  if (session.state === 'MESSAGE') return 'needs-input';
  // A TUI agent parked at its prompt reads as WAITING whether it asked a prose
  // question or quietly finished without opening a PR. Both need a human, so
  // both surface once the quiet window passes.
  if (session.state === 'WAITING' && (now - (session.lastOutputAt || 0)) > stalledAfterMs) return 'stalled';
  return 'running';
}

// --- PR detection ---

// The two `gh pr list` queries the board runs, each kept beside the parser that
// reads its output so the requested --json fields and the fields the parser
// reads cannot drift apart. `--state` is the load-bearing part of each: it is
// the difference between "is there a PR to review" and "did that PR land", and
// getting the merged one wrong (--state closed) would take cards off the board
// for work that never shipped. Pure, so both are pinned by a test.
export function openPrListArgs(branchName) {
  return ['pr', 'list', '--head', branchName, '--state', 'open', '--json', 'number,url,state,isDraft'];
}

export function mergedPrListArgs(branchName) {
  return ['pr', 'list', '--head', branchName, '--state', 'merged', '--json', 'number,url,state,mergedAt'];
}

// Parses `gh pr list --head <branch> --json number,url,state,isDraft`. Returns
// the first OPEN pr, or null. Drafts count: opening a draft PR is still the
// author saying "this is ready to look at".
export function parsePrList(stdout) {
  let list;
  try { list = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const open = list.find(pr => !pr.state || String(pr.state).toUpperCase() === 'OPEN');
  if (!open) return null;
  return { url: open.url || null, number: open.number ?? null, isDraft: !!open.isDraft };
}

// Parses `gh pr list --head <branch> --state merged --json number,url,state,mergedAt`.
// Returns the merged PR that belongs to THIS job, or null.
//
// The identity check is the whole point, because `--head` matches the head ref
// NAME and that name outlives the branch. A merged PR stays in the listing
// forever, and board branch names are reused: the branch is deleted when its
// agent is retired, which frees the name both locally and (with GitHub's
// delete-on-merge) on the remote, so the next job with the same title gets it
// back. "Some PR on this branch merged" is therefore NOT "this card's PR
// merged", and treating them as the same files a card away for work that is
// still open — taking its PR number with it.
//
//  - `number`: the card's PR of record. When it has one, only that PR can
//    finish it. Nothing else on the branch is this card's PR.
//  - `mergedAfter`: for a card with no PR of record, the earliest merge that
//    could plausibly be its work (when its agent started, or when it reached
//    Review). An older merge belongs to whatever used this branch name before.
//    A PR with no mergedAt cannot be placed in time, so it is rejected — the
//    cost of that is a card staying on the board, which is the safe direction.
//
// `--state merged` already filters server-side; the merged check here is
// belt-and-braces, because a PR CLOSED without merging must never finish a job:
// nothing landed, and someone still has to decide what to do with the work.
export function parseMergedPr(stdout, { number = null, mergedAfter = null } = {}) {
  let list;
  try { list = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(list)) return null;

  const isMerged = pr => !!pr && (pr.mergedAt || String(pr.state || '').toUpperCase() === 'MERGED');
  const shape = pr => ({ url: pr.url || null, number: pr.number ?? null, mergedAt: pr.mergedAt || null });

  if (number != null) {
    const exact = list.find(pr => isMerged(pr) && pr.number === number);
    return exact ? shape(exact) : null;
  }

  const floor = mergedAfter ? Date.parse(mergedAfter) : NaN;
  const candidate = list.find((pr) => {
    if (!isMerged(pr)) return false;
    if (Number.isNaN(floor)) return true;      // nothing to compare against
    const at = Date.parse(pr.mergedAt || '');
    return !Number.isNaN(at) && at >= floor;
  });
  return candidate ? shape(candidate) : null;
}
