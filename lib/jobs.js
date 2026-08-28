// Pure job-board logic — schema, dispatch selection, PR parsing, status derivation.
// Kept free of I/O and shared state so it is testable in isolation; the stateful
// dispatcher (timers, spawning, git) lives in server/jobs.js.

import { randomBytes } from 'crypto';

// The three workflow states, in board order. A job's *state* is workflow
// position only — "the agent is stuck waiting for you" is deliberately NOT a
// state here (see deriveJobStatus): it is a live property of the agent, not a
// place the card moves to.
export const JOB_STATES = ['todo', 'in-progress', 'review'];

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
// has to come clear by hand) and tells it how the job gets marked done.
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
    'When the work is finished: run /review, fix, re-review, then /ship. The board',
    'watches for the pull request /ship opens and moves this job to Review when it',
    'appears.',
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
