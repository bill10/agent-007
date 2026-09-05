// Pure job-board logic — schema, dispatch selection, PR parsing, status derivation.
// Kept free of I/O and shared state so it is testable in isolation; the stateful
// dispatcher (timers, spawning, git) lives in server/jobs.js.

import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { nextCronIso, parseCron } from './cron.js';

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

// What each state is called when it is written out rather than drawn. The
// board's own columns carry these labels in public/modules/jobs.js, which the
// browser cannot import from here (only public/ is served), so a test keeps
// the two in step. `done` has no column — it is the Finished jobs archive.
export const STATE_LABELS = {
  'todo': 'To do',
  'in-progress': 'In progress',
  'review': 'Review',
  'done': 'Finished',
};

// What kind of work a card is.
//
//   one-time   the original job: dispatched once, moves to Review when its
//              pull request appears, and stays there.
//   scheduled  a standing card that fires on a cron schedule. It is dispatched
//              when it comes due, runs, and returns to To do with the next run
//              time on it — so it cycles To do -> In progress -> To do forever.
//
// Cards written before this existed have no `type` at all, so every read goes
// through jobType() rather than touching job.type directly: a missing type is
// one-time, which is what those cards have always been.
export const JOB_TYPES = ['one-time', 'scheduled'];
export const DEFAULT_JOB_TYPE = 'one-time';

export function jobType(job) {
  return job && job.type === 'scheduled' ? 'scheduled' : DEFAULT_JOB_TYPE;
}

export function isScheduled(job) {
  return jobType(job) === 'scheduled';
}

// Defaults for the dispatcher. Exported so the UI can show them and tests can
// override without touching module state.
export const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;  // scan cadence
export const MAX_AGENTS_PER_REPO = 2;               // concurrent board agents
export const STALLED_AFTER_MS = 3 * 60 * 1000;      // quiet WAITING -> "stalled"

// Board agents run in auto mode. The classifier that mode brings is the only
// thing that reviews a dispatched agent's actions before they run, and that
// matters more here than anywhere else in the app: a board agent's prompt is a
// job card's detail text plus whatever it reads out of the repo, none of which
// is necessarily trustworthy. Under `bypassPermissions` nothing reviews
// anything — the agent runs Bash and edits files unprompted, as the user (see
// the board-credential section of DESIGN.md).
//
// Auto mode is not available everywhere, which is why this is a default rather
// than the only setting. It needs a supported model and an organisation that
// has not turned it off, so on an Amazon Bedrock or Vertex account running an
// unsupported model, or behind `permissions.disableAutoMode`, it is missing —
// and Claude Code does NOT error or exit in that case: "When the flag, a
// settings file, or the built-in default selects auto but auto mode isn't
// available to the session, Claude Code starts the session in Manual instead"
// (docs/en/permission-modes). The agent spawns fine and works until it needs a
// permission, then waits for a human who is not there. Every job.
//
// That failure is a stall, not a crash: `deriveJobStatus` reports the card as
// `needs-input`, then `stalled` once the quiet window passes, so the board is
// not blind to it. Because it is visible AND there is now a lever — a board
// permission mode in the toolbar, and a per-card override on the form — `auto`
// is the right default again. A machine without the classifier sets the board
// setting once; a card that needs more says so on itself.
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

