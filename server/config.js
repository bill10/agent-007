// Config persistence — load, save, orphan tracking, crash recovery

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import {
  config, setConfig, orphans, codenamePool,
  CONFIG_DIR, CONFIG_PATH,
} from './state.js';
import { nextCronIso } from '../lib/cron.js';
import { isScheduled, jobRequiresPr, sessionAgentFromCommand, isValidJobAgent, permissionFlagsFromCommand, recordedPermissionFlags } from '../lib/jobs.js';

export function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      setConfig({ version: 1, repos: [], orphans: [], activeSessions: [], jobs: [], jobBoard: null });
      return;
    }
    const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    setConfig(data);
    if (!config.version) config.version = 1;
    if (!Array.isArray(config.repos)) config.repos = [];
    if (!Array.isArray(config.orphans)) config.orphans = [];
    if (!Array.isArray(config.activeSessions)) config.activeSessions = [];
    if (!Array.isArray(config.jobs)) config.jobs = [];
    // Jobs outlive the server, sessions do not. Every in-progress job now has an
    // agentSessionId pointing at a PTY that no longer exists, so the link goes.
    // What happens next depends on whether the job got as far as a branch:
    //
    //  - No branch: nothing was ever started, so send it back to To do and let
    //    the dispatcher pick it up.
    //  - Has a branch: the agent may already have pushed and opened the PR. It
    //    STAYS in-progress so checkPullRequests can find that PR and move it to
    //    Review. Sending it back to To do would dispatch a second agent onto a
    //    `-2` branch to redo work that is already up for review, and open a
    //    duplicate PR. It does not block the queue: the cap ignores jobs whose
    //    agent is not live, so a null session link keeps the slot free. If
    //    there turns out to be no PR, the card shows "agent gone" and the user
    //    decides — requeue, or recover the branch from the orphans list.
    for (const job of config.jobs) {
      // No session survives a restart, so no stored link can still be valid —
      // and ids are only unique within a process generation, so a stale one can
      // otherwise resolve to an unrelated agent. Cleared for EVERY job, not
      // just the in-flight ones: a review card kept its link forever.
      job.agentSessionId = null;
      // A schedule is never dispatched, but one saved mid-run by a server from
      // before v0.4.9.0 (when it was) goes back to To do, as that server's own
      // restart did. Its agent is dead either way; the note names its branch.
      if (isScheduled(job)) {
        delete job.lastRunSessionId;
        delete job.lastRunAgentName;
      }
      if (isScheduled(job) && job.state !== 'todo') {
        if (job.branchName) {
          job.lastError = `Server restarted mid-run — that run's work is on ${job.branchName} (recover the worktree from the orphans list if you need it).`;
          job.lastErrorAt = new Date().toISOString();
        }
        // Re-armed from now, as the old restart did, so the run a restart cut
        // short does not go straight out again.
        Object.assign(job, {
          state: 'todo', agentName: null, startedAt: null, branchName: null, worktreePath: null,
          nextRunAt: job.schedule ? nextCronIso(job.schedule) : null,
        });
        continue;
      }
      if (job.state !== 'in-progress') continue;
      // agentName is history, not a live link — "Phantom did this work" stays
      // true across a restart, and it is the credit the card exists to show.
      if (!job.branchName) {
        job.state = 'todo';
        job.agentName = null;
        job.startedAt = null;
        continue;
      }
      // A card that needs no PR has nothing for the board to watch: only its
      // agent can finish it, so the note points at re-adopting it instead.
      job.lastError = jobRequiresPr(job)
        ? `Server restarted — agent lost. Work is on ${job.branchName}; the board is still watching for its PR (recover the worktree from the orphans list if it never opened one).`
        : `Server restarted — agent lost. Work is on ${job.branchName}; re-adopt it from the orphans list so it can finish, or move this card by hand.`;
      job.lastErrorAt = new Date().toISOString();
    }
    for (const o of config.orphans) {
      orphans.set(o.id, o);
      codenamePool.addUsed(o.name);
      if (o.worktreePath) codenamePool.addUsed(basename(o.worktreePath)); // the label may have been renamed
    }
  } catch (err) {
    console.warn('Config corrupted, starting with empty config:', err.message);
    setConfig({ version: 1, repos: [], orphans: [], activeSessions: [], jobs: [], jobBoard: null });
  }
}

