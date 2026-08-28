// Config persistence — load, save, orphan tracking, crash recovery

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  config, setConfig, orphans, codenamePool,
  CONFIG_DIR, CONFIG_PATH,
} from './state.js';

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
      if (job.state !== 'in-progress') continue;
      job.agentSessionId = null;
      job.agentName = null;
      if (!job.branchName) {
        job.state = 'todo';
        job.startedAt = null;
        continue;
      }
      job.lastError = `Server restarted — agent lost. Work is on ${job.branchName}; the board is still watching for its PR (recover the worktree from the orphans list if it never opened one).`;
      job.lastErrorAt = new Date().toISOString();
    }
    for (const o of config.orphans) {
      orphans.set(o.id, o);
      codenamePool.addUsed(o.name);
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
    savedAt: new Date().toISOString(),
  });
  saveConfig(broadcast);
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
      reason: 'server-restart',
      createdAt: new Date().toISOString(),
    };
    orphans.set(orphanId, orphan);
    codenamePool.addUsed(s.name);
    console.log(`Recovered crashed session: ${s.name} in ${s.repoPath}`);
  }
  config.activeSessions = [];
  syncOrphansToConfig(broadcast);
}
