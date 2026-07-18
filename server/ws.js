// WebSocket — connection management, message routing, broadcast

import { existsSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import {
  config, sessions, orphans, adoptingOrphans,
  codenamePool, cocktailPool, colorCycler, nextSessionId,
  GIT_USER_TIMEOUT, isAllowedOrigin,
} from './state.js';
import { authEnabled, resolveToken, tokenFromRequest, publicUser, loadUsers, WS_UNAUTHORIZED } from './auth.js';
import { saveActiveSession, syncOrphansToConfig } from './config.js';
import { addRepo, removeRepo, scanFileTree, getDiff, broadcastReposList, gitExec } from './git.js';
import { createSessionFromConfig } from './pty.js';
import { parseGitStatus, buildFileTree } from '../lib/helpers.js';

// --- Client tracking ---
const clients = new Set();

export function broadcast(message) {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

export function sessionPayload(session) {
  return {
    type: 'session-created',
    sessionId: session.id,
    name: session.name,
    color: session.color,
    command: session.command,
    state: session.state,
    repoPath: session.repoPath,
    repoSlug: session.repoSlug,
    branchName: session.branchName,
    changedCount: session.changedCount,
    additions: session.additions || 0,
    removals: session.removals || 0,
  };
}

export function broadcastOrphansList() {
  broadcast({ type: 'orphans-list', orphans: [...orphans.values()] });
}

// --- Presence (phase 1) ---
// The distinct set of authenticated users currently connected. Empty when auth
// is disabled (no identities to report).
export function broadcastPresence() {
  const seen = new Map();
  for (const ws of clients) {
    if (ws.readyState === 1 && ws.user) seen.set(ws.user.id, publicUser(ws.user));
  }
  broadcast({ type: 'presence', users: [...seen.values()] });
}

// --- WebSocket origin check (B3) ---
// verifyClient rejects the handshake for disallowed origins. localhost is always
// allowed; add remote hostnames via ALLOWED_ORIGINS (see server/state.js).
// Requests with no Origin header are allowed (same-origin or non-browser).
export function verifyClient({ origin }) {
  return isAllowedOrigin(origin);
}

// --- Setup ---
export function setupWebSocket(wss, { createSession, killSession }) {
  wss.on('connection', (ws, req) => {
    // Auth gate (phase 1): when users are configured, require a valid token
    // (?token= on the WS URL, since browsers can't set handshake headers).
    // Close code 4401 tells the client to prompt for a token.
    const enabled = authEnabled();
    const user = enabled ? resolveToken(tokenFromRequest(req)) : null;
    if (enabled && !user) {
      try { ws.close(WS_UNAUTHORIZED, 'Unauthorized'); } catch {}
      return;
    }
    ws.user = user; // null when auth is disabled
    clients.add(ws);

    // Tell the client who it is and whether auth is on.
    ws.send(JSON.stringify({ type: 'welcome', authEnabled: enabled, user: publicUser(user) }));

    // Send repos list
    ws.send(JSON.stringify({
      type: 'repos-list',
      repos: config.repos.map(r => ({ path: r.path, slug: basename(r.path), exists: existsSync(r.path) })),
    }));

    // Send existing sessions
    for (const [, session] of sessions) {
      ws.send(JSON.stringify(sessionPayload(session)));
      const chunks = session.ringBuffer.getAll();
      for (let i = 0; i < chunks.length; i += 100) {
        const batch = chunks.slice(i, i + 100).join('');
        ws.send(JSON.stringify({ type: 'pty-output', sessionId: session.id, data: Buffer.from(batch).toString('base64') }));
      }
      if (session.fileTree && session.fileTree.length > 0) {
        ws.send(JSON.stringify({
          type: 'file-tree', sessionId: session.id,
          tree: buildFileTree(session.fileTree, basename(session.repoPath)),
          files: session.fileTree, changedCount: session.changedCount,
          additions: session.additions || 0, removals: session.removals || 0,
        }));
      }
    }

    ws.send(JSON.stringify({ type: 'orphans-list', orphans: [...orphans.values()] }));

    broadcastPresence();

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Re-check auth per message (connect-time gating alone misses two cases):
      //  - a socket that connected while auth was disabled, then auth was enabled
      //  - a user removed from users.json while their socket is still open
      // Both must lose access without waiting for a voluntary reconnect.
      if (authEnabled() && !(ws.user && loadUsers().some(u => u.id === ws.user.id))) {
        try { ws.close(WS_UNAUTHORIZED, 'Unauthorized'); } catch {}
        return;
      }

      try {
      switch (msg.type) {
        case 'spawn': {
          const result = await createSession(msg.command || 'claude', msg.name, msg.repoPath || null, msg.branch || null);
          if (result.error) {
            ws.send(JSON.stringify({ type: 'spawn-error', command: msg.command || 'claude', error: result.error }));
          } else if (result.session) {
            broadcast(sessionPayload(result.session));
          }
          break;
        }
        case 'pty-input': {
          const session = sessions.get(msg.sessionId);
          if (session && !session.exited) session.pty.write(msg.data);
          break;
        }
        case 'pty-resize': {
          const session = sessions.get(msg.sessionId);
          if (session && !session.exited) {
            session.lastResizeAt = Date.now();
            session.pty.resize(msg.cols, msg.rows);
          }
          break;
        }
        case 'kill': {
          await killSession(msg.sessionId);
          break;
        }
        case 'add-repo': {
          const result = await addRepo(msg.path, broadcast);
          if (result.error) ws.send(JSON.stringify({ type: 'repo-error', error: result.error }));
          break;
        }
        case 'remove-repo': {
          removeRepo(msg.path, broadcast);
          break;
        }
        case 'refresh-tree': {
          const session = sessions.get(msg.sessionId);
          if (session) { session.lastTreeHash = null; await scanFileTree(session, broadcast); }
          break;
        }
        case 'get-diff': {
          const session = sessions.get(msg.sessionId);
          if (session) {
            const diff = await getDiff(session, msg.filePath, msg.status);
            ws.send(JSON.stringify({ type: 'file-diff', sessionId: session.id, filePath: msg.filePath, diff }));
          }
          break;
        }
        case 'get-full-tree': {
          const session = sessions.get(msg.sessionId);
          if (session && session.worktreePath) {
            try {
              const [lsOutput, statusOutput] = await Promise.all([
                gitExec(['-C', session.worktreePath, 'ls-files'], { timeout: GIT_USER_TIMEOUT }),
                gitExec(['-C', session.worktreePath, 'status', '--porcelain=v1']),
              ]);
              const changedFiles = parseGitStatus(statusOutput);
              const changedMap = new Map(changedFiles.map(f => [f.path, f.status]));
              const allFiles = [];
              for (const line of lsOutput.split('\n')) {
                const p = line.trim();
                if (!p) continue;
                allFiles.push({ path: p, status: changedMap.get(p) || null });
              }
              for (const f of changedFiles) { if (f.status === '?') allFiles.push(f); }
              const tree = buildFileTree(allFiles, basename(session.repoPath));
              ws.send(JSON.stringify({ type: 'full-tree', sessionId: session.id, tree }));
            } catch (err) { console.error(`Full tree fetch failed for ${session.id}:`, err.message); }
          }
          break;
        }
        case 're-adopt-orphan': {
          const orphan = orphans.get(msg.orphanId);
          if (!orphan) { ws.send(JSON.stringify({ type: 'spawn-error', error: 'Orphan not found' })); break; }
          if (adoptingOrphans.has(msg.orphanId)) { ws.send(JSON.stringify({ type: 'spawn-error', error: 'Orphan is already being re-adopted' })); break; }
          adoptingOrphans.add(msg.orphanId);
          if (!existsSync(join(orphan.worktreePath, '.git'))) {
            let recreated = false;
            if (orphan.repoPath && orphan.branchName && existsSync(orphan.repoPath)) {
              try {
                try { rmSync(orphan.worktreePath, { recursive: true }); } catch {}
                await gitExec(['-C', orphan.repoPath, 'worktree', 'prune']);
                await gitExec(['-C', orphan.repoPath, 'worktree', 'add', orphan.worktreePath, orphan.branchName]);
                recreated = true;
              } catch (err) { console.error(`Failed to re-create worktree for ${orphan.name}:`, err.message || err.stderr); }
            }
            if (!recreated) {
              ws.send(JSON.stringify({ type: 'spawn-error', error: 'Worktree directory no longer exists' }));
              adoptingOrphans.delete(msg.orphanId);
              orphans.delete(msg.orphanId);
              syncOrphansToConfig(broadcast);
              broadcastOrphansList();
              break;
            }
          }
          const result = createSessionFromConfig({
            sessionId: nextSessionId(),
            name: orphan.name,
            color: orphan.color,
            command: 'claude --continue',
            repoPath: orphan.repoPath,
            worktreePath: orphan.worktreePath,
            branchName: orphan.branchName,
            repoSlug: orphan.repoSlug,
            cocktail: (orphan.branchName || '').split('/').pop(),
            isTUI: true,
          }, broadcast);
          if (result.error) {
            adoptingOrphans.delete(msg.orphanId);
            ws.send(JSON.stringify({ type: 'spawn-error', command: 'claude --continue', error: result.error }));
            break;
          }
          const session = result.session;
          sessions.set(session.id, session);
          saveActiveSession(session, broadcast);
          session.scanTimer = setTimeout(() => scanFileTree(session, broadcast), 1000);
          adoptingOrphans.delete(msg.orphanId);
          orphans.delete(msg.orphanId);
          syncOrphansToConfig(broadcast);
          broadcast(sessionPayload(session));
          broadcastOrphansList();
          break;
        }
        case 'delete-orphan': {
          const orphan = orphans.get(msg.orphanId);
          if (!orphan) break;
          let worktreeRemoved = true;
          if (existsSync(orphan.worktreePath)) {
            try { await gitExec(['-C', orphan.repoPath, 'worktree', 'remove', '--force', orphan.worktreePath]); } catch (err) {
              console.error('Failed to remove orphan worktree:', err.message);
              worktreeRemoved = false;
            }
          }
          if (!worktreeRemoved) {
            broadcast({ type: 'notification', level: 'error', message: `Failed to delete orphan ${orphan.name} — worktree removal failed` });
            break;
          }
          try { await gitExec(['-C', orphan.repoPath, 'branch', '-D', orphan.branchName]); } catch {}
          codenamePool.recycle(orphan.name);
          if (orphan.branchName && orphan.branchName.includes('/')) {
            cocktailPool.recycle(orphan.repoPath, orphan.branchName.split('/').pop());
          }
          orphans.delete(msg.orphanId);
          syncOrphansToConfig(broadcast);
          broadcastOrphansList();
          broadcast({ type: 'notification', level: 'info', message: `Deleted orphan ${orphan.name} — worktree and branch removed` });
          break;
        }
        case 'upload-file': {
          const session = sessions.get(msg.sessionId);
          if (!session || !session.worktreePath) { ws.send(JSON.stringify({ type: 'notification', level: 'error', message: 'No worktree for file upload' })); break; }
          if (!msg.filename || !msg.data) { ws.send(JSON.stringify({ type: 'notification', level: 'error', message: 'Invalid upload data' })); break; }
          const buf = Buffer.from(msg.data, 'base64');
          if (buf.length > 10 * 1024 * 1024) { ws.send(JSON.stringify({ type: 'notification', level: 'error', message: 'File too large (max 10MB)' })); break; }
          const uploadsDir = join(session.worktreePath, '.uploads');
          mkdirSync(uploadsDir, { recursive: true });
          let finalName = msg.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          if (existsSync(join(uploadsDir, finalName))) {
            const ext = finalName.includes('.') ? '.' + finalName.split('.').pop() : '';
            const base = finalName.includes('.') ? finalName.slice(0, finalName.lastIndexOf('.')) : finalName;
            let counter = 1;
            while (existsSync(join(uploadsDir, `${base}-${counter}${ext}`))) counter++;
            finalName = `${base}-${counter}${ext}`;
          }
          writeFileSync(join(uploadsDir, finalName), buf);
          const relativePath = `.uploads/${finalName}`;
          if (!session.exited) session.pty.write(relativePath);
          ws.send(JSON.stringify({ type: 'upload-complete', sessionId: msg.sessionId, path: relativePath, filename: finalName }));
          break;
        }
      }
      } catch (err) {
        console.error(`WebSocket handler error (msg.type=${msg.type}):`, err);
        if (msg.type === 'spawn') {
          try {
            ws.send(JSON.stringify({
              type: 'spawn-error',
              command: msg.command || 'claude',
              error: `Server error: ${err.message || err}`,
            }));
          } catch {}
        }
      }
    });

    ws.on('close', () => { clients.delete(ws); broadcastPresence(); });
  });
}
