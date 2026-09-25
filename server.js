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
//   server/http.js   HTTP routes (/api/browse, /api/jobs, /mcp, origin + auth)

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
import { loadConfig, recoverCrashedSessions, saveActiveSession, removeActiveSession, syncOrphansToConfig, sessionAgent, sessionPermissionFlags, sessionOrigin } from './server/config.js';
import { addRepo, createWorktree, removeWorktree, pruneWorktrees, scanForOrphanedWorktrees, startTreeScanLoop, detectConflicts, gitExec, deleteBranch } from './server/git.js';
import { createSessionFromConfig } from './server/pty.js';
import { setupWebSocket, broadcast, sessionPayload, broadcastOrphansList, verifyClient } from './server/ws.js';
import { setupRoutes } from './server/http.js';
import { startDispatcher, stopDispatcher, boardSettings } from './server/jobs.js';
import { orphans, config } from './server/state.js';
import { sweepMcpConfigs } from './server/agent-mcp.js';
import { BILLION_NAME, billionEnabled, billionDir, ensureBillionRepo, suggestProjectsDir, billionCommand } from './server/billion.js';
import { transcriptsFor } from './server/agent-transcripts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, verifyClient });

// --- HTTP routes ---
// broadcast is injected for the same reason server/jobs.js takes it as an
// argument: http.js must not import ws.js, and a job posted through the MCP
// tool has to repaint every open board the moment it lands.
setupRoutes(app, join(__dirname, 'public'), { broadcast });

// --- Orchestrators ---
// These span multiple modules (git, pty, config, ws) and stay here.

async function createSession(command, name, repoPath, customBranch, ownerId, meta = {}) {
  // A custom name must not already be a live label, an orphan's label, or a
  // worktree directory's codename: two holders of one name means the first
  // kill frees it while the other still names a directory on disk.
  if (name && codenamePool.has(name)) return { error: `An agent named ${name} already exists` };
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
      startPoint: meta.startPoint || null,
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

async function killSession(sessionId, { discardChanges = false } = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearInterval(session.stateCheckInterval);
  clearTimeout(session.scanTimer);
  try { session.pty.kill(); } catch {}

  removeActiveSession(session.worktreePath, broadcast);
  const { orphaned, reason } = await removeWorktree(session, { discardChanges });

  if (orphaned) {
    const orphanId = `orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const orphan = {
      id: orphanId, name: session.name, repoPath: session.repoPath,
      repoSlug: session.repoSlug, worktreePath: session.worktreePath,
      branchName: session.branchName, color: session.color,
      ownerId: session.ownerId || null,
      agent: sessionAgent(session),
      permissionFlags: sessionPermissionFlags(session),
      origin: sessionOrigin(session),
      reason, createdAt: new Date().toISOString(),
    };
    orphans.set(orphanId, orphan);
    syncOrphansToConfig(broadcast);
    broadcastOrphansList();
    broadcast({ type: 'notification', level: 'info', message: `${session.name} orphaned — worktree kept (${reason} changes)` });
  } else if (!session.isBillion) {   // Billion's name stays reserved for its next start
    codenamePool.recycle(session.name);
    if (session.worktreePath) codenamePool.recycle(basename(session.worktreePath)); // differs after a rename
  }
  sessions.delete(sessionId);
}

// Billion (server/billion.js): started at boot, and again only when someone
// asks — an agent that crashes in a loop is worse than one that stays stopped.
// Returns the running one if there is one.
function startBillion() {
  for (const [id, s] of sessions) {
    if (!s.isBillion) continue;
    if (!s.exited) return { session: s };
    sessions.delete(id);   // a stopped one's tab goes; the new one replaces it
  }
  const dir = billionDir();
  let created;
  try {
    ({ created } = ensureBillionRepo(dir));
  } catch (err) {
    console.error(`Billion: could not set up ${dir}:`, err.message);
    return { error: `Could not set up Billion's folder ${dir}: ${err.message}` };
  }
  const command = billionCommand({
    created,
    hasConversation: !created && transcriptsFor(dir).agent === 'claude',
    dir,
    projectsHint: suggestProjectsDir(config.repos.map(r => r.path)),
  });
  const result = createSessionFromConfig({
    sessionId: nextSessionId(), name: BILLION_NAME, color: colorCycler.next(), command,
    repoPath: null, worktreePath: null, cwd: dir, isBillion: true, ownerId: null,
  }, broadcast);
  if (result.error) return result;
  sessions.set(result.session.id, result.session);
  return { session: result.session };
}

// --- WebSocket ---
setupWebSocket(wss, { createSession, killSession, startBillion });

// --- Startup ---
async function startup() {
  // Agent MCP configs are removed when their PTY exits; a crash or a restart
  // never runs that handler, so clear whatever the last run left behind.
  //
  // Inside startup(), NOT at module scope: importing server.js must not delete
  // anything. test/server.test.js imports this file before it sets PORT, so a
  // module-scope sweep would target the default port and wipe the configs of a
  // real server running on 7007 while the suite ran.
  sweepMcpConfigs();
  loadConfig();
  // Reserved whether or not it runs: no other agent may take the name that
  // send_message delivers to Billion by.
  codenamePool.addUsed(BILLION_NAME);
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
  if (billionEnabled()) {
    const { error } = startBillion();
    console.log(error ? `  Billion: not started (${error})` : `  Billion: running in ${billionDir()}`);
  }
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
export { app, server, wss, startup, gracefulShutdown, sessions, createSession, killSession, startBillion };

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
