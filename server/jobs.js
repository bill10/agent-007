// Job board — persistence, dispatcher loop, PR watching.
//
// The pure logic (schema, dispatch selection, PR parsing, status derivation)
// lives in lib/jobs.js. This module owns the timers, the git/gh calls, and the
// job list inside config.json.
//
// Dependency direction matches the rest of the server: `broadcast` and
// `createSession` are passed in rather than imported, so this module never
// forms a cycle with ws.js or server.js.

import { execFile } from 'child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { config, sessions, CONFIG_DIR } from './state.js';
import { saveConfig } from './config.js';
import { gitExec } from './git.js';
import { safeFilename } from '../lib/helpers.js';
import {
  createJob, selectDispatchableJobs, buildJobCommand, deriveJobStatus,
  parsePrList, parseMergedPr, openPrListArgs, mergedPrListArgs,
  branchSlugFromTitle, isValidPermissionMode, JOB_STATES,
  DISPATCH_INTERVAL_MS, MAX_AGENTS_PER_REPO, DEFAULT_PERMISSION_MODE,
  MAX_TITLE_LEN, MAX_DETAIL_LEN, isScheduled, jobType, resolveJobType,
  isScheduledRunOver, scheduledRunReset, STATE_LABELS,
} from '../lib/jobs.js';
import { nextCronIso } from '../lib/cron.js';

// --- Board settings ---

function defaultSettings() {
  return {
    // Off until the user presses Start. An unattended process that types into
    // agents and creates worktrees should not begin on its own the first time
    // the app is opened.
    running: false,
    maxPerRepo: MAX_AGENTS_PER_REPO,
    intervalMs: DISPATCH_INTERVAL_MS,
    permissionMode: DEFAULT_PERMISSION_MODE,
  };
}

export function boardSettings() {
  if (!config.jobBoard || typeof config.jobBoard !== 'object') config.jobBoard = defaultSettings();
  else config.jobBoard = { ...defaultSettings(), ...config.jobBoard };
  return config.jobBoard;
}

export function allJobs() {
  if (!Array.isArray(config.jobs)) config.jobs = [];
  return config.jobs;
}

// --- Broadcast ---

// The wire shape adds `status` (running / needs-input / stalled / gone) and the
// live agent state, both derived fresh on every send. They are never persisted:
// they describe a PTY that exists right now, so a stored copy would go stale
// the moment the server restarts.
export function jobsPayload() {
  const jobs = allJobs().map((job) => {
    const session = job.agentSessionId ? sessions.get(job.agentSessionId) : null;
    return {
      ...job,
      // Resolved rather than raw: cards written before scheduled jobs existed
      // carry no type at all, and the client should not have to know that.
      type: jobType(job),
      status: deriveJobStatus(job, session),
      agentState: session ? session.state : null,
      agentAlive: !!(session && !session.exited),
    };
  });
  return { type: 'jobs-list', jobs, settings: boardSettings() };
}

export function broadcastJobs(broadcast) {
  if (broadcast) broadcast(jobsPayload());
}

function persist(broadcast) {
  saveConfig(broadcast);
  broadcastJobs(broadcast);
}

// --- PR-check notes ---

// Why the board cannot see this job's pull request, written onto the card.
// Shared by both sweeps: they ask GitHub different questions but report the
// answer the same way, under the same rule — write only when the text changes,
// so a permanent failure does not rewrite config.json every scan. Each returns
// whether it actually changed anything, so a caller can decide to persist.
function notePrCheckError(job, message) {
  if (job.prCheckError === message) return false;
  job.prCheckError = message;
  job.prCheckErrorAt = new Date().toISOString();
  return true;
}

function clearPrCheckError(job) {
  if (!job.prCheckError) return false;
  job.prCheckError = null;
  job.prCheckErrorAt = null;
  return true;
}

// --- Attachments ---

// Files posted with a card live under the config dir, never in the repo, so
// the agent reads them by absolute path and nothing can end up committed. They
// arrive inline on the job message as base64, the same shape as the terminal's
// upload-file, so the id is known before anything touches the disk.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
// Per save, not per card: one message is one WebSocket frame, and ws drops
// the socket (not the message) past its 100MiB default. Bounded well under
// that, base64 included, so the failure a user sees is a form error rather
// than a vanished card.
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const ATTACHMENTS_DIR = resolve(CONFIG_DIR, 'attachments');

function attachmentDir(jobId) {
  return join(ATTACHMENTS_DIR, jobId);
}

// Stored paths and ids come from config.json, which a person (or an agent
// running as the same user) can edit by hand, so nothing is served or deleted
// through one unless it resolves inside the attachments dir.
function insideAttachments(path) {
  return resolve(String(path || '')).startsWith(ATTACHMENTS_DIR + sep);
}

// The full list the card should have: { name } keeps an existing file, { name,
// data } writes a new one, and anything on disk that is not named is removed.
// Split in two so updateJob can refuse before it has touched the job: plan
// decodes and validates without side effects, apply writes. Returns null when
// the message did not mention attachments at all.
function planAttachments(job, list) {
  if (!Array.isArray(list)) return null;
  if (list.length > MAX_ATTACHMENTS) return { error: `At most ${MAX_ATTACHMENTS} files per job` };
  const dir = attachmentDir(job.id);
  if (!insideAttachments(dir)) return { error: 'Job id cannot hold attachments' };
  const stored = job.attachments || [];
  const kept = [];
  const writes = [];
  let total = 0;
  for (const item of list) {
    // No separator survives the sanitiser and a name with no letter or digit
    // is refused, so join() cannot climb out of the job's dir. Every refusal
    // is an error, not a silent drop: the user attached the file on purpose.
    const name = safeFilename(item?.name).slice(0, 120);
    if (!/[a-zA-Z0-9]/.test(name)) return { error: `Unusable file name "${String(item?.name || '')}"` };
    // Case-insensitive: macOS and Windows would store Shot.png and shot.png
    // as one file that two records then fight over.
    if (kept.some(a => a.name.toLowerCase() === name.toLowerCase())) return { error: `Two files would be stored as "${name}"` };
    const path = join(dir, name);
    if (typeof item.data === 'string') {
      const buf = Buffer.from(item.data, 'base64');
      if (buf.length > MAX_ATTACHMENT_BYTES) return { error: `${name} is too large (max 10MB)` };
      total += buf.length;
      if (total > MAX_ATTACHMENT_TOTAL_BYTES) return { error: 'Attachments add up to more than 50MB' };
      writes.push({ path, buf });
      kept.push({ name, path });
      continue;
    }
    // A { name } keeps what the card already has, record and all: a file
    // that has gone missing from disk stays listed (its link 404s, which
    // says so) rather than being dropped from the card by an unrelated edit.
    const old = stored.find(a => a.name === name);
    if (old) kept.push(old);
  }
  return { dir, kept, writes };
}

function applyAttachments(job, plan) {
  // Written beside the final name and renamed into place only once every
  // write has succeeded, so a write that fails (disk full) leaves the files
  // the card already had as they were. The suffix holds a character the
  // sanitiser strips, so it can never be a real attachment's name.
  // ponytail: the rename loop itself is not atomic as a set; a rename that
  // fails mid-loop (Windows EPERM on an open file) leaves earlier ones done.
  const parts = plan.writes.map(w => ({ ...w, part: `${w.path}~part` }));
  try {
    if (parts.length) mkdirSync(plan.dir, { recursive: true });
    for (const w of parts) writeFileSync(w.part, w.buf);
    for (const w of parts) renameSync(w.part, w.path);
  } catch (err) {
    for (const w of parts) rmSync(w.part, { force: true });
    return { error: `Could not save attachments: ${err.message}` };
  }
  for (const old of job.attachments || []) {
    if (!plan.kept.some(a => a.name === old.name) && insideAttachments(old.path)) rmSync(old.path, { force: true });
  }
  return { attachments: plan.kept };
}

// For the download route: the stored path, or null if the card has no such file.
export function attachmentPath(jobId, name) {
  const job = allJobs().find(j => j.id === jobId);
  const hit = job && (job.attachments || []).find(a => a.name === name);
  return hit && insideAttachments(hit.path) ? hit.path : null;
}

