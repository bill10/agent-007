// PTY lifecycle — session factory, handlers, state detection

import { spawn as spawnPty } from 'node-pty';
import { homedir } from 'os';
import { stripAnsiComplete, detectState, createRingBuffer, parseCommand } from '../lib/helpers.js';
import { resolveExecutable, isUsableCwd } from './command-path.js';
import { RING_BUFFER_MAX } from './state.js';
import { mintAgentToken } from './auth.js';
import { writeMcpConfig, removeMcpConfig, withMcpConfig, takesMcpConfig } from './agent-mcp.js';
import { broadcastJobs } from './jobs.js';

// Regex constants for output filtering (shared, not recreated per event)
const TRIVIAL_RE = /^[\s.·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷─━▏▎▍▌▋▊▉█░▒▓⬡◐◑◒◓|\\\/\-*>]+$/;
const ESCAPE_REMNANT_RE = /^[\d;]*[a-zA-Z]$/;

// node-pty's Windows backend creates the real process on a worker callback
// after spawn() has returned, so a CreateProcessW failure surfaces as an
// uncaught exception instead of a rejected spawn — and takes the whole office
// down with it. The checks in createSessionFromConfig cover the two causes we
// know of (unlaunchable command, missing cwd); this net catches whatever else
// the console host decides to fail on, so one bad agent costs one tab.
const ASYNC_SPAWN_FAILURE_RE = /Cannot create process, error code: (\d+)/;
let asyncSpawnGuardInstalled = false;
let lastSpawnAttempt = null;

function installAsyncSpawnGuard() {
  if (asyncSpawnGuardInstalled) return;
  asyncSpawnGuardInstalled = true;
  process.on('uncaughtException', (err) => {
    const match = ASYNC_SPAWN_FAILURE_RE.exec(err?.message || '');
    if (!match) {
      // Not ours. Reproduce Node's default uncaughtException behaviour rather
      // than silently swallowing an unrelated bug.
      console.error(err);
      process.exit(1);
    }

    // The failure lands within milliseconds of the spawn that caused it and
    // that session has produced no output, so the last attempt is the culprit.
    const attempt = lastSpawnAttempt;
    lastSpawnAttempt = null;
    const reason = `Failed to start "${attempt?.command || 'command'}" (Windows error ${match[1]})`;
    console.error(`${reason} — session left unstarted.`);
    if (!attempt) return;

    // Same teardown as the onExit handler below, so a session that died this
    // way reports DISCONNECTED rather than sitting at WORKING in the office,
    // and its board credential does not outlive the process that never ran.
    const { session, broadcast } = attempt;
    session.exited = true;
    clearInterval(session.stateCheckInterval);
    clearTimeout(session.scanTimer);
    removeMcpConfig(session.id);
    updateState(session, broadcast);
    if (broadcast) broadcast({ type: 'session-ended', sessionId: session.id, reason });
  });
}

/**
 * Attach onData + onExit handlers to a PTY process.
 * Shared between createSessionFromConfig and re-adopt-orphan.
 */
export function setupPtyHandlers(session, sessionId, broadcast) {
  session.pty.onData((data) => {
    session.ringBuffer.push(data);
    // A pty read is not a line. When a read boundary falls mid-line the line
    // arrives as two fragments, neither of which can match a dialog footer --
    // the session then falls through to a bare TUI WAITING and, since a TUI
    // parked at a question emits nothing further, nothing ever repairs it.
    // So carry the tail past the last newline over to the next chunk.
    //
    // The carry is of RAW bytes, before stripping: a boundary lands mid-escape
    // as readily as mid-word, and half a sequence survives stripAnsiComplete
    // as literal "[7Gto" garbage glued into the line. Escapes never span a
    // newline, so cutting the raw stream there is safe.
    //
    // Bounded because an agent controls this text and a line that never gets a
    // newline would otherwise grow forever. Trimmed from the left, since the
    // next chunk continues on the right.
    const raw = (session.pendingRaw || '') + data;
    const cut = raw.lastIndexOf('\n');
    session.pendingRaw = (cut === -1 ? raw : raw.slice(cut + 1)).slice(-2000);
    const lines = stripAnsiComplete(raw.slice(0, cut + 1)).split('\n').filter(l => l.trim().length > 0);
    const partial = stripAnsiComplete(session.pendingRaw).trim();
    const hasContent = [...lines, partial].some(l => l.length > 3 && !TRIVIAL_RE.test(l) && !ESCAPE_REMNANT_RE.test(l));
    const recentResize = (Date.now() - (session.lastResizeAt || 0)) < 2000;
    if (hasContent && !recentResize) session.lastOutputAt = Date.now();
    // Capped: these lines are matched against MESSAGE_PATTERNS/PROMPT_PATTERNS
    // on every chunk AND on a 1s per-session interval, and several of those
    // patterns are quadratic on a long line (`/Allow .+ to (read|edit|...)/`
    // measured 2s on one 180KB line, which pegs the event loop for every
    // session). An agent controls this text, and no prompt footer is 400
    // chars, so bound it here rather than hardening one regex at a time.
    const cap = l => l.trim().slice(0, 400);
    // The partial goes to lastStrippedLine, which detectState scans but which
    // is a single overwritten slot -- keeping it out of the 5-line window, so
    // a frame whose last row never gets a newline cannot latch a fragment
    // there forever. It rejoins the window as a whole line once it completes.
    if (partial) session.lastStrippedLine = cap(partial);
    else if (lines.length > 0) session.lastStrippedLine = cap(lines[lines.length - 1]);
    if (lines.length > 0) {
      session.recentStrippedLines = [...session.recentStrippedLines, ...lines.map(cap)].slice(-5);
    }
    broadcast({ type: 'pty-output', sessionId, data: Buffer.from(data).toString('base64') });
    updateState(session, broadcast);
  });

  session.pty.onExit(({ exitCode }) => {
    session.exited = true;
    clearInterval(session.stateCheckInterval);
    clearTimeout(session.scanTimer);
    // The config file holds this agent's board credential. resolveAgentToken
    // already stops honouring the token the moment `exited` is set, so this is
    // about not leaving credentials lying in the filesystem, not about access.
    removeMcpConfig(sessionId);
    updateState(session, broadcast);
    broadcast({ type: 'session-ended', sessionId, reason: `Process exited with code ${exitCode}` });
  });

  session.stateCheckInterval = setInterval(() => updateState(session, broadcast), 1000);
}