export function saveConfig(broadcast) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Failed to save config:', err.message);
    if (broadcast) broadcast({ type: 'notification', level: 'error', message: 'Failed to save config: ' + err.message });
  }
}

export function syncOrphansToConfig(broadcast) {
  config.orphans = [...orphans.values()];
  saveConfig(broadcast);
}

export function saveActiveSession(session, broadcast) {
  if (!session.worktreePath) return;
  config.activeSessions.push({
    name: session.name,
    repoPath: session.repoPath,
    repoSlug: session.repoSlug,
    worktreePath: session.worktreePath,
    branchName: session.branchName,
    color: session.color,
    cocktail: session.cocktail,
    ownerId: session.ownerId || null,
    // Which CLI to resume with if this session has to be re-adopted after a
    // restart: the orphan it becomes inherits it (recoverCrashedSessions).
    // null when nobody knows, so the fallbacks get to answer.
    agent: sessionAgent(session),
    permissionFlags: sessionPermissionFlags(session),
    origin: sessionOrigin(session),
    // The card it works on, so a re-spawn after a restart is that card's
    // worker again rather than a stranger on its branch.
    jobId: session.jobId || null,
    approvalsToBillion: !!session.approvalsToBillion,
    savedAt: new Date().toISOString(),
  });
  saveConfig(broadcast);
}

// The session's own note when it carries one (every PTY session does, see
// createSessionFromConfig); read off the command otherwise.
export function sessionAgent(session) {
  return session.agent !== undefined ? session.agent : sessionAgentFromCommand(session.command);
}

// The permission flags the session was spawned with (see createSessionFromConfig);
// read off the command for a session object that does not carry them.
// 'board' for a session dispatched by the board, or re-adopted from one, else 'user'.
export function sessionOrigin(session) {
  return session.origin === 'board' || (session.origin === undefined && session.spawnedBy === 'board') ? 'board' : 'user';
}

export function sessionPermissionFlags(session) {
  return Array.isArray(session.permissionFlags) ? session.permissionFlags : permissionFlagsFromCommand(session.command);
}

export function removeActiveSession(worktreePath, broadcast) {
  if (!worktreePath) return;
  config.activeSessions = config.activeSessions.filter(s => s.worktreePath !== worktreePath);
  saveConfig(broadcast);
}

export function recoverCrashedSessions(broadcast) {
  const crashed = config.activeSessions || [];
  if (crashed.length === 0) return;
  for (const s of crashed) {
    if (!existsSync(s.worktreePath)) continue;
    if ([...orphans.values()].some(o => o.worktreePath === s.worktreePath)) continue;
    const orphanId = `orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const orphan = {
      id: orphanId,
      name: s.name,
      repoPath: s.repoPath,
      repoSlug: s.repoSlug,
      worktreePath: s.worktreePath,
      branchName: s.branchName,
      color: s.color,
      ownerId: s.ownerId || null,
      // Absent in a config written before it was recorded; a value that is not
      // one of ours (config.json is hand-editable) is dropped rather than
      // carried forward as a note.
      agent: isValidJobAgent(s.agent) ? s.agent : null,
      permissionFlags: recordedPermissionFlags(s),
      origin: s.origin === 'board' ? 'board' : 'user',
      jobId: typeof s.jobId === 'string' ? s.jobId : null,
      approvalsToBillion: s.approvalsToBillion === true,
      reason: 'server-restart',
      createdAt: new Date().toISOString(),
    };
    orphans.set(orphanId, orphan);
    codenamePool.addUsed(s.name);
    codenamePool.addUsed(basename(s.worktreePath));
    console.log(`Recovered crashed session: ${s.name} in ${s.repoPath}`);
  }
  config.activeSessions = [];
  syncOrphansToConfig(broadcast);
}