// A card's own permission mode, as it arrives from a form or an API call.
//
// `null` is a real third state and not a copy of the board's mode taken when
// the card was written: it means "whatever the board is set to at dispatch",
// so changing the board setting still moves every queued card that never asked
// for its own. An unrecognised mode is refused rather than quietly falling back
// to the default — the caller named a mode, and silently running something
// else is the wrong answer in both directions.
export function resolveJobPermissionMode(mode) {
  if (mode === undefined || mode === null || mode === '') return { permissionMode: null };
  if (!isValidPermissionMode(mode)) {
    return { error: `Unknown permission mode "${mode}" \u2014 expected one of: ${PERMISSION_MODES.join(', ')}` };
  }
  return { permissionMode: mode };
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

// Shared by createJob and updateJob: both have to answer "is this a valid
// (type, schedule) pair?", and a second copy of the rules would drift.
//
// A one-time job silently drops any schedule rather than refusing it. That is
// the edit path: switching a scheduled card back to one-time leaves the cron
// text sitting in the form field, and failing that save would be baffling.
export function resolveJobType({ type, schedule }) {
  const raw = typeof type === 'string' && type ? type : (schedule ? 'scheduled' : DEFAULT_JOB_TYPE);
  if (!JOB_TYPES.includes(raw)) {
    return { error: `Unknown job type "${raw}" — expected one of: ${JOB_TYPES.join(', ')}` };
  }
  if (raw !== 'scheduled') return { type: raw, schedule: null };
  // Trimmed but NOT truncated: parseCron owns the length rule, and slicing an
  // over-long string first would either hide that error or, worse, silently
  // store a valid-looking prefix of something the user did not write.
  const text = String(schedule || '').trim();
  const parsed = parseCron(text);
  if (parsed.error) return { error: parsed.error };
  return { type: 'scheduled', schedule: text };
}

export function newJobId() {
  return `job-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

// Bound the stored text so a paste of a whole log file can't bloat config.json.
export const MAX_TITLE_LEN = 200;
export const MAX_DETAIL_LEN = 20000;

export function createJob({ title, detail, repoPath, type, schedule, permissionMode, postedBy, postedByName, postedByAgent }) {
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  if (!cleanTitle) return { error: 'Title is required' };
  if (!repoPath) return { error: 'Repository is required' };
  // A caller that names no type but passes a schedule means a scheduled job:
  // the MCP tool and POST /api/jobs both take just `schedule`, so the rule that
  // turns one into the other lives here, once, rather than at each door.
  const resolved = resolveJobType({ type, schedule });
  if (resolved.error) return { error: resolved.error };
  const mode = resolveJobPermissionMode(permissionMode);
  if (mode.error) return { error: mode.error };
  return {
    job: {
      id: newJobId(),
      title: cleanTitle,
      type: resolved.type,
      // Cron text as typed, null on a one-time job. Validated above, so
      // nextCronIso can never be handed something it will refuse.
      schedule: resolved.schedule,
      // When this scheduled card is next due. Recomputed after every run rather
      // than stepped forward from the previous due time, so a long run can
      // never queue a backlog of overdue firings behind itself.
      nextRunAt: resolved.schedule ? nextCronIso(resolved.schedule) : null,
      lastRunAt: null,
      runCount: 0,
      // Held out of dispatch until resumed. Cards written before this existed
      // have no field at all, which reads as not paused — same as `type`.
      paused: false,
      // What this card's agent is spawned with. null inherits the board's
      // setting at dispatch — see resolveJobPermissionMode. Only read from To
      // do, which is the one state editableInPlace still lets anyone change.
      permissionMode: mode.permissionMode,
      detail: String(detail || '').trim().slice(0, MAX_DETAIL_LEN),
      // Files posted with the card ({ name, path }), written to disk by the
      // server once the id exists. The prompt hands the agent their paths.
      attachments: [],
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
      // they answer different questions: prMergedAt is a fact about GitHub, and
      // a card filed away by hand has a doneAt without one — which is how the
      // archive knows to say "finished" rather than "merged". doneAt is when
      // this board stopped showing it.
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
//
// Scheduled cards are exempt from the cap in both directions (see
// selectDispatchableJobs for why), so a scheduled run in flight must not
// consume a slot a one-time job would otherwise get.
export function countInFlightByRepo(jobs, liveSessionIds = null) {
  const counts = new Map();
  for (const job of jobs) {
    if (job.state !== 'in-progress') continue;
    if (isScheduled(job)) continue;
    if (liveSessionIds && !liveSessionIds.has(job.agentSessionId)) continue;
    counts.set(job.repoPath, (counts.get(job.repoPath) || 0) + 1);
  }
  return counts;
}

// Is this card allowed to go out right now? One-time cards always are — being
// in To do is the whole condition. A scheduled card also has to be due.
export function isJobDue(job, now = Date.now()) {
  // Paused: held in To do until someone resumes it. Checked before everything
  // else and for every card, not just scheduled ones, because this is the one
  // place every dispatch route passes through — a guard anywhere else would
  // have to be repeated at each door. Firings missed while paused are not
  // replayed: resuming re-arms nextRunAt from that moment (setJobPaused), the
  // same rule scheduledRunReset follows after a long run.
  if (job.paused) return false;
  if (!isScheduled(job)) return true;
  if (!job.nextRunAt) {
    // No due time recorded — a card whose schedule was just edited, or one
    // hand-edited in config.json. Run it and let the reset re-arm it, rather
    // than leaving it permanently undispatchable.
    //
    // EXCEPT when the schedule has no future occurrence at all. "0 0 30 2 *"
    // parses fine and never matches, so it has no due time and never will:
    // treating that as due would dispatch it on every single scan, for ever.
    return job.schedule ? nextCronIso(job.schedule, now) !== null : true;
  }
  const at = Date.parse(job.nextRunAt);
  return Number.isNaN(at) || at <= now;
}

export function selectDispatchableJobs(jobs, { maxPerRepo = MAX_AGENTS_PER_REPO, availableRepos = null, liveSessionIds = null, now = Date.now() } = {}) {
  const counts = countInFlightByRepo(jobs, liveSessionIds);
  const selected = [];
  const todo = jobs
    .filter(j => j.state === 'todo')
    .sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
  for (const job of todo) {
    // Not due yet. `continue`, not a break: a scheduled card sitting in the
    // middle of the queue must not hold up the one-time jobs behind it, and it
    // must not consume a slot from the per-repo cap while it waits.
    if (!isJobDue(job, now)) continue;
    // A repo that has been removed (or whose path vanished) can't be spawned
    // into; leave the job queued rather than failing it.
    if (availableRepos && !availableRepos.has(job.repoPath)) continue;
    // The cap bounds how many agents the board will pile onto one repo while
    // draining the one-time queue. A scheduled card is exempt, in both
    // directions: it is already bounded — one run at a time, at cron pace —
    // and holding it under the cap would let two long one-time jobs silently
    // starve every schedule on the repo, with the missed firings never
    // replayed (nextRunAt is measured from the end of a run, so a skipped
    // firing is simply gone).
    if (!isScheduled(job)) {
      const inFlight = counts.get(job.repoPath) || 0;
      if (inFlight >= maxPerRepo) continue;
      counts.set(job.repoPath, inFlight + 1);
    }
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
  // Absolute paths outside the worktree, so nothing lands in the branch by
  // accident. Claude Code's Read tool renders images, so a screenshot is
  // enough on its own.
  const files = Array.isArray(job.attachments) ? job.attachments.filter(a => a && a.path) : [];
  if (files.length) parts.push('', 'Attached files (read them with your file tools):', ...files.map(a => `  ${a.path}`));
  parts.push('', '---', ...(isScheduled(job) ? scheduledPromptSuffix(job) : oneTimePromptSuffix()));
  return parts.join('\n');
}

// The original suffix, and still the right one for a one-time job: it exists to
// produce a reviewable pull request, and the board watches for exactly that.
function oneTimePromptSuffix() {
  return [
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
  ];
}

// A scheduled job is not necessarily code, so the whole review/ship
// instruction is gone — telling an agent that summarises yesterday's commits
// to run /ship would push it into inventing a change to open a pull request
// with. Nothing replaces it: the title and details are the task, and a Claude
// agent already ends its turn with a summary, which stays readable because the
// run's terminal is kept open until the next run (see finishScheduledRuns).
//
// The one line that earns its place is assumptions-over-questions: a run that
// stops to ask holds its card in In progress until a human notices, because
// isScheduledRunOver deliberately never closes an agent in MESSAGE state.
function scheduledPromptSuffix(job) {
  return [
    'This is a scheduled run from the Agent 007 job board' + (job.schedule ? ` (${job.schedule})` : '') + '.',
    '',
    'Nobody is watching this run, so prefer a reasonable assumption over a',
    'question — a question just parks the run until someone happens to look.',
  ];
}

export function buildJobCommand(job, { permissionMode = DEFAULT_PERMISSION_MODE } = {}) {
  // The card's own mode wins; a card without one inherits whatever the board
  // is set to right now, which is the whole point of storing null rather than
  // a snapshot of the board value. The fallback is resolved here rather than
  // at the call site so every door into the dispatcher gets the same rule.
  const wanted = job && job.permissionMode ? job.permissionMode : permissionMode;
  // Validated here as well as at the settings boundary: this is the function
  // that builds the argv, so it is the last place that can guarantee the mode
  // is a single token and not a smuggled second flag.
  const mode = isValidPermissionMode(wanted) ? wanted : DEFAULT_PERMISSION_MODE;
  // Double quotes with escaped inner quotes/backslashes: parseCommand() in
  // helpers.js unescapes exactly this form.
  const quote = (text) => `"${String(text).replace(/([\\"])/g, '\\$1')}"`;
  // Attachments live outside the worktree, and Claude Code asks before it
  // reads outside its working directory; --add-dir grants that up front so
  // an unattended job does not stop at a permission prompt on its first
  // screenshot. After the prompt, so the argv positions tests rely on hold.
  const dirs = [...new Set((Array.isArray(job.attachments) ? job.attachments : []).filter(a => a && a.path).map(a => dirname(a.path)))];
  return `claude --permission-mode ${mode} ${quote(buildJobPrompt(job))}${dirs.map(d => ` --add-dir ${quote(d)}`).join('')}`;
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

