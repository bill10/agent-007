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
import { existsSync } from 'fs';
import { config, sessions } from './state.js';
import { saveConfig } from './config.js';
import { gitExec } from './git.js';
import {
  createJob, selectDispatchableJobs, buildJobCommand, deriveJobStatus,
  parsePrList, branchSlugFromTitle, isValidPermissionMode, JOB_STATES,
  DISPATCH_INTERVAL_MS, MAX_AGENTS_PER_REPO, DEFAULT_PERMISSION_MODE,
  MAX_TITLE_LEN, MAX_DETAIL_LEN,
} from '../lib/jobs.js';

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

// --- CRUD ---

export function addJob({ title, detail, repoPath, postedBy, postedByName }, broadcast) {
  const result = createJob({ title, detail, repoPath, postedBy, postedByName });
  if (result.error) return result;
  allJobs().push(result.job);
  persist(broadcast);
  return { job: result.job };
}

export function updateJob(jobId, fields, broadcast) {
  const job = allJobs().find(j => j.id === jobId);
  if (!job) return { error: 'Job not found' };
  if (typeof fields.title === 'string' && fields.title.trim()) job.title = fields.title.trim().slice(0, MAX_TITLE_LEN);
  if (typeof fields.detail === 'string') job.detail = fields.detail.trim().slice(0, MAX_DETAIL_LEN);
  // The repo is only editable while the job is still unassigned — once an agent
  // is working in a worktree, repointing the card would misattribute the work.
  if (fields.repoPath && job.state === 'todo') job.repoPath = fields.repoPath;
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
  if (removed.agentSessionId && killSession) {
    const session = sessions.get(removed.agentSessionId);
    if (session && !session.exited) {
      try {
        await killSession(removed.agentSessionId);
      } catch (err) {
        console.error(`Failed to close agent for deleted job "${removed.title}":`, err.message);
      }
    }
  }
  return { job: removed };
}

// Manual move (the buttons on a card). Kept deliberately permissive: automatic
// transitions can be wrong, so the user always has the last word.
//
// Moving back to To do also RETIRES the job's agent. Unlinking it without
// killing it left a running agent that no job pointed at: it no longer counted
// toward the per-repo cap, so the board would dispatch a replacement alongside
// it, and repeating the move walks straight past the cap. Retiring it keeps the
// same invariant the PR path relies on — in-progress jobs and live board agents
// are the same set. removeWorktree still protects the work: uncommitted or
// unpushed changes become an orphan rather than being deleted.
export async function moveJob(jobId, state, broadcast, { killSession } = {}) {
  if (!JOB_STATES.includes(state)) return { error: `Unknown state "${state}"` };
  const job = allJobs().find(j => j.id === jobId);
  if (!job) return { error: 'Job not found' };
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
  const retiringSessionId = (state === 'todo' || state === 'review') ? job.agentSessionId : null;
  job.state = state;
  if (state === 'todo') {
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
  // Persist and repaint before the kill so the card moves immediately; the kill
  // then emits its own session-ended and orphan notifications.
  persist(broadcast);
  if (retiringSessionId && killSession) {
    const session = sessions.get(retiringSessionId);
    if (session && !session.exited) {
      try {
        await killSession(retiringSessionId);
      } catch (err) {
        console.error(`Failed to close agent for job "${job.title}":`, err.message);
      }
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

    if (onSessionCreated) onSessionCreated(session);
    job.state = 'in-progress';
    job.agentSessionId = session.id;
    job.agentName = session.name;
    job.startedAt = new Date().toISOString();
    job.branchName = session.branchName;
    job.worktreePath = session.worktreePath;
    job.lastError = null;
    job.lastErrorAt = null;
    dispatched.push({ job, session });
  }
  if (dispatched.length > 0 || candidates.length > 0) persist(broadcast);
  return dispatched;
}

// --- PR watching ---

// `gh pr list` against the repo, filtered to the job's branch. Runs in the main
// repo (not the worktree) so it still works after the worktree is removed.
export async function findPrForBranch(repoPath, branchName) {
  if (!repoPath || !branchName || !existsSync(repoPath)) return null;
  try {
    const stdout = await gitExec(['-C', repoPath, 'rev-parse', '--git-dir']);
    if (!stdout) return null;
  } catch { return null; }
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('gh', ['pr', 'list', '--head', branchName, '--state', 'open', '--json', 'number,url,state,isDraft'],
        { cwd: repoPath, timeout: 15_000, maxBuffer: 1024 * 1024 },
        (err, out, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(out)));
    });
    return parsePrList(stdout);
  } catch (err) {
    // gh missing, not authenticated, or no GitHub remote. Not an error worth
    // spamming: the board falls back to the manual "Move to review" button.
    return null;
  }
}

// `findPr` is injected for the same reason createSession and killSession are:
// an internal call to findPrForBranch is bound directly by the module system
// and cannot be substituted from outside, so the PR-to-review transition would
// otherwise only be testable by talking to GitHub.
export async function checkPullRequests(broadcast, { killSession, findPr = findPrForBranch } = {}) {
  const inProgress = allJobs().filter(j => j.state === 'in-progress' && j.branchName);
  if (inProgress.length === 0) return [];
  const moved = [];
  for (const job of inProgress) {
    // Capture what we are asking about: findPr is a network call, and a
    // requeue or delete during it would otherwise let us apply a PR result to
    // a job that has since moved on — silently undoing the user's action, or
    // killing an agent that belongs to a different attempt.
    const askedBranch = job.branchName;
    const askedSessionId = job.agentSessionId;
    const pr = await findPr(job.repoPath, askedBranch);
    if (!pr) continue;
    if (!allJobs().includes(job) || job.state !== 'in-progress' || job.branchName !== askedBranch) continue;
    job.state = 'review';
    job.prUrl = pr.url;
    job.prNumber = pr.number;
    job.reviewAt = new Date().toISOString();
    moved.push(job);

    // Always retire the agent. This is what keeps the per-repo cap meaningful:
    // in-progress jobs and live agents stay the same set, so nothing
    // accumulates. killSession -> removeWorktree deletes the worktree and the
    // local branch (fully pushed by then); the PR is untouched. The card keeps
    // the whole record — agent name, branch, PR link — so nothing is lost by
    // the terminal going away, and the work itself is on the remote.
    let closed = false;
    if (killSession && askedSessionId && askedSessionId === job.agentSessionId) {
      const session = sessions.get(askedSessionId);
      if (session && !session.exited) {
        try {
          await killSession(askedSessionId);
          closed = true;
        } catch (err) {
          // A failed cleanup must not strand the card in In progress: the PR
          // is open either way, so the job is genuinely ready for review.
          console.error(`Failed to close agent for job "${job.title}":`, err.message);
        }
      }
    }
    if (broadcast) {
      broadcast({
        type: 'notification', level: 'info',
        message: `Job "${job.title}" moved to Review — PR #${pr.number}`
          + (closed ? ` · ${job.agentName} closed, worktree released` : ''),
      });
    }
  }
  if (moved.length > 0) persist(broadcast);
  return moved;
}

// --- Scan ---

// One scan = check for PRs, then dispatch. Both entry points (the interval
// timer and the "Run now" button) go through here, behind a single in-flight
// flag.
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

export async function runScan(createSession, broadcast, { onSessionCreated, killSession } = {}) {
  if (scanInFlight) return { skipped: true };
  scanInFlight = true;
  try {
    await checkPullRequests(broadcast, { killSession });
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