// A card is a few lines of JSON and stays forever; its files can be megabytes
// and were inputs to a run that is now over. Done is terminal, so the moment a
// card gets there — by hand or by the merge sweep — the disk comes back. The
// records go with the files: an archive card full of 404 links says less than
// none. On a failure (or a path the containment check refuses) the list is
// kept, so the files stay owned by the card and still go when it is deleted.
// Returns whether anything changed, so callers know to persist.
function clearAttachments(job) {
  if (!(job.attachments || []).length) return false;
  const dir = attachmentDir(job.id);
  if (!insideAttachments(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    job.attachments = [];
    return true;
  } catch (err) {
    console.error(`Failed to remove attachments for finished job "${job.title}":`, err.message);
    return false;
  }
}

// True while a live agent may still be reading this card's files: its prompt
// named their absolute paths at dispatch — the same hazard updateJob's To-do
// gate exists for — and the merge sweep deliberately keeps a re-adopted
// Review agent running when its PR lands.
function attachmentsInUse(job) {
  const session = job.agentSessionId ? sessions.get(job.agentSessionId) : null;
  return !!session && !session.exited;
}

// Done cards whose files are still on disk: a clear the OS refused (a file
// open in a browser tab on Windows), or one deferred while the card's agent
// was still alive. Done is terminal, so without this per-sweep retry a single
// failure would leak the directory for as long as the archive keeps the card.
function clearFinishedAttachments() {
  let cleared = false;
  for (const job of allJobs()) {
    if (job.state === 'done' && (job.attachments || []).length && !attachmentsInUse(job)) {
      if (clearAttachments(job)) cleared = true;
    }
  }
  return cleared;
}

// --- CRUD ---

export function addJob({ title, detail, repoPath, type, schedule, postedBy, postedByName, postedByAgent, attachments }, broadcast) {
  const result = createJob({ title, detail, repoPath, type, schedule, postedBy, postedByName, postedByAgent });
  if (result.error) return result;
  const plan = planAttachments(result.job, attachments);
  if (plan?.error) return plan;
  const written = plan ? applyAttachments(result.job, plan) : null;
  if (written?.error) return written;
  if (written) result.job.attachments = written.attachments;
  allJobs().push(result.job);
  persist(broadcast);
  return { job: result.job };
}

// --- Repo references ---

// The board's own form picks a repo from a dropdown of exact paths. An agent
// calling the MCP tool types whatever it knows — "~/code/app", a relative path,
// or just the folder name. Resolve all of those against the configured repos,
// and refuse anything that doesn't match rather than queueing a job into a repo
// the dispatcher will silently skip forever.
export function resolveRepoRef(ref) {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  const known = repos.map(r => r.path);
  if (repos.length === 0) return { error: 'No repositories are configured in Agent 007 — add one in the explorer first' };
  const raw = String(ref || '').trim();
  if (!raw) return { error: `Which repository? Pass repo with one of: ${known.map(p => basename(p)).join(', ')}` };
  const expanded = raw.startsWith('~/') ? resolve(homedir(), raw.slice(2)) : raw;
  const abs = resolve(expanded);
  const byPath = known.find(p => p === raw || p === abs);
  if (byPath) return { path: byPath };
  // Folder name, case-insensitively. Ambiguity is possible (two repos sharing a
  // basename), so say so instead of guessing.
  const lower = raw.toLowerCase();
  const byName = known.filter(p => basename(p).toLowerCase() === lower);
  if (byName.length === 1) return { path: byName[0] };
  if (byName.length > 1) {
    // Enough to tell them apart (the parent folder), not the absolute path:
    // every other branch here reports basenames only, and this reply goes out
    // to whatever called the tool.
    const hints = byName.map(p => join(basename(dirname(p)), basename(p)));
    return { error: `"${raw}" matches more than one repository (${hints.join(', ')}) — pass the full path` };
  }
  return { error: `Unknown repository "${raw}" — known repositories: ${known.map(p => basename(p)).join(', ')}` };
}

// --- Posting on an agent's behalf ---
//
// The one place a card gets created for an agent, shared by the MCP tool and by
// POST /api/jobs. Both doors must resolve the repo, attribute the card and
// report dispatcher state identically; a second copy of this would drift.
//
// Not ownership-gated, matching the WebSocket `job-create` handler: the board is
// shared workspace state, and postedBy/postedByAgent are attribution rather than
// access control.
// Said the same way at both doors: an agent that passed a JSON number or an
// object meant to schedule something, and deserves the same answer either way.
function scheduleTypeError(schedule) {
  return schedule != null && typeof schedule !== 'string'
    ? 'schedule must be a string — a five-field cron expression or an @shorthand'
    : null;
}

export function postJobForAgent({ title, detail, repo, schedule, type, session, user }, broadcast) {
  // The repo the calling agent is working in is the overwhelmingly likely
  // answer, so an agent only names one when it means a different repo.
  const resolved = resolveRepoRef(repo || (session && session.repoPath) || '');
  if (resolved.error) return { error: resolved.error };

  // A non-string schedule (a JSON number, an object) must come back as an
  // error, not a silent one-time card: the plain HTTP door has no schema in
  // front of it, the caller asked for a scheduled job, and every other bad
  // input here is answered with a message the caller can act on.
  const badSchedule = scheduleTypeError(schedule);
  if (badSchedule) return { error: badSchedule };
  if (type != null && typeof type !== 'string') {
    return { error: 'type must be a string — "one-time" or "scheduled"' };
  }

  const result = addJob({
    // Typed explicitly: this comes off the wire, and a non-string would be
    // stringified into the card ("[object Object]") rather than rejected.
    // createJob still owns the length and emptiness rules.
    title: typeof title === 'string' ? title : '',
    detail: typeof detail === 'string' ? detail : '',
    repoPath: resolved.path,
    // A schedule alone makes it a scheduled job — createJob owns that rule, and
    // the cron validation with it, so a bad expression comes back as a message
    // the calling agent can act on rather than a card that never fires.
    type: typeof type === 'string' ? type : undefined,
    schedule: typeof schedule === 'string' ? schedule : '',
    postedBy: user ? user.id : null,
    postedByName: user ? user.displayName : null,
    postedByAgent: session ? session.name : null,
  }, broadcast);
  if (result.error) return { error: result.error };

  // A card an agent posted while the user was looking at a terminal would
  // otherwise land silently on a tab they cannot see. The board's own form
  // needs no toast — the user is looking straight at the column it lands in.
  if (session && broadcast) {
    broadcast({
      type: 'notification', level: 'info',
      message: `${session.name} posted a job: "${result.job.title}"`,
    });
  }
  return {
    job: result.job,
    repoName: basename(resolved.path),
    // Whether the board will actually act on it. Reported out loud, because a
    // stopped dispatcher means the card just sits in To do — and an agent
    // telling its user "queued" would imply work is under way when none is.
    dispatcherRunning: !!boardSettings().running,
  };
}

// --- The read side of the same door ---
//
// An agent asked by its user to look at the board, rather than write to it. The
// board is one shared wall — jobsPayload sends every card to every connected
// client — so there is nothing per-agent to filter out here, and these read the
// same store the browser does.

// The row an agent gets per card: enough to say what the card is and to name it
// in a follow-up call, without the detail body, which is the long part.
function jobSummary(job) {
  const session = job.agentSessionId ? sessions.get(job.agentSessionId) : null;
  return {
    id: job.id,
    title: job.title,
    state: job.state,
    type: jobType(job),
    schedule: job.schedule || null,
    nextRunAt: job.nextRunAt || null,
    repo: basename(job.repoPath || ''),
    editedByAgent: job.editedByAgent || null,
    // Derived fresh, never stored: it describes a PTY that exists right now.
    status: deriveJobStatus(job, session),
    agentName: job.agentName || null,
    prUrl: job.prUrl || null,
    postedByName: job.postedByName || null,
    postedByAgent: job.postedByAgent || null,
    postedAt: job.postedAt || null,
  };
}

export function listJobsForAgent({ state, repo } = {}) {
  const wanted = typeof state === 'string' && state.trim() ? state.trim() : null;
  if (wanted && !JOB_STATES.includes(wanted)) {
    return { error: `Unknown state "${wanted}" — expected one of: ${JOB_STATES.join(', ')}` };
  }
  // Narrowing arguments must narrow or refuse, never widen: a non-string repo
  // used to fall through to "every repository", which is the opposite of what
  // the caller asked for. postJobForAgent refuses the same shape.
  if (repo != null && typeof repo !== 'string') {
    return { error: 'repo must be a string — a full path or a folder name' };
  }
  let repoPath = null;
  if (typeof repo === 'string' && repo.trim()) {
    const resolved = resolveRepoRef(repo);
    if (resolved.error) return { error: resolved.error };
    repoPath = resolved.path;
  }
  // Finished cards are the archive behind the board's toolbar, not a column, so
  // an unfiltered list answers with the board — asking for `done` reaches them.
  const jobs = allJobs().filter(job => (wanted ? job.state === wanted : job.state !== 'done')
    && (!repoPath || job.repoPath === repoPath))
    // Oldest first, the order the board's own columns are sorted in, so an
    // agent describes the board the user is looking at rather than a shuffle.
    .sort((a, b) => String(a.postedAt || '').localeCompare(String(b.postedAt || '')));
  return {
    jobs: jobs.map(jobSummary),
    state: wanted,
    repoName: repoPath ? basename(repoPath) : null,
    // Said out loud by the caller: a board that looks empty because the archive
    // is hidden is different from a board with nothing on it.
    archived: wanted ? 0 : allJobs().filter(job => job.state === 'done').length,
  };
}

export function readJobForAgent(jobId) {
  const job = allJobs().find(j => j.id === jobId);
  if (!job) return { error: `No job with id "${jobId}" — list the board to see the ids.` };
  return {
    job: {
      ...jobSummary(job),
      detail: job.detail || '',
      // Basename only, deliberately — resolveRepoRef reports repos the same
      // way. An absolute repo or worktree path is the layout of the user's
      // disk, and this reply goes to whatever agent called the tool, about
      // every card on the board including other people's.
      branchName: job.branchName || null,
      startedAt: job.startedAt || null,
      prMergedAt: job.prMergedAt || null,
      editedAt: job.editedAt || null,
      lastRunAt: job.lastRunAt || null,
      runCount: job.runCount || 0,
      // Both, and separately: the board keeps them apart because a card can be
      // failing to dispatch AND failing its PR check at once.
      lastError: job.lastError || null,
      prCheckError: job.prCheckError || null,
      attachments: (Array.isArray(job.attachments) ? job.attachments : []).map(a => a && a.name).filter(Boolean),
    },
  };
}

// The same edit, asked for by an agent. It refuses ahead of updateJob rather
// than after it so a no-op edit to a dispatched card answers with the rule that
// actually stopped it, not "nothing to change".
//
// Two guards here that the board's own form does not need. A To do card's
// detail IS the next agent's prompt — buildJobPrompt hands it over verbatim to
// an unattended `claude --permission-mode auto` — and every board-dispatched
// agent holds one of these tokens, so an agent working a hostile repo could
// otherwise rewrite a card queued for a different repo and have the board run
// its text. So: an agent may not touch a card another person queued, matching
// the ownership rule ws.js already applies to terminals; and an edit that does
// land says so out loud and leaves its name on the card, because the whole
// hazard is an edit nobody sees. Reading stays board-wide — every browser
// already sees every card — but writing does not.
export function editJobForAgent({ id, title, detail, repo, schedule, session, user }, broadcast) {
  const job = allJobs().find(j => j.id === id);
  if (!job) return { error: `No job with id "${id}" — list the board to see the ids.` };
  const gate = editableInPlace(job);
  if (gate) return gate;
  // Null on a single-player board (no users file), on both sides, so this only
  // ever bites once identities exist.
  const asker = user ? user.id : null;
  if (job.postedBy && job.postedBy !== asker) {
    return {
      error: `"${job.title}" was queued by ${job.postedByName || 'someone else'}, so this agent cannot edit it. `
        + 'Ask them, or post a new card.',
    };
  }

  const fields = {};
  const changed = [];
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      return { error: 'Title must be a non-empty string — omit it to leave the title alone.' };
    }
    if (title.trim() !== job.title) { fields.title = title; changed.push('title'); }
  }
  if (detail !== undefined) {
    if (typeof detail !== 'string') return { error: 'detail must be a string' };
    if (detail.trim() !== (job.detail || '')) { fields.detail = detail; changed.push('detail'); }
  }
  if (repo !== undefined) {
    const resolved = resolveRepoRef(repo);
    if (resolved.error) return { error: resolved.error };
    if (resolved.path !== job.repoPath) { fields.repoPath = resolved.path; changed.push('repo'); }
  }
  if (schedule !== undefined) {
    const bad = scheduleTypeError(schedule);
    if (bad) return { error: bad };
    const text = String(schedule || '').trim();
    // An empty schedule is the way back to a one-time card: without naming the
    // type too, resolveJobType would read "scheduled with no cron" and refuse.
    // The tool exposes no `type` of its own — the schedule is the whole of what
    // a card IS, and two fields that can disagree is a bug waiting to be filed.
    fields.schedule = text;
    fields.type = text ? 'scheduled' : 'one-time';
    if (text !== (job.schedule || '')) changed.push('schedule');
  }

  if (!changed.length) {
    return { error: 'Nothing to change — pass a new title, detail, repo or schedule.' };
  }
  const result = updateJob(job.id, fields, broadcast);
  if (result.error) return result;
  // Stamped before the repaint that carries it to every open board.
  job.editedByAgent = session ? session.name : null;
  job.editedAt = new Date().toISOString();
  if (session && broadcast) {
    broadcast({
      type: 'notification', level: 'info',
      message: `${session.name} edited a job: "${result.job.title}"`,
    });
  }
  return { job: jobSummary(result.job), changed };
}

