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
    // Jobs outlive the server, sessions do not. Any job left mid-flight by a
    // shutdown has an agentSessionId pointing at a PTY that no longer exists,
    // so clear the link and send it back to To do — the dispatcher will pick it
    // up again. The worktree it was using survives as an orphan, recoverable
    // from the explorer exactly like any other interrupted agent.
    for (const job of config.jobs) {
      if (job.state === 'in-progress') {
        job.state = 'todo';
        job.agentSessionId = null;
        job.agentName = null;
        job.startedAt = null;
        // Keep branchName/worktreePath: they point at real work now sitting in
        // an orphaned worktree. Surfacing it on the card via the existing error
        // line is the difference between recovering that branch and losing it.
        if (job.branchName) {
          job.lastError = `Server restarted — agent lost. Previous work is on ${job.branchName} (recover it from the orphans list).`;
          job.lastErrorAt = new Date().toISOString();
        }
      }
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
