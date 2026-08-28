#!/usr/bin/env node

// Agent 007 — Entry point + orchestrator functions
//
// Architecture:
//   server.js        Entry point, createSession/killSession orchestrators
//   server/state.js  Shared mutable state (sessions, orphans, pools, config)
//   server/config.js Config persistence (load, save, crash recovery)
//   server/git.js    Git operations (worktree, file tree, diff)
//   server/pty.js    PTY lifecycle (spawn, handlers, state detection)
//   server/jobs.js   Job board (persistence, dispatcher loop, PR watching)
//   server/ws.js     WebSocket (message routing, broadcast, origin check)
//   server/http.js   HTTP routes (/api/browse, origin check middleware)

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath, pathToFileURL } from 'url';
import { isDirectRun } from './server/direct-run.js';
import { dirname, join, basename } from 'path';
import { mkdirSync } from 'fs';

import {
  PORT, HOST, LOOPBACK_HOSTS, WILDCARD_BIND_HOSTS, WORKTREE_DIR, sessions,
  codenamePool, colorCycler, nextSessionId,
} from './server/state.js';
import { loadConfig, recoverCrashedSessions, saveActiveSession, removeActiveSession, syncOrphansToConfig } from './server/config.js';
import { addRepo, createWorktree, removeWorktree, pruneWorktrees, scanForOrphanedWorktrees, startTreeScanLoop, detectConflicts, gitExec, deleteBranch } from './server/git.js';
import { createSessionFromConfig } from './server/pty.js';
import { setupWebSocket, broadcast, sessionPayload, broadcastOrphansList, verifyClient } from './server/ws.js';
import { setupRoutes } from './server/http.js';
import { startDispatcher, stopDispatcher, boardSettings } from './server/jobs.js';
import { orphans } from './server/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, verifyClient });

// --- HTTP routes ---
setupRoutes(app, join(__dirname, 'public'));

// --- Orchestrators ---
// These span multiple modules (git, pty, config, ws) and stay here.

async function createSession(command, name, repoPath, customBranch, ownerId, meta = {}) {
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
    // createWorktree picks the name by trying it against git, so it reports back
    // which cocktail actually landed. Nothing to reserve or release here.
    const wtResult = await createWorktree(resolvedRepoPath, agentName, customBranch, {
      suffixOnCollision: !!meta.branchSuffixOnCollision,
    });
    if (wtResult.error) {
      codenamePool.recycle(agentName);
      return { error: wtResult.error };
    }
    worktreePath = wtResult.worktreePath;
    branchName = wtResult.branchName;
    cocktail = wtResult.cocktail;
  }

  const result = createSessionFromConfig({
    sessionId, name: agentName, color, command,
    repoPath: resolvedRepoPath, worktreePath, branchName,
    repoSlug, cocktail, ownerId: ownerId || null,
    spawnedBy: meta.spawnedBy || 'user', jobId: meta.jobId || null,
  }, broadcast);

  if (result.error) {
    codenamePool.recycle(agentName);
    // Spawn failed after the worktree was created — remove it and its branch
    // so a bad command doesn't leak a worktree + branch on disk.
    if (worktreePath && resolvedRepoPath) {
      try {
        await gitExec(['-C', resolvedRepoPath, 'worktree', 'remove', '--force', worktreePath]);
      } catch (e) {
        console.error(`Failed to remove worktree ${worktreePath}:`, e.message);
      }
      await deleteBranch(resolvedRepoPath, branchName);
    }
    return { error: result.error };
  }

  const session = result.session;
  sessions.set(sessionId, session);
  saveActiveSession(session, broadcast);

  if (worktreePath) {
    startTreeScanLoop(session, broadcast);
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
  // The loop always runs; each tick is a no-op while settings.running is false.
  // Keeping one timer alive (instead of creating/destroying it on toggle) means
  // the Start button only has to flip a boolean, and a config restored with
  // running:true resumes dispatching without any extra wiring.
  startDispatcher(createSession, broadcast, {
    onSessionCreated: (s) => broadcast(sessionPayload(s)),
    killSession,
  });
  if (boardSettings().running) console.log('  Job board dispatcher: running');
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
  stopDispatcher();
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
if (isDirectRun(import.meta.url, process.argv[1])) {
  startup();
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
} else if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  // The launched file has this file's name but the URLs still differ — a
  // path-resolution miss, not a deliberate import. Say so instead of exiting
  // 0 with no output (the failure mode this guard has silently hit before).
  console.error(
    `server.js entry-point guard mismatch: ${pathToFileURL(process.argv[1]).href} vs ${import.meta.url} — not auto-starting.`
  );
}
