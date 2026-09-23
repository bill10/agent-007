// WebSocket — connection management, message routing, broadcast

import { existsSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import {
  config, sessions, orphans, adoptingOrphans,
  codenamePool, colorCycler, nextSessionId,
  GIT_USER_TIMEOUT, isAllowedOrigin,
} from './state.js';
import { authEnabled, resolveToken, tokenFromRequest, publicUser, userById, loadUsers, WS_UNAUTHORIZED } from './auth.js';
import { saveActiveSession, syncOrphansToConfig, saveConfig } from './config.js';
import { addRepo, removeRepo, scanFileTree, startTreeScanLoop, getDiff, broadcastReposList, gitExec, deleteBranch } from './git.js';
import { createSessionFromConfig } from './pty.js';
import { isTyping } from './messages.js';
import { parseGitStatus, buildFileTree, safeFilename } from '../lib/helpers.js';
import { isValidJobAgent } from '../lib/jobs.js';
import {
  addJob, updateJob, deleteJob, moveJob, updateSettings, setJobPaused,
  jobsPayload, broadcastJobs, runScan, relinkSessionToJob, allJobs,
  orphanResumePlan,
} from './jobs.js';

// --- Client tracking ---
const clients = new Set();

export function broadcast(message) {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

export function sessionPayload(session) {
  const owner = userById(session.ownerId);
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
    ownerId: session.ownerId || null,
    ownerName: owner ? owner.displayName : null,
    ownerColor: owner ? owner.color : null,
    spawnedBy: session.spawnedBy || 'user',
    jobId: session.jobId || null,
    // So a client builds its xterm at the pty's size before the scrollback
    // replay lands, instead of reflowing it into xterm's default 80x24.
    cols: session.pty.cols,
    rows: session.pty.rows,
  };
}

// Every window renders at the size it is sent, so one client's report reaches
// every browser: far past any real screen, and xterm allocates cols x rows.
const MAX_PTY_COLS = 1000;
const MAX_PTY_ROWS = 500;

// A pty has one size, and every window showing it gets the same bytes. So it
// takes the smallest of the owner's windows showing it (as tmux does): each
// sees the whole screen at the right width, a bigger one with some empty
// space. A view-only window has no say. Every window is told the size when it
// changes and renders its copy at exactly that.
function fitPtyToWatchers(session) {
  let cols = Infinity, rows = Infinity;
  for (const ws of clients) {
    const w = ws.watching;
    if (ws.readyState === 1 && w && w.sessionId === session.id && owns(ws, session.ownerId)) {
      cols = Math.min(cols, w.cols);
      rows = Math.min(rows, w.rows);
    }
  }
  if (cols === Infinity) return;   // no owner window is showing it: keep the last size
  if (cols === session.pty.cols && rows === session.pty.rows) return;
  try {
    session.pty.resize(cols, rows);
  } catch (err) {
    // The pty can die a moment before onExit marks the session exited, and
    // this runs from the socket close handler too, outside any try.
    console.warn(`pty resize failed for ${session.id}: ${err.message}`);
    return;
  }
  session.lastResizeAt = Date.now();
  broadcast({ type: 'pty-size', sessionId: session.id, cols, rows });
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

// --- Ownership (phase 2) ---
// Only the owner may control a session/orphan. When auth is disabled (single-
// player) or the item is unowned (spawned before auth existed), anyone may.
//
// Two rejection shapes for non-owners, by design:
//  - high-frequency streaming (pty-input, pty-resize): silently drop, so a
//    read-only viewer's keystrokes don't spam a notification per character.
//  - discrete user actions (kill, upload-file, refresh-tree, orphan
//    re-adopt/delete): call denyControl() to surface a read-only notice.
// Match this when wiring any new gated message.
function owns(ws, ownerId) {
  if (!authEnabled()) return true;
  if (!ownerId) return true;
  return !!(ws.user && ws.user.id === ownerId);
}
function denyControl(ws, name, ownerId) {
  const owner = userById(ownerId);
  ws.send(JSON.stringify({
    type: 'notification', level: 'error',
    message: `Read-only — ${name} is owned by ${owner ? owner.displayName : 'someone else'}`,
  }));
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
    // platform lets the client offer the right shell preset (bash vs PowerShell).
    ws.send(JSON.stringify({ type: 'welcome', authEnabled: enabled, user: publicUser(user), platform: process.platform }));

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
    ws.send(JSON.stringify(jobsPayload()));

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
          const result = await createSession(
            msg.command || 'claude', msg.name, msg.repoPath || null, msg.branch || null,
            ws.user ? ws.user.id : null,
            // Optional: branch from somewhere other than the repo's base branch.
            { startPoint: typeof msg.startPoint === 'string' && msg.startPoint.trim() ? msg.startPoint.trim() : null },
          );
          if (result.error) {
            ws.send(JSON.stringify({ type: 'spawn-error', command: msg.command || 'claude', error: result.error }));
          } else if (result.session) {
            broadcast(sessionPayload(result.session));
          }
          break;
        }
        case 'pty-input': {
          const session = sessions.get(msg.sessionId);
          // Non-owners are read-only: silently drop input (no per-keystroke error).
          if (session && !session.exited && owns(ws, session.ownerId)) {
            // Holds agent messages back while a person is mid-line (messages.js).
            if (isTyping(msg.data)) session.lastUserInputAt = Date.now();
            session.pty.write(msg.data);
          }
          break;
        }
        case 'pty-resize': {
          // A window reports the terminal it is showing and how much of it
          // fits, or sessionId null when it shows none (the job board,
          // another view, a hidden browser tab). One terminal at a time, so
          // it stops counting towards whichever it showed before. Any window
          // may report; fitPtyToWatchers counts only the owner's.
          const session = msg.sessionId == null ? null : sessions.get(msg.sessionId);
          const fits = Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
            && msg.cols > 0 && msg.rows > 0 && msg.cols <= MAX_PTY_COLS && msg.rows <= MAX_PTY_ROWS;
          if (msg.sessionId != null && !(session && !session.exited && fits)) break;
          const prev = ws.watching && sessions.get(ws.watching.sessionId);
          ws.watching = session ? { sessionId: session.id, cols: msg.cols, rows: msg.rows } : null;
          if (prev && prev !== session && !prev.exited) fitPtyToWatchers(prev);
          if (session) fitPtyToWatchers(session);
          break;
        }
        case 'kill': {
          const session = sessions.get(msg.sessionId);
          if (session && !owns(ws, session.ownerId)) { denyControl(ws, session.name, session.ownerId); break; }
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
        case 'rename-session': {
          const session = sessions.get(msg.sessionId);
          if (!session) break;
          if (!owns(ws, session.ownerId)) { denyControl(ws, session.name, session.ownerId); break; }
          const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 40) : '';
          if (!/[a-zA-Z0-9]/.test(name) || name === session.name) break;
          // The pool holds every live label, every orphan's label, and every
          // worktree directory's codename, so one lookup covers all three. The
          // one name this session may reclaim is its own directory's codename.
          const dirName = session.worktreePath ? basename(session.worktreePath) : null;
          if (codenamePool.has(name) && name !== dirName) {
            ws.send(JSON.stringify({ type: 'notification', level: 'error', message: `An agent named ${name} already exists` }));
            break;
          }
          const oldName = session.name;
          session.name = name;
          // Only the label moves. The worktree directory keeps its codename:
          // moving it under a live PTY would strand the agent's cwd. That codename
          // stays reserved until the directory is gone (killSession, delete-orphan),
          // or the next spawn in this repo would try to create the same path.
          if (oldName !== dirName) codenamePool.recycle(oldName);
          codenamePool.addUsed(name);
          const rec = config.activeSessions.find(s => s.worktreePath && s.worktreePath === session.worktreePath);
          if (rec) rec.name = name;
          for (const job of allJobs()) {
            if (job.agentSessionId === session.id) job.agentName = name;
          }
          saveConfig(broadcast);
          broadcast({ type: 'session-renamed', sessionId: session.id, name });
          broadcastJobs(broadcast);
          break;
        }
        case 'refresh-tree': {
          const session = sessions.get(msg.sessionId);
          if (session && !owns(ws, session.ownerId)) { denyControl(ws, session.name, session.ownerId); break; }
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
          if (!owns(ws, orphan.ownerId)) { denyControl(ws, orphan.name, orphan.ownerId); break; }
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
              // Dropping the orphan record has to hand its codename back, or the
              // name is burned for the life of the process — nothing else releases
              // it. The branch needs no bookkeeping: git is asked directly at spawn
              // time, so whether this branch still exists takes care of itself.
              codenamePool.recycle(orphan.name);
              if (orphan.worktreePath) codenamePool.recycle(basename(orphan.worktreePath)); // differs after a rename
              orphans.delete(msg.orphanId);
              syncOrphansToConfig(broadcast);
              broadcastOrphansList();
              break;
            }
          }
          // Per CLI: a Codex agent revived with `claude --continue` has no
          // conversation to continue and dies at once. The new session keeps
          // only what the orphan RECORD said (possibly nothing): a CLI picked
          // by a card, a transcript or the default is a guess, and writing it
          // down would make a wrong one permanent.
          const { command, mode, flags } = orphanResumePlan(orphan);
          const result = createSessionFromConfig({
            sessionId: nextSessionId(),
            name: orphan.name,
            color: orphan.color,
            command,
            repoPath: orphan.repoPath,
            worktreePath: orphan.worktreePath,
            branchName: orphan.branchName,
            repoSlug: orphan.repoSlug,
            cocktail: (orphan.branchName || '').split('/').pop(),
            isTUI: true,
            ownerId: orphan.ownerId || null,
            agent: isValidJobAgent(orphan.agent) ? orphan.agent : null,
            // Under a card's or the board's mode the session records no
            // flags of its own: they decide again next time. Under its own
            // recorded flags, it keeps them.
            permissionFlags: mode ? [] : flags,
            origin: orphan.origin === 'board' ? 'board' : 'user',
          }, broadcast);
          if (result.error) {
            adoptingOrphans.delete(msg.orphanId);
            ws.send(JSON.stringify({ type: 'spawn-error', command, error: result.error }));
            break;
          }
          const session = result.session;
          sessions.set(session.id, session);
          saveActiveSession(session, broadcast);
          startTreeScanLoop(session, broadcast);
          // If this orphan was a job's agent, put them back together — matched
          // on the branch, the only identifier that survives a restart.
          const relinked = relinkSessionToJob(session, broadcast);
          if (relinked) {
            broadcast({
              type: 'notification', level: 'info',
              message: `${session.name} reconnected to job "${relinked.title}"`,
            });
          }
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
          if (!owns(ws, orphan.ownerId)) { denyControl(ws, orphan.name, orphan.ownerId); break; }
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
          await deleteBranch(orphan.repoPath, orphan.branchName);
          codenamePool.recycle(orphan.name);
          if (orphan.worktreePath) codenamePool.recycle(basename(orphan.worktreePath)); // differs after a rename
          orphans.delete(msg.orphanId);
          syncOrphansToConfig(broadcast);
          broadcastOrphansList();
          broadcast({ type: 'notification', level: 'info', message: `Deleted orphan ${orphan.name} — worktree and branch removed` });
          break;
        }
        case 'upload-file': {
          const session = sessions.get(msg.sessionId);
          if (session && !owns(ws, session.ownerId)) { denyControl(ws, session.name, session.ownerId); break; }
          if (!session || !session.worktreePath) { ws.send(JSON.stringify({ type: 'notification', level: 'error', message: 'No worktree for file upload' })); break; }
          if (!msg.filename || !msg.data) { ws.send(JSON.stringify({ type: 'notification', level: 'error', message: 'Invalid upload data' })); break; }
          const buf = Buffer.from(msg.data, 'base64');
          if (buf.length > 10 * 1024 * 1024) { ws.send(JSON.stringify({ type: 'notification', level: 'error', message: 'File too large (max 10MB)' })); break; }
          const uploadsDir = join(session.worktreePath, '.uploads');
          mkdirSync(uploadsDir, { recursive: true });
          let finalName = safeFilename(msg.filename);
          if (existsSync(join(uploadsDir, finalName))) {
            const ext = finalName.includes('.') ? '.' + finalName.split('.').pop() : '';
            const base = finalName.includes('.') ? finalName.slice(0, finalName.lastIndexOf('.')) : finalName;
            let counter = 1;
            while (existsSync(join(uploadsDir, `${base}-${counter}${ext}`))) counter++;
            finalName = `${base}-${counter}${ext}`;
          }
          writeFileSync(join(uploadsDir, finalName), buf);
          const relativePath = `.uploads/${finalName}`;
          if (!session.exited) {
            // Typed into the composer like a keystroke: holds agent messages back.
            session.lastUserInputAt = Date.now();
            session.pty.write(relativePath);
          }
          ws.send(JSON.stringify({ type: 'upload-complete', sessionId: msg.sessionId, path: relativePath, filename: finalName }));
          break;
        }

        // --- Job board ---
        // Deliberately not ownership-gated, matching add-repo/remove-repo: the
        // board is shared workspace state, not a per-user resource. postedBy is
        // recorded for attribution, not access control. (Auth here is identity,
        // not a sandbox — see the note at the top of server/auth.js.)
        case 'job-create': {
          const result = addJob({
            title: msg.title, detail: msg.detail, repoPath: msg.repoPath,
            type: msg.jobType, schedule: msg.schedule, attachments: msg.attachments,
            // Empty means "inherit the board setting" — a real unset, so the
            // card follows the board if that changes before it is dispatched.
            permissionMode: msg.permissionMode,
            agent: msg.agent,
            postedBy: ws.user ? ws.user.id : null,
            postedByName: ws.user ? ws.user.displayName : null,
          }, broadcast);
          if (result.error) ws.send(JSON.stringify({ type: 'notification', level: 'error', message: result.error }));
          break;
        }
        case 'job-update': {
          const result = updateJob(msg.jobId, {
            title: msg.title, detail: msg.detail, repoPath: msg.repoPath,
            type: msg.jobType, schedule: msg.schedule, attachments: msg.attachments,
            permissionMode: msg.permissionMode, agent: msg.agent,
          }, broadcast);
          if (result.error) ws.send(JSON.stringify({ type: 'notification', level: 'error', message: result.error }));
          break;
        }
        case 'job-pause': {
          const result = setJobPaused(msg.jobId, msg.paused, broadcast);
          if (result.error) ws.send(JSON.stringify({ type: 'notification', level: 'error', message: result.error }));
          break;
        }
        case 'job-delete': {
          const result = await deleteJob(msg.jobId, broadcast, { killSession });
          if (result.error) ws.send(JSON.stringify({ type: 'notification', level: 'error', message: result.error }));
          break;
        }
        case 'job-move': {
          const result = await moveJob(msg.jobId, msg.state, broadcast, { killSession });
          if (result.error) ws.send(JSON.stringify({ type: 'notification', level: 'error', message: result.error }));
          break;
        }
        case 'job-settings': {
          updateSettings({
            running: msg.running, maxPerRepo: msg.maxPerRepo,
            intervalMs: msg.intervalMs, permissionMode: msg.permissionMode,
          }, broadcast);
          break;
        }
        // "Run now" — the same tick the timer fires, on demand, so the user
        // never has to wait out the interval to see the board act.
        case 'job-dispatch-now': {
          const { skipped } = await runScan(createSession, broadcast, {
            onSessionCreated: (s) => broadcast(sessionPayload(s)),
            killSession,
          });
          if (skipped) {
            ws.send(JSON.stringify({ type: 'notification', level: 'info', message: 'A scan is already running' }));
          }
          broadcastJobs(broadcast);
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

    ws.on('close', () => {
      clients.delete(ws);
      // The terminal it was showing can grow back to the windows still open.
      const watched = ws.watching && sessions.get(ws.watching.sessionId);
      if (watched && !watched.exited) fitPtyToWatchers(watched);
      broadcastPresence();
    });
  });
}