// A card stops being editable the moment it leaves To do, whoever is asking.
//
// The reasons stack up: its agent was handed the title, detail and attachment
// paths in its prompt at dispatch, so a later edit changes nothing about the
// run and leaves the card describing work nobody was asked to do; repointing
// repoPath misattributes work already under way in a worktree; and flipping an
// in-flight one-time card to scheduled frees its per-repo cap slot while its
// agent still runs, after which finishScheduledRuns quietly closes that run out
// and re-arms it forever.
//
// The board's own form has only ever offered Edit on a To do card, so this is
// the rule the interface always implied — now enforced for every door into the
// store rather than trusted to the button not being drawn.
function editableInPlace(job) {
  if (job.state === 'todo') return null;
  const label = STATE_LABELS[job.state] || job.state;
  return {
    error: `"${job.title}" is in ${label}, and only cards still in To do can be edited — `
      + 'its agent has already been handed the card as it stands.',
  };
}

export function updateJob(jobId, fields, broadcast) {
  const job = allJobs().find(j => j.id === jobId);
  if (!job) return { error: 'Job not found' };
  const gate = editableInPlace(job);
  if (gate) return gate;
  // Everything else that can be refused is checked before anything on the job
  // is touched, or an error reply would leave the card half-edited in memory
  // for the next unrelated persist to write out.
  const plan = planAttachments(job, fields.attachments);
  if (plan?.error) return plan;
  // Type and schedule move together: "scheduled with no cron" and "one-time
  // carrying a cron" are both incoherent, so they are resolved as a pair and
  // rejected as a pair.
  let resolved = null;
  let changes = false;
  if (fields.type !== undefined || fields.schedule !== undefined) {
    resolved = resolveJobType({
      type: fields.type !== undefined ? fields.type : jobType(job),
      schedule: fields.schedule !== undefined ? fields.schedule : job.schedule,
    });
    if (resolved.error) return { error: resolved.error };
    changes = resolved.type !== jobType(job)
      || (resolved.schedule || null) !== (job.schedule || null);
  }
  // The disk write is the last thing that can fail, and it happens before the
  // first field changes.
  const written = plan ? applyAttachments(job, plan) : null;
  if (written?.error) return written;
  if (written) job.attachments = written.attachments;
  if (typeof fields.title === 'string' && fields.title.trim()) job.title = fields.title.trim().slice(0, MAX_TITLE_LEN);
  if (typeof fields.detail === 'string') job.detail = fields.detail.trim().slice(0, MAX_DETAIL_LEN);
  if (fields.repoPath) job.repoPath = fields.repoPath;
  if (resolved) {
    job.type = resolved.type;
    job.schedule = resolved.schedule;
    // Recompute only on a real change: the old due time belongs to the old
    // cron, but a save that merely retitled the card must not re-arm an
    // overdue schedule and eat the firing that was about to happen.
    if (changes) job.nextRunAt = resolved.schedule ? nextCronIso(resolved.schedule) : null;
  }
  persist(broadcast);
  return { job };
}

