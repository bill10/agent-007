// PTY lifecycle — session factory, handlers, state detection

import { spawn as spawnPty } from 'node-pty';
import { homedir } from 'os';
import { stripAnsiComplete, detectState, createRingBuffer, parseCommand } from '../lib/helpers.js';
import { RING_BUFFER_MAX } from './state.js';
import { mintAgentToken } from './auth.js';
import { writeMcpConfig, removeMcpConfig, withMcpConfig, takesMcpConfig } from './agent-mcp.js';
import { broadcastJobs } from './jobs.js';

// Regex constants for output filtering (shared, not recreated per event)
const TRIVIAL_RE = /^[\s.·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷─━▏▎▍▌▋▊▉█░▒▓⬡◐◑◒◓|\\\/\-*>]+$/;
const ESCAPE_REMNANT_RE = /^[\d;]*[a-zA-Z]$/;

/**
 * Attach onData + onExit handlers to a PTY process.
 * Shared between createSessionFromConfig and re-adopt-orphan.
 */
export function setupPtyHandlers(session, sessionId, broadcast) {
  session.pty.onData((data) => {
    session.ringBuffer.push(data);
    const stripped = stripAnsiComplete(data);
    const lines = stripped.split('\n').filter(l => l.trim().length > 0);
    const hasContent = lines.length > 0 && lines.some(l => l.length > 3 && !TRIVIAL_RE.test(l) && !ESCAPE_REMNANT_RE.test(l));
    const recentResize = (Date.now() - (session.lastResizeAt || 0)) < 2000;
    if (hasContent && !recentResize) session.lastOutputAt = Date.now();
    if (lines.length > 0) {
      session.lastStrippedLine = lines[lines.length - 1].trim();
      session.recentStrippedLines = [...session.recentStrippedLines, ...lines.map(l => l.trim())].slice(-5);
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

  // Minted before the spawn so it can go into the MCP config the agent reads at
  // startup, and parked on the session below so resolveAgentToken can find its
  // way back from a request to the agent that made it.
  const agentToken = mintAgentToken();
  // Only for a command that can actually read it. Writing one for every session
  // would put a live board credential on disk for terminals that have no way to
  // use it — a plain `bash` tab does not need one.
  const mcpConfigPath = takesMcpConfig(file) ? writeMcpConfig(sessionId, agentToken) : null;
  const spawnArgs = withMcpConfig(file, args, mcpConfigPath);

  let ptyProcess;
  try {
    ptyProcess = spawnPty(file, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: worktreePath || homedir(),
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
    isTUI: isTUI ?? /^(claude|aider)\b/.test(command),
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
