// PTY lifecycle — session factory, handlers, state detection

import { spawn as spawnPty } from 'node-pty';
import { homedir } from 'os';
import { stripAnsiComplete, detectState, createRingBuffer } from '../lib/helpers.js';
import { RING_BUFFER_MAX } from './state.js';

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
    updateState(session, broadcast);
    broadcast({ type: 'session-ended', sessionId, reason: `Process exited with code ${exitCode}` });
  });

  session.stateCheckInterval = setInterval(() => updateState(session, broadcast), 1000);
}

/**
 * Create a session object and spawn a PTY process.
 * Used by both fresh spawn and orphan re-adopt.
 */
export function createSessionFromConfig({ sessionId, name, color, command, repoPath, worktreePath, branchName, repoSlug, cocktail, isTUI }, broadcast) {
  const parts = command.split(/\s+/);
  const file = parts[0];
  const args = parts.slice(1);

  let ptyProcess;
  try {
    ptyProcess = spawnPty(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: worktreePath || homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
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
  }
}