// Pause / resume. Deliberately NOT routed through updateJob: that gate refuses
// any edit to a card past To do because the agent has already been handed the
// card's text, and pause changes no text — it only decides whether the NEXT
// firing goes out. So a schedule can be stopped while its current run is still
// going, which is exactly when someone reaches for it.
//
// Resuming re-arms from now rather than leaving a due time that went by during
// the pause: an overdue nextRunAt would dispatch on the very next scan, so a
// card resumed after a week off would fire immediately, which is the backlog
// replay the board avoids everywhere else.
export function setJobPaused(jobId, paused, broadcast) {
  const job = allJobs().find(j => j.id === jobId);
  if (!job) return { error: 'Job not found' };
  const next = !!paused;
  if (job.paused === next) return { job };
  job.paused = next;
  if (!next && job.schedule) job.nextRunAt = nextCronIso(job.schedule);
  persist(broadcast);
  return { job };
}

// Deleting a card retires its agent, for the same reason requeueing does:
// otherwise the agent keeps running with nothing pointing at it, stops counting
// toward the per-repo cap, and is never cleaned up. removeWorktree still
// protects the work — dirty or unpushed changes become an orphan.
export async function deleteJob(jobId, broadcast, { killSession } = {}) {
  const jobs = allJobs();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) return { error: 'Job not found' };
  const [removed] = jobs.splice(idx, 1);
  persist(broadcast);
  // After persist, so a file the OS will not let go of (open in a browser tab
  // on Windows) cannot leave a card that is gone from memory but back on the
  // next restart. The id is checked the same way a path is: it too is
  // config.json text.
  const dir = attachmentDir(removed.id);
  if (insideAttachments(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch (err) {
      console.error(`Failed to remove attachments for deleted job "${removed.title}":`, err.message);
    }
  }
  // Both the live agent and a scheduled card's kept last-run agent: with the
  // card gone, nothing else would ever retire either of them.
  for (const sessionId of [removed.agentSessionId, removed.lastRunSessionId]) {
    if (!sessionId || !killSession) continue;
    const session = sessions.get(sessionId);
    if (session && !session.exited) {
      try {
        await killSession(sessionId);
      } catch (err) {
        console.error(`Failed to close agent for deleted job "${removed.title}":`, err.message);
      }
    }
  }
  return { job: removed };
}

// Manual move (the buttons on a card). Permissive everywhere the card is still
// on the board, because automatic transitions can be wrong and the user should
// have the last word — with one exception, below: done is terminal.
//
// Moving back to To do also RETIRES the job's agent. Unlinking it without
// killing it left a running agent that no job pointed at: it no longer counted
// toward the per-repo cap, so the board would dispatch a replacement alongside
// it, and repeating the move walks straight past the cap. Retiring it keeps the
// same invariant the PR path relies on — in-progress jobs and live board agents
// are the same set. removeWorktree still protects the work: uncommitted or
// unpushed changes become an orphan rather than being deleted.
export async function moveJob(jobId, state, broadcast, { killSession, findPr = findPrForBranch } = {}) {
  if (!JOB_STATES.includes(state)) return { error: `Unknown state "${state}"` };
  const job = allJobs().find(j => j.id === jobId);
  if (!job) return { error: 'Job not found' };
  // Done is terminal. A finished card is the record of work that shipped, and
  // the only thing that can happen to it is deletion.
  //
  // It is enforced here and not just in the UI because letting a card back onto
  // the board could not be made safe. The card keeps the PR that finished it,
  // and reviewAt is the sweep's time floor, so a job walked back to In progress
  // carried a spent PR of record into its new attempt: checkMergedPullRequests
  // re-matched that same old merge on the very next scan and filed the card
  // away again — killing whatever agent had been re-adopted on the branch,
  // because finishing from in-progress retires one. Clearing those fields would
  // just trade that for a card whose history is gone. Work that follows a
  // merged PR is a new job, and the archive keeps the old one to point at.
  if (job.state === 'done') {
    return { error: 'That job is finished — post a new job for follow-up work, or delete this card' };
  }
  // A scheduled card cycles To do <-> In progress, and nothing on the board
  // ever touches one parked in Review — both PR sweeps skip the type, and the
  // run finisher only reads In progress — while done is terminal, so either
  // move ends a standing schedule for good. The UI hides those buttons on a
  // scheduled card; the raw message has to be refused too.
  if (isScheduled(job) && (state === 'review' || state === 'done')) {
    return { error: 'A scheduled job cycles between To do and In progress — delete the card to retire its schedule' };
  }
  // A job with no branch has never been dispatched, so nothing can move it out
  // of in-progress again: the dispatcher only looks at todo, and the PR watcher
  // only at jobs with a branch. Accepting the move would strand it forever.
  if (state === 'in-progress' && !job.branchName) {
    return { error: 'That job has never been dispatched — leave it in To do so the board can pick it up' };
  }
  // Any manual move OUT of in-progress retires the agent, not just the requeue.
  // "→ Review" means the PR was opened outside the board, so the agent is as
  // done as it would be on the automatic path. Leaving it running would break
  // the invariant the cap depends on — in-progress jobs and live board agents
  // being the same set — because countInFlightByRepo stops counting a job the
  // moment it leaves in-progress. The agent would keep a worktree and a PTY
  // while the board dispatched a replacement past the cap.
  //
  // "Done" retires it for the same reason and one more: a finished card is off
  // the board, so an agent still attached to it would be running with nothing
  // visible pointing at it. (The automatic merge sweep deliberately does NOT do
  // this — see checkMergedPullRequests.)
  //
  // One move keeps the agent, and it is the one that means "I am still working
  // on this": a move INTO in-progress, taking the work back up.
  const retiringSessionId = state === 'in-progress' ? null : job.agentSessionId;
  job.state = state;
  if (state === 'todo') {
    // A scheduled card returning to To do is re-armed, not blanked: it keeps its
    // schedule and gets the next due time. Without this a manual requeue would
    // leave nextRunAt in the past and the card would fire again immediately.
    if (isScheduled(job)) job.nextRunAt = job.schedule ? nextCronIso(job.schedule) : null;
    job.agentSessionId = null;
    job.agentName = null;
    job.startedAt = null;
    job.branchName = null;
    job.worktreePath = null;
    job.prUrl = null;
    job.prNumber = null;
    job.reviewAt = null;
  }
  if (state === 'review' && !job.reviewAt) job.reviewAt = new Date().toISOString();
  // Stamped on arrival, and never cleared, because nothing leaves done. A job
  // finished by hand gets a doneAt but no prMergedAt: the board is recording
  // that the USER called it finished, which is not a claim about GitHub.
  if (state === 'done') {
    job.doneAt = new Date().toISOString();
    clearAttachments(job);
  }
  // The note explaining why the board could not check this job's PR describes an
  // attempt the user is now overriding by hand, so it must not survive the move:
  // not onto a fresh To do card, where it would report a failure against work
  // that has not been tried yet, and not into the archive, where it would still
  // be telling the user to move the card by hand. The Review case is handled
  // below, where a successful lookup clears it too.
  if (state !== 'review') clearPrCheckError(job);
  // A manual move means "the PR was opened outside the board". Look it up, or
  // the card sits in Review with no link to the thing it produced — nothing
  // else backfills it, since the watcher only examines in-progress jobs.
  if (state === 'review' && !job.prNumber && job.branchName) {
    // Best-effort: a lookup that fails must not abandon the move half-applied,
    // with the state changed in memory but never persisted and the agent never
    // retired. The card just goes without its link, as it did before.
    try {
      const { pr } = await findPr(job.repoPath, job.branchName);
      // Re-check before writing: findPr is a network call, and a concurrent
      // requeue during it would otherwise leave a To do card carrying PR links
      // for an attempt that no longer exists.
      if (pr && job.state === 'review' && allJobs().includes(job)) {
        job.prUrl = pr.url;
        job.prNumber = pr.number;
        job.lastError = null;
        job.lastErrorAt = null;
        // The PR is in hand, so any earlier "cannot check" note is obsolete.
        job.prCheckError = null;
        job.prCheckErrorAt = null;
      }
    } catch (err) {
      console.error(`PR lookup failed while moving "${job.title}" to review:`, err.message);
    }
  }
  // Persist and repaint before the kill so the card moves immediately; the kill
  // then emits its own session-ended and orphan notifications.
  persist(broadcast);
  if (retiringSessionId && killSession) {
    const session = sessions.get(retiringSessionId);
    if (session && !session.exited) {
      try {
        await killSession(retiringSessionId);
        // Only after it succeeded: a failed kill leaves the agent running, and
        // the card must keep pointing at it rather than become unreachable.
        if (job.agentSessionId === retiringSessionId) {
          job.agentSessionId = null;
          persist(broadcast);
        }
      } catch (err) {
        console.error(`Failed to close agent for job "${job.title}":`, err.message);
      }
    } else if (job.agentSessionId === retiringSessionId) {
      // Nothing to kill — the session already went. Drop the link anyway, or
      // the card keeps a dead id, which is how a stale link outlived a restart
      // and resolved to an unrelated agent in the next process generation.
      job.agentSessionId = null;
      persist(broadcast);
    }
  }
  return { job };
}