// --- Scheduled run completion ---

// When is a scheduled run over?
//
// A one-time job ends when its pull request appears — an unambiguous, external
// signal. A scheduled run has no such artefact: it may write no code at all, so
// there is nothing to watch for. What is left is the agent itself.
//
// Two endings count. The agent exited (or its session is gone entirely, which
// is also every job's state after a restart — so this doubles as the recovery
// path for a run whose agent died with the server). Or it is parked at its
// prompt with nothing more to say: a TUI agent that has finished reads as
// WAITING, and once it has been quiet for the stalled window the run is done.
//
// MESSAGE is deliberately excluded. That is the agent asking the user a
// question, and killing it would throw away the answer it is waiting for. Such
// a run holds its slot and shows "needs you", exactly as a one-time job does.
export function isScheduledRunOver(job, session, { now = Date.now(), stalledAfterMs = STALLED_AFTER_MS } = {}) {
  if (!isScheduled(job) || job.state !== 'in-progress') return false;
  if (!session || session.exited) return true;
  if (session.state === 'MESSAGE') return false;
  return session.state === 'WAITING' && (now - (session.lastOutputAt || 0)) > stalledAfterMs;
}

// The fields a scheduled card carries back to To do after a run. The agent
// moves from the live link to lastRunSessionId — the tab is kept open so the
// user can read what the run wrote, and the next dispatch retires it. The
// schedule and the record of the run stay, and nextRunAt is measured from NOW
// rather than from the previous due time — so a run that overran its own
// interval simply schedules the next one afterwards instead of coming due
// again the instant it lands.
//
// lastRunAt is deliberately NOT touched: it is set once at dispatch and means
// when the last run STARTED, which is the one reading that stays meaningful
// once startedAt has been cleared.
//
// lastError goes, though. Whatever it said — a dispatch failure, an agent lost
// to a restart — described an earlier attempt, and a run has completed since.
export function scheduledRunReset(job, now = Date.now()) {
  return {
    state: 'todo',
    lastRunSessionId: job.agentSessionId || null,
    lastRunAgentName: job.agentName || null,
    agentSessionId: null,
    agentName: null,
    startedAt: null,
    branchName: null,
    worktreePath: null,
    prUrl: null,
    prNumber: null,
    reviewAt: null,
    prCheckError: null,
    prCheckErrorAt: null,
    lastError: null,
    lastErrorAt: null,
    nextRunAt: job.schedule ? nextCronIso(job.schedule, now) : null,
  };
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
