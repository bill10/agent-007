// PTY lifecycle — session factory, handlers, state detection

import { spawn as spawnPty } from 'node-pty';
import { homedir } from 'os';
import { basename } from 'path';
import { stripAnsiComplete, detectState, createRingBuffer, parseCommand, isRealOutput, trackSyncFrames, ptyEnv } from '../lib/helpers.js';
// Re-exported so the handler's tests reach the parser through the module they drive.
export { trackSyncFrames } from '../lib/helpers.js';
import { resolveExecutable, isUsableCwd } from './command-path.js';
import { RING_BUFFER_MAX } from './state.js';
import { mintAgentToken } from './auth.js';
import { writeMcpConfig, removeMcpConfig, withMcpConfig, takesMcpConfig, withApprovalHook } from './agent-mcp.js';
import { broadcastJobs } from './jobs.js';
import { flushMessages, dropMessages } from './messages.js';
import { sessionAgentFromCommand, permissionFlagsFromCommand } from '../lib/jobs.js';
import { trustDialogKey } from './billion.js';
import { dropApprovals } from './approvals.js';

// Regex constants for output filtering (shared, not recreated per event)

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
    dropMessages(session.id);
    updateState(session, broadcast);
    if (broadcast) broadcast({ type: 'session-ended', sessionId: session.id, reason });
  });
}

// Codex's composer placeholder, or its status row: "<model> <effort> · <cwd>",
// the cwd abbreviated with ~ but keeping its last segment.
function isCodexPane(text, worktreePath) {
  if (text.includes('Ask Codex to do anything')) return true;
  const tail = worktreePath ? basename(worktreePath) : '';
  return !!tail && text.includes(' · ') && text.includes(tail);
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
    const now = Date.now();
    // Frames first: a synchronized repaint is a whole pane, not line text, so
    // only what this read contributed OUTSIDE frames goes on to be reassembled
    // into lines. Codex draws its dialogs and prompt without a newline in
    // sight — left in the line stream, a cancelled picker's text would still
    // be "the last line" for as long as the next 2000 bytes took to arrive,
    // and the last line is checked before the frame.
    // Frames are trusted for Codex alone. Claude Code draws none today but
    // carries the option to, and its repaints are diffs — a frame of its
    // would be one row, not the pane. A Codex frame is the whole pane when it
    // carries the composer or the status row, which names the directory the
    // agent runs in; anything else is a partial repaint, merged onto the pane.
    const { outside, straddle } = session.framesTrusted === false
      ? { outside: data, straddle: 0 }
      : trackSyncFrames(session, data, now, { pane: (text) => isCodexPane(text, session.worktreePath) });
    const recentResize = (now - (session.lastResizeAt || 0)) < 2000;
    const carry = straddle ? (session.pendingRaw || '').slice(0, -straddle) : (session.pendingRaw || '');
    const raw = carry + outside;
    const cut = raw.lastIndexOf('\n');
    session.pendingRaw = (cut === -1 ? raw : raw.slice(cut + 1)).slice(-2000);
    const lines = stripAnsiComplete(raw.slice(0, cut + 1)).split('\n').filter(l => l.trim().length > 0);
    answerTrustDialog(session, outside, now);
    const partial = stripAnsiComplete(session.pendingRaw).trim();
    // Freshness is judged on THIS read, never on the carry. `partial` is
    // re-derived from accumulated bytes, so counting it here would re-count
    // text already seen: once an unterminated line sits in the carry, a bare
    // cursor move or a bell would keep bumping lastOutputAt, and detectState
    // reports WORKING for as long as that window stays open. A TUI emitting
    // periodic control sequences could then mask a question dialog for ever —
    // the same failure this carry-over exists to fix, through another door.
    const fresh = stripAnsiComplete(data).trim();
    const hasContent = [...lines, fresh].some(isRealOutput);
    if (hasContent && !recentResize) session.lastOutputAt = now;
    // Capped: these lines are matched against MESSAGE_PATTERNS/PROMPT_PATTERNS
    // on every chunk AND on a 1s per-session interval. An agent controls this
    // text, and no prompt footer is 400 chars, so bound it here. (The last
    // synchronized frame, scanned the same way, has its own larger bound in
    // trackSyncFrames; the patterns with a gap between two literals are
    // themselves bounded now, so neither cap is carrying a quadratic regex.)
    const cap = l => l.trim().slice(0, 400);
    // The partial goes to lastStrippedLine, which detectState scans but which
    // is a single overwritten slot -- keeping it out of the 5-line window, so
    // a frame whose last row never gets a newline cannot latch a fragment
    // there forever. It rejoins the window as a whole line once it completes.
    if (partial) session.lastStrippedLine = cap(partial);
    else if (lines.length > 0) session.lastStrippedLine = cap(lines[lines.length - 1]);
    if (lines.length > 0) {
      session.recentStrippedLines = [...session.recentStrippedLines, ...lines.map(cap)].slice(-5);
      // Whole lines outside any frame: what the last frame is weighed against.
      if (lines.some(isRealOutput)) session.lastLineAt = now;
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
    dropMessages(sessionId);
    if (session.isBillion) dropApprovals();
    updateState(session, broadcast);
    broadcast({ type: 'session-ended', sessionId, reason: `Process exited with code ${exitCode}` });
  });

  session.stateCheckInterval = setInterval(() => updateState(session, broadcast), 1000);
}