export function updateSettings(fields, broadcast) {
  const settings = boardSettings();
  if (typeof fields.running === 'boolean') settings.running = fields.running;
  if (Number.isFinite(fields.maxPerRepo)) settings.maxPerRepo = Math.max(1, Math.min(10, Math.floor(fields.maxPerRepo)));
  if (Number.isFinite(fields.intervalMs)) settings.intervalMs = Math.max(30_000, Math.min(60 * 60_000, Math.floor(fields.intervalMs)));
  // Allowlisted: this value is interpolated into the agent's command line.
  if (isValidPermissionMode(fields.permissionMode)) settings.permissionMode = fields.permissionMode;
  persist(broadcast);
  return { settings };
}

// --- Dispatch ---

function liveSessionIds() {
  const live = new Set();
  for (const [id, s] of sessions) if (!s.exited) live.add(id);
  return live;
}

// Repos we can actually spawn into right now. A repo removed from the sidebar
// (or whose directory has gone missing) leaves its jobs queued rather than
// failing them — the path may well come back.
function availableRepos() {
  const set = new Set();
  for (const repo of config.repos) if (existsSync(repo.path)) set.add(repo.path);
  return set;
}

// `onSessionCreated` publishes the new session to clients. It is injected
// rather than imported: ws.js already imports this module, so reaching back for
// sessionPayload() here would close a cycle. Without it a board agent would run
// invisibly — a PTY with no tab, which is precisely the thing the user must be
// able to reach to answer a question.
export async function dispatchOnce(createSession, broadcast, { onSessionCreated, killSession } = {}) {
  const settings = boardSettings();
  const candidates = selectDispatchableJobs(allJobs(), {
    maxPerRepo: settings.maxPerRepo,
    availableRepos: availableRepos(),
    liveSessionIds: liveSessionIds(),
  });
  const dispatched = [];
  for (const job of candidates) {
    const command = buildJobCommand(job, { permissionMode: settings.permissionMode });
    // Branch named after the job, not a cocktail, so `git branch` reads like
    // the board. Two jobs can share a title, so collisions take a -2 suffix
    // rather than failing the dispatch.
    const branch = branchSlugFromTitle(job.title);
    // spawnedBy:'board' rides along on the session so the client can open the
    // tab WITHOUT stealing focus. An unattended dispatcher yanking the user out
    // of whatever they are typing every few minutes would be unusable.
    const result = await createSession(command, null, job.repoPath, branch, job.postedBy || null, {
      spawnedBy: 'board', jobId: job.id, branchSuffixOnCollision: true,
    });
    if (result.error) {
      // Surface the failure on the card and leave it in To do; the next tick
      // retries. A broken repo shows a visible reason instead of a job that
      // silently never starts.
      job.lastError = result.error;
      job.lastErrorAt = new Date().toISOString();
      if (broadcast) broadcast({ type: 'notification', level: 'error', message: `Job "${job.title}" could not start: ${result.error}` });
      continue;
    }
    const session = result.session;

    // Re-validate before claiming the job. createSession takes seconds (addRepo
    // + `git worktree add` + a PTY spawn) and WebSocket handlers run during it,
    // so the job may have been deleted, requeued or moved while we waited.
    // Writing state onto a job that is gone would leave the agent running with
    // no card pointing at it: invisible to the board, uncounted by the cap, and
    // never cleaned up. The scan guard does not cover this — it serialises
    // scans against each other, not against the user.
    const stillQueued = allJobs().includes(job) && job.state === 'todo';
    if (!stillQueued) {
      if (killSession) {
        try { await killSession(session.id); } catch (err) {
          console.error(`Failed to clean up agent for vanished job "${job.title}":`, err.message);
        }
      }
      continue;
    }

    // Only now that the replacement run is real does the previous run's kept
    // agent retire (see finishScheduledRuns). Retiring before the spawn meant
    // a failed createSession destroyed the last run's only output and left no
    // new run behind it — the card showed a dispatch error and the summary the
    // board promises to keep was gone. removeWorktree still protects the work:
    // dirty or unpushed changes become an orphan rather than being deleted.
    if (isScheduled(job) && job.lastRunSessionId) {
      const prev = sessions.get(job.lastRunSessionId);
      if (prev && !prev.exited && killSession) {
        try {
          await killSession(job.lastRunSessionId);
        } catch (err) {
          console.error(`Failed to close the last run's agent for "${job.title}":`, err.message);
        }
      }
      job.lastRunSessionId = null;
      job.lastRunAgentName = null;
    }

    if (onSessionCreated) onSessionCreated(session);
    job.state = 'in-progress';
    job.agentSessionId = session.id;
    job.agentName = session.name;
    job.startedAt = new Date().toISOString();
    if (isScheduled(job)) {
      // Counted at dispatch, not at completion: the run happened whether or not
      // the agent got anywhere, and a card that keeps failing should still show
      // that it has been trying.
      job.runCount = (Number(job.runCount) || 0) + 1;
      job.lastRunAt = job.startedAt;
    }
    job.branchName = session.branchName;
    job.worktreePath = session.worktreePath;
    job.lastError = null;
    job.lastErrorAt = null;
    dispatched.push({ job, session });
  }
  if (dispatched.length > 0 || candidates.length > 0) persist(broadcast);
  return dispatched;
}

// Reconnect a re-adopted orphan to the job it was working on.
//
// A server restart clears every job's agentSessionId, because those sessions
// are gone. Re-adopting the orphan brings the agent back, but nothing tied it
// to its card: the job stayed "agent gone" while the agent was demonstrably
// alive and working, it never counted toward the per-repo cap again (so the
// board would dispatch a replacement alongside it), and when its PR appeared
// the board could not retire it or release its worktree.
//
// The branch is the link. It is created per job, never reused while it exists,
// and survives the restart on both the orphan record and the job — the one
// identifier that outlives the session.
export function relinkSessionToJob(session, broadcast) {
  if (!session || !session.branchName) return null;
  // in-progress OR review: a job can reach review while its link is null (the
  // PR was found after a restart, so there was no session to retire), and the
  // agent re-adopted afterwards still belongs to that card.
  const matches = allJobs().filter(j =>
    j.branchName === session.branchName
    && j.repoPath === session.repoPath
    && (j.state === 'in-progress' || j.state === 'review')
    && !j.agentSessionId,   // never steal a job that already has a live agent
  );
  // Prefer work still in flight: if an old review job and a new in-progress job
  // share a branch, the agent belongs to the one that is not finished.
  const job = matches.find(j => j.state === 'in-progress') || matches[0];
  if (!job) return null;
  job.agentSessionId = session.id;
  job.agentName = session.name;
  job.lastError = null;
  job.lastErrorAt = null;
  job.prCheckError = null;
  job.prCheckErrorAt = null;
  session.jobId = job.id;   // so the PR path can retire it like any board agent
  persist(broadcast);
  return job;
}

