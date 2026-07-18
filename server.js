#!/usr/bin/env node

// Agent 007 — Entry point + orchestrator functions
//
// Architecture:
//   server.js        Entry point, createSession/killSession orchestrators
//   server/state.js  Shared mutable state (sessions, orphans, pools, config)
//   server/config.js Config persistence (load, save, crash recovery)
//   server/git.js    Git operations (worktree, file tree, diff)
//   server/pty.js    PTY lifecycle (spawn, handlers, state detection)
//   server/ws.js     WebSocket (message routing, broadcast, origin check)
//   server/http.js   HTTP routes (/api/browse, origin check middleware)

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { mkdirSync } from 'fs';

import {
  PORT, HOST, LOOPBACK_HOSTS, WILDCARD_BIND_HOSTS, WORKTREE_DIR, sessions,
  codenamePool, cocktailPool, colorCycler, nextSessionId,
} from './server/state.js';
import { loadConfig, recoverCrashedSessions, saveActiveSession, removeActiveSession, syncOrphansToConfig } from './server/config.js';
import { addRepo, createWorktree, removeWorktree, pruneWorktrees, scanForOrphanedWorktrees, scanFileTree, detectConflicts, gitExec } from './server/git.js';
import { createSessionFromConfig } from './server/pty.js';
import { setupWebSocket, broadcast, sessionPayload, broadcastOrphansList, verifyClient } from './server/ws.js';
import { setupRoutes } from './server/http.js';
import { orphans } from './server/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, verifyClient });

// --- HTTP routes ---
setupRoutes(app, join(__dirname, 'public'));

// --- Orchestrators ---
// These span multiple modules (git, pty, config, ws) and stay here.

async function createSession(command, name, repoPath, customBranch, ownerId) {
  const sessionId = nextSessionId();
  const agentName = name || codenamePool.pick();
  if (name) codenamePool.addUsed(name);
  const color = colorCycler.next();

  let worktreePath = null;
  let branchName = null;
  let repoSlug = null;
  let resolvedRepoPath = null;
  let cocktail = null;

  if (repoPath) {
    const result = await addRepo(repoPath, broadcast);
    if (result.error) { codenamePool.recycle(agentName); return { error: result.error }; }
    resolvedRepoPath = result.path;
    repoSlug = result.slug;
    cocktail = customBranch || cocktailPool.pick(resolvedRepoPath);
    const wtResult = await createWorktree(resolvedRepoPath, agentName, cocktail);
    if (wtResult.error) {
      codenamePool.recycle(agentName);
      if (!customBranch) cocktailPool.recycle(resolvedRepoPath, cocktail);
      return { error: wtResult.error };
    }
    worktreePath = wtResult.worktreePath;
    branchName = wtResult.branchName;
  }

  const result = createSessionFromConfig({
    sessionId, name: agentName, color, command,
    repoPath: resolvedRepoPath, worktreePath, branchName,
    repoSlug, cocktail, ownerId: ownerId || null,
  }, broadcast);

  if (result.error) {
    codenamePool.recycle(agentName);
    if (resolvedRepoPath && cocktail && !customBranch) cocktailPool.recycle(resolvedRepoPath, cocktail);
    // Spawn failed after the worktree was created — remove it and its branch
    // so a bad command doesn't leak a worktree + branch on disk.
    if (worktreePath && resolvedRepoPath) {
      try {
        await gitExec(['-C', resolvedRepoPath, 'worktree', 'remove', '--force', worktreePath]);
      } catch (e) {
        console.error(`Failed to remove worktree ${worktreePath}:`, e.message);
      }
      if (branchName) {
        try {
          await gitExec(['-C', resolvedRepoPath, 'branch', '-D', branchName]);
        } catch (e) {
          console.error(`Failed to delete branch ${branchName}:`, e.message);
        }
      }
    }
    return { error: result.error };
  }

  const session = result.session;
  sessions.set(sessionId, session);
  saveActiveSession(session, broadcast);

  if (worktreePath) {
    session.scanTimer = setTimeout(() => scanFileTree(session, broadcast), 1000);
  }

  return { session };
}

async function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearInterval(session.stateCheckInterval);
  clearTimeout(session.scanTimer);
  try { session.pty.kill(); } catch {}

  removeActiveSession(session.worktreePath, broadcast);
  const { orphaned, reason } = await removeWorktree(session);

  if (orphaned) {
    const orphanId = `orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const orphan = {
      id: orphanId, name: session.name, repoPath: session.repoPath,
      repoSlug: session.repoSlug, worktreePath: session.worktreePath,
      branchName: session.branchName, color: session.color,
      ownerId: session.ownerId || null,
      reason, createdAt: new Date().toISOString(),
    };
    orphans.set(orphanId, orphan);
    syncOrphansToConfig(broadcast);
    broadcastOrphansList();
    broadcast({ type: 'notification', level: 'info', message: `${session.name} orphaned — worktree kept (${reason} changes)` });
  } else {
    codenamePool.recycle(session.name);
    if (session.repoPath && session.cocktail) cocktailPool.recycle(session.repoPath, session.cocktail);
  }
  sessions.delete(sessionId);
}

// --- WebSocket ---
setupWebSocket(wss, { createSession, killSession });

// --- Startup ---
async function startup() {
  loadConfig();
  recoverCrashedSessions(broadcast);
  mkdirSync(WORKTREE_DIR, { recursive: true });
  await pruneWorktrees();
  await scanForOrphanedWorktrees(broadcast);
  server.listen(PORT, HOST, () => {
    // Bracket IPv6 literals so the URL is valid/clickable; show wildcard binds as localhost.
    const bracket = (h) => h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
    const displayHost = WILDCARD_BIND_HOSTS.includes(HOST) ? 'localhost' : bracket(HOST);
    console.log(`\n  Agent 007 is running at http://${displayHost}:${PORT}`);
    if (!LOOPBACK_HOSTS.includes(HOST)) {
      console.log(`  Listening on ${bracket(HOST)}:${PORT} — reachable from other machines. Keep this behind Tailscale/a trusted network.`);
    }
    console.log('');
  });
}

// --- Graceful Shutdown (B10) ---
// Wait for PTY processes to exit with 3s timeout, then force kill.
function gracefulShutdown() {
  console.log('\nShutting down...');
  const killPromises = [];
  for (const [, session] of sessions) {
    clearInterval(session.stateCheckInterval);
    clearTimeout(session.scanTimer);
    if (!session.exited) {
      killPromises.push(new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { process.kill(session.pty.pid, 'SIGKILL'); } catch {}
          resolve();
        }, 3000);
        session.pty.onExit(() => { clearTimeout(timer); resolve(); });
        try { session.pty.kill(); } catch { clearTimeout(timer); resolve(); }
      }));
    }
  }
  if (killPromises.length === 0) { process.exit(0); return; }
  Promise.all(killPromises).then(() => process.exit(0));
  // Hard deadline: exit after 5s no matter what
  setTimeout(() => process.exit(1), 5000).unref();
}

// --- Exports for testing ---
export { app, server, wss, startup, gracefulShutdown, sessions, createSession, killSession };

// Auto-start when run directly
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  startup();
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}
