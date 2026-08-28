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
export async function moveJob(jobId, state, broadcast, { killSession, findPr = findPrForBranch } = {}) {
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
  // A manual move means "the PR was opened outside the board". Look it up, or
  // the card sits in Review with no link to the thing it produced — nothing
  // else backfills it, since the watcher only examines in-progress jobs.
  if (state === 'review' && !job.prNumber && job.branchName) {
    // Best-effort: a lookup that fails must not abandon the move half-applied,
    // with the state changed in memory but never persisted and the agent never
    // retired. The card just goes without its link, as it did before.
    try {
      const { pr } = await findPr(job.repoPath, job.branchName);
      if (pr) {
        job.prUrl = pr.url;
        job.prNumber = pr.number;
        job.lastError = null;
        job.lastErrorAt = null;
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

async function prListOnce(repoPath, branchName, token) {
  try {
    const stdout = await runGh(
      ['pr', 'list', '--head', branchName, '--state', 'open', '--json', 'number,url,state,isDraft'],
      { cwd: repoPath, token },
    );
    return { pr: parsePrList(stdout) };
  } catch (err) {
    // First line only: gh errors are one useful line plus usage noise.
    const detail = String(err.stderr || err.message || '').trim().split('\n')[0].slice(0, 200);
    return { error: detail || 'gh pr list failed' };
  }
}

// `gh pr list` against the repo, filtered to the job's branch. Runs in the main
// repo (not the worktree) so it still works after the worktree is removed.
//
// Tries EVERY signed-in gh account before giving up. One machine can hold
// several, and a private repo is usually visible to exactly one of them — this
// app routinely manages repos owned by different accounts, so the signed-in
// account failing says nothing about whether the PR exists. Observed:
// `Could not resolve to a Repository` from the active account while another
// account on the same machine could see the repo perfectly well.
//
// Returns { pr } on a successful query — pr null meaning "no PR yet" — or
// { pr: null, error } only when EVERY account failed. An earlier version
// collapsed both into null, so a repo the board could never see looked exactly
// like a branch with no PR, and its jobs sat in progress forever unexplained.
//
// The three collaborators are injectable for the same reason createSession and
// killSession are: otherwise the account walk — ordering, dedup, remembering,
// error aggregation — is only reachable by talking to real GitHub accounts.
export async function findPrForBranch(repoPath, branchName, {
  listAccounts = ghAccounts,
  tokenFor = ghToken,
  prList = prListOnce,
} = {}) {
  if (!repoPath || !branchName || !existsSync(repoPath)) return { pr: null };
  try {
    const stdout = await gitExec(['-C', repoPath, 'rev-parse', '--git-dir']);
    if (!stdout) return { pr: null };
  } catch { return { pr: null }; }

  // Label for a lookup that uses no explicit token — whatever gh picks itself.
  const AMBIENT = 'signed-in account';
  const tried = [];
  const failures = [];

  const attempt = async (label, token) => {
    if (tried.includes(label)) return null;
    tried.push(label);
    const result = await prList(repoPath, branchName, token);
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
      if (hit) return hit;
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
    if (hit) { ghAccountForRepo.set(repoPath, login); return hit; }
  }

  // 3. Last resort: no explicit token. Covers a token supplied through the
  //    environment, an enterprise host, and older gh versions whose auth status
  //    this cannot enumerate.
  const ambient = await attempt(AMBIENT, undefined);
  if (ambient) { ghAccountForRepo.delete(repoPath); return ambient; }

  ghAccountForRepo.delete(repoPath);
  const plural = tried.length === 1 ? '' : 's';
  return {
    pr: null,
    error: `${failures[0] || 'gh pr list failed'} (tried ${tried.length} account${plural}: ${tried.join(', ')})`,
  };
}

// `findPr` is injected for the same reason createSession and killSession are:
// an internal call to findPrForBranch is bound directly by the module system
// and cannot be substituted from outside, so the PR-to-review transition would
// otherwise only be testable by talking to GitHub.
export async function checkPullRequests(broadcast, { killSession, findPr = findPrForBranch } = {}) {
  const inProgress = allJobs().filter(j => j.state === 'in-progress' && j.branchName);
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
      if (job.prCheckError !== message) {
        job.prCheckError = message;
        job.prCheckErrorAt = new Date().toISOString();
        noted = true;
      }
      continue;
    }

    // The query worked, so a previous "cannot check" note is wrong — clear it
    // even when there is still no PR, or a repo that regained access would keep
    // claiming it was unreachable until a PR happened to appear.
    if (job.prCheckError) {
      job.prCheckError = null;
      job.prCheckErrorAt = null;
      noted = true;
    }

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

    // Always retire the agent. This is what keeps the per-repo cap meaningful:
    // in-progress jobs and live agents stay the same set, so nothing
    // accumulates. killSession -> removeWorktree deletes the worktree and the
    // local branch (fully pushed by then); the PR is untouched. The card keeps
    // the whole record — agent name, branch, PR link — so nothing is lost by
    // the terminal going away, and the work itself is on the remote.
    // Retire the agent, resolving it by branch when the stored link is gone.
    //
    // A restart nulls every agentSessionId, so a job whose PR is discovered
    // afterwards would reach review with nothing to retire, and its agent would
    // hold a worktree for already-delivered work indefinitely. The branch finds
    // it: created per job, not reused while it exists, durable across restarts.
    //
    // Deliberately only at the moment of transition, never as a recurring sweep
    // over jobs already in review. An agent you re-adopt on a shipped branch to
    // address review comments is yours; a poll that killed it every five minutes
    // would make Review permanently hostile to working on your own PR.
    let closed = false;
    if (killSession) {
      const linked = askedSessionId && askedSessionId === job.agentSessionId
        ? sessions.get(askedSessionId)
        : null;
      const session = linked || [...sessions.values()].find(candidate =>
        candidate && !candidate.exited
        && candidate.branchName === askedBranch
        && candidate.repoPath === job.repoPath,
      );
      if (session && !session.exited) {
        try {
          if (!job.agentName) job.agentName = session.name;
          await killSession(session.id);
          job.agentSessionId = null;   // only after the kill actually succeeded
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
  if (moved.length > 0 || noted) persist(broadcast);
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