// --- PR watching ---

// --- gh plumbing ---

// One `gh` invocation. `token` picks the account; undefined means "whatever gh
// is signed in as". GITHUB_TOKEN is dropped when we override, since it outranks
// GH_TOKEN and would silently win.
function runGh(args, { cwd, token, timeout = 15_000 } = {}) {
  const env = { ...process.env };
  if (token) {
    env.GH_TOKEN = token;
    delete env.GITHUB_TOKEN;
  }
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env, timeout, maxBuffer: 1024 * 1024 },
      (err, out, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(out)));
  });
}

// Every account gh is signed in to, active one first.
async function ghAccounts() {
  try {
    const parsed = JSON.parse(await runGh(['auth', 'status', '--json', 'hosts'], { timeout: 10_000 }));
    const found = [];
    for (const entries of Object.values(parsed.hosts || {})) {
      for (const entry of entries || []) {
        if (entry && entry.state === 'success' && entry.login) {
          found.push({ login: entry.login, active: !!entry.active });
        }
      }
    }
    found.sort((a, b) => Number(b.active) - Number(a.active));
    return found.map(a => a.login);
  } catch (_) {
    // Older gh has no --json on auth status; fall back to the text form.
    try {
      const text = await runGh(['auth', 'status'], { timeout: 10_000 });
      return [...text.matchAll(/account\s+(\S+)/g)].map(m => m[1]);
    } catch (_) { return []; }
  }
}

async function ghToken(login) {
  try {
    const token = (await runGh(['auth', 'token', '-u', login], { timeout: 10_000 })).trim();
    return token || null;
  } catch (_) { return null; }
}

// Which account last answered for a repo, so the steady state stays one gh call
// instead of a walk. Memory only; a stale guess costs one retry.
const ghAccountForRepo = new Map();

// The account list and its tokens are the same for every job in a scan, but the
// walk is per job — so without this a scan over N jobs pays N `gh auth status`
// plus N-per-account `gh auth token` subprocess spawns for answers that cannot
// have changed. Short TTL rather than a per-scan cache because both sweeps and
// the "Run now" button walk independently; a minute is long enough to collapse
// a scan and short enough that signing in or out is picked up promptly.
const GH_AUTH_TTL_MS = 60_000;
const ghAuthCache = new Map();   // key -> { at, value }

async function ghCached(key, produce) {
  const hit = ghAuthCache.get(key);
  if (hit && Date.now() - hit.at < GH_AUTH_TTL_MS) return hit.value;
  const value = await produce();
  ghAuthCache.set(key, { at: Date.now(), value });
  return value;
}

const ghAccountsCached = () => ghCached('accounts', ghAccounts);
const ghTokenCached = (login) => ghCached(`token:${login}`, () => ghToken(login));

// Names the command in a failure message, so "…failed (tried 2 accounts)" says
// what was actually run rather than leaving the reader to guess.
const GH_PR_LIST = 'gh pr list';

// First line only: gh errors are one useful line plus usage noise.
function ghErrorDetail(err) {
  return String(err.stderr || err.message || '').trim().split('\n')[0].slice(0, 200);
}

async function prListOnce(repoPath, branchName, token) {
  try {
    const stdout = await runGh(openPrListArgs(branchName), { cwd: repoPath, token });
    return { pr: parsePrList(stdout) };
  } catch (err) {
    return { error: ghErrorDetail(err) || `${GH_PR_LIST} failed` };
  }
}

// The merged twin of prListOnce. `--state merged` rather than reading the state
// off the open query, because gh's default listing is open-only: a merged PR
// simply vanishes from it, which is indistinguishable from a branch that never
// had one.
async function mergedPrListOnce(repoPath, branchName, token, match) {
  try {
    const stdout = await runGh(mergedPrListArgs(branchName), { cwd: repoPath, token });
    return { pr: parseMergedPr(stdout, match) };
  } catch (err) {
    return { error: ghErrorDetail(err) || `${GH_PR_LIST} failed` };
  }
}

// Is this even a path we can ask gh about? Cheap local checks first, so a
// removed repo or an undispatched job never shells out at all.
async function isQueryableRepo(repoPath, branchName) {
  if (!repoPath || !branchName || !existsSync(repoPath)) return false;
  try {
    return !!(await gitExec(['-C', repoPath, 'rev-parse', '--git-dir']));
  } catch { return false; }
}

// The account walk, shared by every gh lookup.
//
// Tries EVERY signed-in gh account before giving up. One machine can hold
// several, and a private repo is usually visible to exactly one of them — this
// app routinely manages repos owned by different accounts, so the signed-in
// account failing says nothing about whether the PR exists. Observed:
// `Could not resolve to a Repository` from the active account while another
// account on the same machine could see the repo perfectly well.
//
// `query(token)` runs one lookup and returns `{ error }` to mean "this account
// cannot see the repo" or anything else to mean success. A success ends the
// walk and is handed back verbatim, so each lookup keeps its own return shape.
//
// The collaborators are injectable for the same reason createSession and
// killSession are: otherwise the walk — ordering, dedup, remembering, error
// aggregation — is only reachable by talking to real GitHub accounts.
async function walkGhAccounts(repoPath, query, { listAccounts = ghAccountsCached, tokenFor = ghTokenCached, label = GH_PR_LIST } = {}) {
  // Label for a lookup that uses no explicit token — whatever gh picks itself.
  const AMBIENT = 'signed-in account';
  const tried = [];
  const failures = [];

  const attempt = async (label, token) => {
    if (tried.includes(label)) return null;
    tried.push(label);
    const result = await query(token);
    // Detail only — the account list in the final message names who was tried,
    // and the errors are almost always identical across accounts anyway.
    if (result.error) { failures.push(result.error); return null; }
    return result;
  };

  // 1. The account that answered for this repo last time.
  const remembered = ghAccountForRepo.get(repoPath);
  if (remembered) {
    const token = await tokenFor(remembered);
    if (token) {
      const hit = await attempt(remembered, token);
      if (hit) return { ok: true, result: hit };
    }
  }

  // 2. Every account gh knows about, active first, each with its own token.
  //
  // Named accounts rather than "whatever gh is signed in as" so the walk is
  // unambiguous: an earlier version tried the ambient account first and then
  // skipped accounts[0] to avoid repeating it, which quietly assumed the first
  // entry was the account ambient had used. With more than one host configured
  // that assumption can skip the only account able to see the repo.
  const accounts = await listAccounts();
  for (const login of accounts) {
    const token = await tokenFor(login);
    if (!token) continue;
    const hit = await attempt(login, token);
    if (hit) { ghAccountForRepo.set(repoPath, login); return { ok: true, result: hit }; }
  }

  // 3. Last resort: no explicit token. Covers a token supplied through the
  //    environment, an enterprise host, and older gh versions whose auth status
  //    this cannot enumerate.
  const ambient = await attempt(AMBIENT, undefined);
  if (ambient) { ghAccountForRepo.delete(repoPath); return { ok: true, result: ambient }; }

  ghAccountForRepo.delete(repoPath);
  const plural = tried.length === 1 ? '' : 's';
  return {
    ok: false,
    error: `${failures[0] || `${label} failed`} (tried ${tried.length} account${plural}: ${tried.join(', ')})`,
  };
}

