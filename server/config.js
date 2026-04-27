// Config persistence — load, save, orphan tracking, crash recovery

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  config, setConfig, orphans, codenamePool, cocktailPool,
  CONFIG_DIR, CONFIG_PATH,
} from './state.js';

export function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      setConfig({ version: 1, repos: [], orphans: [], activeSessions: [] });
      return;
    }
    const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    setConfig(data);
    if (!config.version) config.version = 1;
    if (!Array.isArray(config.repos)) config.repos = [];
    if (!Array.isArray(config.orphans)) config.orphans = [];
    if (!Array.isArray(config.activeSessions)) config.activeSessions = [];
    for (const o of config.orphans) {
      orphans.set(o.id, o);
      codenamePool.addUsed(o.name);
      if (o.branchName && o.branchName.includes('/')) {
        cocktailPool.addUsed(o.repoPath, o.branchName.split('/').pop());
      }
    }
  } catch (err) {
    console.warn('Config corrupted, starting with empty config:', err.message);
    setConfig({ version: 1, repos: [], orphans: [], activeSessions: [] });
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
      reason: 'server-restart',
      createdAt: new Date().toISOString(),
    };
    orphans.set(orphanId, orphan);
    codenamePool.addUsed(s.name);
    if (s.branchName && s.branchName.includes('/')) {
      cocktailPool.addUsed(s.repoPath, s.branchName.split('/').pop());
    }
    console.log(`Recovered crashed session: ${s.name} in ${s.repoPath}`);
  }
  config.activeSessions = [];
  syncOrphansToConfig(broadcast);
}