/**
 * Create a session object and spawn a PTY process.
 * Used by both fresh spawn and orphan re-adopt.
 */
export function createSessionFromConfig({ sessionId, name, color, command, repoPath, worktreePath, branchName, repoSlug, cocktail, isTUI, ownerId, spawnedBy, jobId }, broadcast) {
  const { file, args } = parseCommand(command);
  const cwd = worktreePath || homedir();

  // Both of these are checked up front because Windows reports them from the
  // console host *after* spawn() returns — see server/command-path.js. An
  // unusable cwd is the usual re-spawn failure: the agent's worktree was
  // deleted while it was parked as an orphan. Checked before the token is
  // minted so a doomed spawn never puts a board credential on disk.
  if (!isUsableCwd(cwd)) {
    return { error: `Working directory no longer exists: ${cwd}` };
  }
  // Falls back to the bare name when nothing matched, leaving node-pty's own
  // lookup (and its catchable "File not found") in charge.
  const resolvedFile = resolveExecutable(file, process.env, process.platform, cwd) || file;

  // Minted before the spawn so it can go into the MCP config the agent reads at
  // startup, and parked on the session below so resolveAgentToken can find its
  // way back from a request to the agent that made it.
  const agentToken = mintAgentToken();
  // Only for a command that can actually read it. Writing one for every session
  // would put a live board credential on disk for terminals that have no way to
  // use it — a plain `bash` tab does not need one.
  const mcpConfigPath = takesMcpConfig(file) ? writeMcpConfig(sessionId, agentToken) : null;
  const spawnArgs = withMcpConfig(file, args, mcpConfigPath);

  installAsyncSpawnGuard();
  let ptyProcess;
  try {
    ptyProcess = spawnPty(resolvedFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    removeMcpConfig(sessionId);   // nothing will ever read it now
    return { error: `Failed to start "${command}". Is the command installed?` };
  }

  const session = {
    id: sessionId,
    name,
    color,
    command,
    createdAt: Date.now(),
    pty: ptyProcess,
    ringBuffer: createRingBuffer(RING_BUFFER_MAX),
    state: 'WORKING',
    lastOutputAt: Date.now(),
    lastResizeAt: 0,
    lastStrippedLine: '',
    recentStrippedLines: [],
    pendingRaw: '',            // tail of the last pty chunk, past its final newline
    isTUI: isTUI ?? /^(claude|aider|codex|gemini)\b/.test(command),
    ownerId: ownerId || null,   // user who spawned this session (phase 2); null = unowned
    agentToken,                 // bearer for this agent's own board calls; memory + one 0600 file
    // Provenance. 'board' sessions are opened by the job dispatcher: the client
    // uses this to add the tab WITHOUT stealing focus, since an unattended
    // dispatcher would otherwise yank the user's cursor away every few minutes.
    spawnedBy: spawnedBy || 'user',
    jobId: jobId || null,       // job this session was dispatched for, if any
    exited: false,
    stateCheckInterval: null,
    repoPath,
    worktreePath,
    branchName,
    repoSlug,
    cocktail,
    fileTree: [],
    changedCount: 0,
    additions: 0,
    removals: 0,
    lastTreeHash: null,
    scanTimer: null,
    scannedOnce: false,        // first scan cycle always runs (see startTreeScanLoop)
    lastScanOutputAt: null,    // value of lastOutputAt at the last git scan (idle gate)
  };

  lastSpawnAttempt = { session, command, broadcast };
  setupPtyHandlers(session, sessionId, broadcast);
  return { session };
}

export function updateState(session, broadcast) {
  const prevState = session.state;
  const newState = detectState(session);
  if (newState !== prevState) {
    session.state = newState;
    if (broadcast) broadcast({ type: 'state-change', sessionId: session.id, state: newState });
    // A job card's "needs you" badge is derived from its agent's state, so the
    // board has to be re-sent when that state moves. The browser recomputes the
    // badge locally from state-change too, but the jobs-list `status` field
    // would otherwise stay frozen at whatever it was when the job was
    // dispatched — stale for any other consumer, and for a client that
    // connects mid-flight. Only board sessions trigger this, and only on an
    // actual transition, so it is a handful of messages per job.
    if (session.jobId && broadcast) broadcastJobs(broadcast);
  }
}