// `gh pr list` against the repo, filtered to the job's branch. Runs in the main
// repo (not the worktree) so it still works after the worktree is removed.
//
// Returns { pr } on a successful query — pr null meaning "no PR yet" — or
// { pr: null, error } only when EVERY account failed. An earlier version
// collapsed both into null, so a repo the board could never see looked exactly
// like a branch with no PR, and its jobs sat in progress forever unexplained.
// Guard, walk, unwrap — identical for both branch lookups; only the query
// differs. They stay two named exports rather than one function with a flag so
// each call site says which question it is asking.
async function branchPrLookup(repoPath, branchName, query, { listAccounts, tokenFor, label }) {
  if (!(await isQueryableRepo(repoPath, branchName))) return { pr: null };
  const walked = await walkGhAccounts(repoPath, query, { listAccounts, tokenFor, label });
  return walked.ok ? walked.result : { pr: null, error: walked.error };
}

export async function findPrForBranch(repoPath, branchName, {
  listAccounts = ghAccountsCached,
  tokenFor = ghTokenCached,
  prList = prListOnce,
} = {}) {
  return branchPrLookup(repoPath, branchName, token => prList(repoPath, branchName, token),
    { listAccounts, tokenFor, label: GH_PR_LIST });
}

// The same lookup, asking instead whether the branch's PR has MERGED. Same
// account walk, same error contract — { pr: null } means "not merged (yet)",
// and an error means nobody could see the repo.
//
// `prNumber` and `mergedAfter` are what make the answer about THIS card rather
// than about the branch name — see parseMergedPr for why the distinction is not
// academic. They are passed on to the parser, not to gh: `gh pr list` has no
// way to ask "the merge of PR #7", only "merges on this head ref".
export async function findMergedPrForBranch(repoPath, branchName, {
  listAccounts = ghAccountsCached,
  tokenFor = ghTokenCached,
  prList = mergedPrListOnce,
  prNumber = null,
  mergedAfter = null,
} = {}) {
  const match = { number: prNumber, mergedAfter };
  return branchPrLookup(repoPath, branchName, token => prList(repoPath, branchName, token, match),
    { listAccounts, tokenFor, label: `${GH_PR_LIST} --state merged` });
}

// Close the agent that delivered a job, resolving it by branch when the stored
// link is gone. This is what keeps the per-repo cap meaningful: in-progress jobs
// and live agents stay the same set, so nothing accumulates. killSession ->
// removeWorktree deletes the worktree and the local branch (fully pushed by
// then); the PR is untouched. The card keeps the whole record — agent name,
// branch, PR link — so nothing is lost by the terminal going away, and the work
// itself is on the remote.
//
// Resolved by branch because a restart nulls every agentSessionId, so a job
// whose PR is discovered afterwards would otherwise have nothing to retire and
// its agent would hold a worktree for already-delivered work indefinitely. The
// branch finds it: created per job, not reused while it exists, durable across
// restarts.
//
// Called ONLY at the moment a job leaves in-progress — to Review when its PR
// appears, or straight to Done when the merge sweep catches a PR that opened and
// merged inside one scan — never over jobs already in Review. An agent you
// re-adopt on a shipped branch to address review comments is yours; a poll that
// killed it every five minutes would make Review permanently hostile to working
// on your own PR.
//
// Returns whether it actually closed something. A failure is logged and
// swallowed: the work has shipped either way, so a cleanup that did not work
// must not strand the card in In progress.
async function retireAgentForJob(job, askedBranch, askedSessionId, killSession) {
  if (!killSession) return false;
  const linked = askedSessionId && askedSessionId === job.agentSessionId
    ? sessions.get(askedSessionId)
    : null;
  const session = linked || [...sessions.values()].find(candidate =>
    candidate && !candidate.exited
    && candidate.branchName === askedBranch
    && candidate.repoPath === job.repoPath,
  );
  if (!session || session.exited) return false;
  try {
    if (!job.agentName) job.agentName = session.name;
    await killSession(session.id);
    job.agentSessionId = null;   // only after the kill actually succeeded
    return true;
  } catch (err) {
    console.error(`Failed to close agent for job "${job.title}":`, err.message);
    return false;
  }
}

// `findPr` is injected for the same reason createSession and killSession are:
// an internal call to findPrForBranch is bound directly by the module system
// and cannot be substituted from outside, so the PR-to-review transition would
// otherwise only be testable by talking to GitHub.
export async function checkPullRequests(broadcast, { killSession, findPr = findPrForBranch } = {}) {
  // One-time jobs only. A scheduled card is not trying to produce a pull
  // request, and moving it to Review on the strength of one would take it out of
  // rotation permanently — the column it cycles through is To do, not Review.
  const inProgress = allJobs().filter(j => j.state === 'in-progress' && j.branchName && !isScheduled(j));
  if (inProgress.length === 0) return [];
  const moved = [];
  let noted = false;   // a PR-check failure was recorded on some card
  for (const job of inProgress) {
    // Capture what we are asking about: findPr is a network call, and a
    // requeue or delete during it would otherwise let us apply a PR result to
    // a job that has since moved on — silently undoing the user's action, or
    // killing an agent that belongs to a different attempt.
    const askedBranch = job.branchName;
    const askedSessionId = job.agentSessionId;
    const { pr, error } = await findPr(job.repoPath, askedBranch);

    // Re-validate before touching the job at all. findPr is a network call and
    // WebSocket handlers run during it, so the job may have been deleted,
    // requeued or moved while we waited — writing either a result OR an error
    // onto it then lands on a job that has moved on, or on a detached object.
    if (!allJobs().includes(job) || job.state !== 'in-progress' || job.branchName !== askedBranch) continue;

    if (error) {
      // Say so on the card. Without this the job looks like an agent that went
      // quiet, and the user has no way to learn the board simply cannot see
      // this repo's pull requests. Only written when the message changes, so a
      // persistent failure does not rewrite config.json every five minutes.
      // Its own field, not lastError. A job can already be carrying a restart
      // note naming where its work is, and the two are both true at once: the
      // agent is gone AND the board cannot see this repo's pull requests.
      // Sharing one field meant either clobbering that note or suppressing this
      // one. Written only when the text changes, so a permanent failure does
      // not rewrite config.json every five minutes.
      const message = `Cannot check for a pull request here — ${error}. This job stays put until you move it by hand.`;
      if (notePrCheckError(job, message)) noted = true;
      continue;
    }

    // The query worked, so a previous "cannot check" note is wrong — clear it
    // even when there is still no PR, or a repo that regained access would keep
    // claiming it was unreachable until a PR happened to appear.
    if (clearPrCheckError(job)) noted = true;

    if (!pr) continue;
    job.state = 'review';
    job.prUrl = pr.url;
    job.prNumber = pr.number;
    job.reviewAt = new Date().toISOString();
    // The restart note says the board is still watching for this PR. It just
    // found it, so the note is now false on its own card.
    job.lastError = null;
    job.lastErrorAt = null;
    moved.push(job);

    const closed = await retireAgentForJob(job, askedBranch, askedSessionId, killSession);
    if (broadcast) {
      broadcast({
        type: 'notification', level: 'info',
        message: `Job "${job.title}" moved to Review — PR #${pr.number}`
          + (closed ? ` · ${job.agentName} closed, worktree released` : ''),
      });
    }
  }
  if (moved.length > 0 || noted) persist(broadcast);
  return moved;
}