// Billion only (server/billion.js trustDialogKey). A dialog arrives in several
// reads, and a late one can still show the old cursor, so reads are collected
// until the screen has been quiet for a moment and the key is chosen from the
// settled drawing. Collected from the key onwards only, so an answered drawing
// is never answered twice. Capped, so a dialog that never changes can't be
// typed at forever. And only just after spawn: the dialog comes before Claude
// Code's first prompt, and on every start after the first there is none, so a
// watcher left armed would read Billion's whole session — and could type into
// it whenever its own output happened to look like that dialog.
const TRUST_SETTLE_MS = 400;
const TRUST_KEY_CAP = 4;
const TRUST_WINDOW_MS = 60_000;
function answerTrustDialog(session, data, now) {
  if (!session.isBillion || (session.trustKeys || 0) >= TRUST_KEY_CAP) return;
  if (now - session.createdAt > TRUST_WINDOW_MS) {
    session.trustKeys = TRUST_KEY_CAP;
    session.trustScreen = '';
    clearTimeout(session.trustTimer);
    return;
  }
  session.trustScreen = ((session.trustScreen || '') + data).slice(-8000);
  clearTimeout(session.trustTimer);
  session.trustTimer = setTimeout(() => {
    const key = session.exited ? null : trustDialogKey(stripAnsiComplete(session.trustScreen || ''));
    if (!key) return;
    // Enter answers it for good: stop watching.
    session.trustKeys = key === '\r' ? TRUST_KEY_CAP : (session.trustKeys || 0) + 1;
    session.trustScreen = '';
    try { session.pty.write(key); } catch {}
  }, TRUST_SETTLE_MS);
}

/**
 * Create a session object and spawn a PTY process.
 * Used by both fresh spawn and orphan re-adopt.
 */
export function createSessionFromConfig({ sessionId, name, color, command, repoPath, worktreePath, branchName, repoSlug, cocktail, isTUI, ownerId, spawnedBy, jobId, agent, permissionFlags, origin, cwd: ownCwd, isBillion, approvalsToBillion }, broadcast) {
  const { file, args } = parseCommand(command);
  // ownCwd: a repo-less agent that still has a folder of its own (Billion).
  const cwd = worktreePath || ownCwd || homedir();

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
  const mcpArgs = withMcpConfig(file, args, mcpConfigPath);
  // A worker on one of Billion's cards asks Billion before it asks a person
  // (server/approvals.js) — where the CLI can be hooked, which today is
  // Claude Code only. Recorded as whether the hook actually went in.
  const spawnArgs = approvalsToBillion ? withApprovalHook(file, mcpArgs, mcpConfigPath) : mcpArgs;
  const hooked = spawnArgs !== mcpArgs;

  installAsyncSpawnGuard();
  let ptyProcess;
  try {
    ptyProcess = spawnPty(resolvedFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: ptyEnv(process.env),
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
    framesTrusted: sessionAgentFromCommand(command) === 'codex',   // see the onData handler
    lastFrame: '',             // text of the last synchronized-output repaint, if the TUI draws them
    lastFrameAt: 0,            // when it closed — the frame speaks for the screen only while no whole line was printed outside one since
    lastLineAt: 0,             // when a whole real line last arrived outside any frame
    frameOpenedAt: 0,          // a frame open longer than a second is abandoned
    frameOpen: null,           // a frame carried across pty reads
    frameTail: '',             // the last few bytes before one, for a marker that straddles two reads
    pendingRaw: '',            // tail of the last pty chunk, past its final newline
    isTUI: isTUI ?? /^(claude|aider|codex|gemini)\b/.test(command),
    // Which CLI this is, as far as anyone KNOWS — 'claude', 'codex' or null.
    // A fresh spawn reads it off the command. A re-adopted orphan passes its
    // own note instead, which may be null: its resume command was chosen by
    // a card, a transcript or the default, and a guess must not be written
    // down as fact, or a wrong one could never be corrected — the record
    // outranks every other witness the next time round.
    agent: agent === undefined ? sessionAgentFromCommand(command) : agent,
    // The permission flags it was spawned with, so a re-spawn with no job
    // card to ask can run under the same ones. Only a session that OWNS its
    // flags records them: one a person started by hand. A board dispatch
    // runs under its card's mode, which the board re-resolves at every
    // re-spawn against its current setting, so recording the dispatch-time
    // flags would freeze a bypass past the card's retirement and past any
    // tightening of the board since. A re-adopt passes its own answer in:
    // the recorded flags it resumed under, or none when a card's mode did.
    permissionFlags: permissionFlags !== undefined ? permissionFlags
      : ((origin || spawnedBy) === 'board' ? [] : permissionFlagsFromCommand(command)),
    // Where the session's lineage began, 'board' or 'user' — unlike spawnedBy
    // (which says how THIS tab was opened, and is 'user' for a re-adopt) it
    // survives re-adopts on the records, so a board agent whose card is gone
    // can still be resumed under the board's mode rather than the CLI's.
    origin: origin === 'board' || (origin === undefined && spawnedBy === 'board') ? 'board' : 'user',
    ownerId: ownerId || null,   // user who spawned this session (phase 2); null = unowned
    agentToken,                 // bearer for this agent's own board calls; memory + one 0600 file
    // Provenance. 'board' sessions are opened by the job dispatcher: the client
    // uses this to add the tab WITHOUT stealing focus, since an unattended
    // dispatcher would otherwise yank the user's cursor away every few minutes.
    spawnedBy: spawnedBy || 'user',
    jobId: jobId || null,       // job this session was dispatched for, if any
    isBillion: !!isBillion,     // the one agent you talk to (server/billion.js)
    approvalsToBillion: hooked, // its permission dialogs go to Billion first
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
    session.stateChangedAt = Date.now();   // messages.js: one message per stop
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
  // Every check, not only on arriving at WAITING: a message held back because
  // someone was typing has no later transition to wait for.
  flushMessages(session);
}