// -> Done, once the PR has merged.
//
// A merged PR is finished work. Leaving its card in Review means the column
// slowly fills with things nobody has to look at again, and stops meaning
// "needs your review" — so the card leaves the board while the job itself is
// kept, reachable through Finished jobs.
//
// Covers In progress as well as Review, because a PR can open and merge inside
// one scan interval and `gh pr list --state open` cannot see it afterwards: the
// open query returns nothing, so checkPullRequests leaves the job in progress,
// and a Review-only sweep would never look at it. That card would sit in In
// progress forever reading "agent gone", holding a slot on the Jobs tab badge,
// for work that had actually shipped — the exact case this whole change exists
// to file away.
//
// Deliberately narrower than checkPullRequests in three ways:
//
//  - Only MERGED counts, and only THIS card's merge (see parseMergedPr). A PR
//    closed without merging left the work undelivered and someone still has to
//    decide what to do about it, so its card stays.
//  - No agent is retired when finishing from REVIEW. An agent you re-adopted on
//    a shipped branch to address review comments is yours, and this runs every
//    scan — the same reasoning that keeps checkPullRequests' kill at the moment
//    of transition only. Finishing from IN PROGRESS does retire it, because
//    that is a job leaving in-progress, which is exactly what the per-repo cap
//    counts. A manual move to Done retires it too, for the same reason.
export async function checkMergedPullRequests(broadcast, { killSession, findMerged = findMergedPrForBranch } = {}) {
  // prMergedAt is only ever written alongside state 'done', and done is
  // terminal, so the state filter already excludes every stamped job. Kept as a
  // cheap assertion of that invariant rather than a live condition.
  // Scheduled cards are excluded for the same reason checkPullRequests skips
  // them, only more so: done is terminal, so a scheduled run whose work merged
  // would leave the board for good instead of re-arming for its next run.
  // Before the early return, so a card with nothing left to merge still gets
  // its straggler files freed.
  const recleared = clearFinishedAttachments();
  const candidates = allJobs().filter(j =>
    (j.state === 'review' || j.state === 'in-progress') && j.branchName && !j.prMergedAt && !isScheduled(j));
  if (candidates.length === 0) {
    if (recleared) persist(broadcast);
    return [];
  }
  const finished = [];
  let noted = false;   // a PR-check failure was recorded on some card
  for (const job of candidates) {
    // Captured for the same reason checkPullRequests captures them: findMerged
    // is a network call, and a move or delete during it would otherwise let us
    // apply the answer to a job that has since moved on.
    const askedBranch = job.branchName;
    const askedState = job.state;
    const askedSessionId = job.agentSessionId;
    // What makes the answer about this card and not about the branch name: its
    // PR of record when it has one, otherwise the earliest merge that could be
    // its work. Board branch names outlive their branches and get reused.
    const { pr, error } = await findMerged(job.repoPath, askedBranch, {
      prNumber: job.prNumber ?? null,
      mergedAfter: job.reviewAt || job.startedAt || null,
    });

    if (!allJobs().includes(job) || job.state !== askedState || job.branchName !== askedBranch) continue;

    if (error) {
      // Same field as the in-progress check, and for the same reason: the user
      // needs to know the board cannot see this repo's pull requests rather
      // than assuming nothing has merged.
      // Only reported for a Review card. An in-progress job is already covered
      // by checkPullRequests' own note about the same repo, and writing a
      // second one over it would just churn the field between the two sweeps.
      if (askedState === 'review') {
        const message = `Cannot check whether this pull request merged — ${error}. This job stays in Review until you move it by hand.`;
        if (notePrCheckError(job, message)) noted = true;
      }
      continue;
    }

    if (askedState === 'review' && clearPrCheckError(job)) noted = true;

    if (!pr) continue;
    job.state = 'done';
    job.prMergedAt = pr.mergedAt || new Date().toISOString();
    job.doneAt = new Date().toISOString();
    // The merged PR is the authority on where the work ended up: a card that
    // never reached Review has no URL yet, and this is the moment one exists.
    if (pr.url) job.prUrl = pr.url;
    if (pr.number != null) job.prNumber = pr.number;
    if (!job.reviewAt) job.reviewAt = job.doneAt;
    finished.push(job);

    // Leaving in-progress is what the cap counts, so that agent goes — same
    // rule as the PR transition. A card already in Review keeps its agent.
    const closed = askedState === 'in-progress'
      ? await retireAgentForJob(job, askedBranch, askedSessionId, killSession)
      : false;
    // After the retire, so a just-killed agent no longer counts as in use.
    // A card whose live agent was kept holds its files; the retry pass at the
    // top of this sweep frees them once that session exits.
    if (!attachmentsInUse(job)) clearAttachments(job);
    if (broadcast) {
      broadcast({
        type: 'notification', level: 'info',
        message: `Job "${job.title}" is done — PR #${job.prNumber} merged. It moved to Finished jobs.`
          + (closed ? ` · ${job.agentName} closed, worktree released` : ''),
      });
    }
  }
  if (finished.length > 0 || noted || recleared) persist(broadcast);
  return finished;
}

// --- Scheduled runs ---

// Close out scheduled runs that are over and re-arm their cards.
//
// This is the scheduled counterpart of checkPullRequests: the point in the scan
// where a finished run is noticed and its card re-armed. It runs FIRST, so a
// run that ended since the last tick has its card back in To do in time for the
// same scan to dispatch whatever was waiting behind it.
//
// The agent is deliberately NOT killed here. Its terminal is the run's only
// output — a scheduled job need not produce code, and the summary it wrote
// lives in the session's ring buffer, which a kill would destroy before anyone
// could read it. The card keeps a pointer (lastRunSessionId) and the tab stays
// open; the next dispatch retires it, or the user closes it. Bounded at one
// kept agent per card. The cap is unaffected: scheduled cards are exempt from
// it in both directions (see selectDispatchableJobs).
export async function finishScheduledRuns(broadcast) {
  const running = allJobs().filter(j => isScheduled(j) && j.state === 'in-progress');
  if (running.length === 0) return [];
  const finished = [];
  for (const job of running) {
    const session = job.agentSessionId ? sessions.get(job.agentSessionId) : null;
    if (!isScheduledRunOver(job, session)) continue;

    const agentName = job.agentName;
    Object.assign(job, scheduledRunReset(job));
    finished.push(job);
    if (broadcast) {
      broadcast({
        type: 'notification', level: 'info',
        message: `Scheduled job "${job.title}" finished its run`
          + (agentName ? ` · ${agentName} kept open to read` : '')
          + (job.nextRunAt ? ` · next ${new Date(job.nextRunAt).toLocaleString()}` : ''),
      });
    }
  }
  if (finished.length > 0) persist(broadcast);
  return finished;
}

// --- Scan ---

// One scan = close out finished scheduled runs, check for PRs, then dispatch.
// Both entry points (the interval timer and the "Run now" button) go through
// here, behind a single in-flight flag.
//
// The guard is not decorative. dispatchOnce reads job.state to pick candidates,
// then awaits createSession, and only sets state = 'in-progress' after that
// await returns. Two overlapping scans therefore both see the same job as
// 'todo' and both dispatch it: two agents, two worktrees, two branches for one
// job, with job.agentSessionId keeping only the last — the other agent is
// orphaned, invisible to the board, and never cleaned up. It also lets the
// per-repo cap be exceeded, since both scans read the same in-flight count.
// The window is wide (createSession does addRepo + `git worktree add` + a PTY
// spawn) and trivially hit by clicking Run now while a tick is in flight.
let scanInFlight = false;

// findPr/findMerged are forwarded rather than left to their defaults so the
// order of the scan — PRs found, then merges swept, then dispatch — is
// reachable from a test without talking to GitHub.
export async function runScan(createSession, broadcast, { onSessionCreated, killSession, findPr, findMerged } = {}) {
  if (scanInFlight) return { skipped: true };
  scanInFlight = true;
  try {
    await finishScheduledRuns(broadcast);
    await checkPullRequests(broadcast, { killSession, findPr });
    await checkMergedPullRequests(broadcast, { killSession, findMerged });
    await dispatchOnce(createSession, broadcast, { onSessionCreated, killSession });
    return { skipped: false };
  } finally {
    scanInFlight = false;
  }
}

// --- Loop ---

let dispatchTimer = null;

// Self-rescheduling rather than setInterval so a slow git/gh pass can never
// overlap the next tick (same reasoning as startTreeScanLoop in git.js).
export function startDispatcher(createSession, broadcast, { onSessionCreated, killSession } = {}) {
  stopDispatcher();
  const tick = async () => {
    try {
      if (boardSettings().running) {
        await runScan(createSession, broadcast, { onSessionCreated, killSession });
      }
    } catch (err) {
      console.error('Job dispatcher tick failed:', err.message);
    }
    dispatchTimer = setTimeout(tick, boardSettings().intervalMs);
  };
  // First tick soon after start so pressing Start feels responsive, rather than
  // appearing to do nothing until the first full interval elapses.
  dispatchTimer = setTimeout(tick, 2000);
}

export function stopDispatcher() {
  clearTimeout(dispatchTimer);
  dispatchTimer = null;
}
