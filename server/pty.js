// PTY lifecycle — session factory, handlers, state detection

import { spawn as spawnPty } from 'node-pty';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { rotationState } from './account-rotation.js';
import { claudeSessionIdFor } from './agent-transcripts.js';
import { basename } from 'path';
import { writeSync } from 'fs';
import { execFileSync } from 'child_process';
import { stripAnsiComplete, detectState, createRingBuffer, parseCommand, isRealOutput, trackSyncFrames, ptyEnv, envSwitchOn } from '../lib/helpers.js';
// Re-exported so the handler's tests reach the parser through the module they drive.
export { trackSyncFrames } from '../lib/helpers.js';
import { resolveExecutable, isUsableCwd, commandExists, missingCommandMessage } from './command-path.js';
import { RING_BUFFER_MAX } from './state.js';
import { mintAgentToken, authEnabled } from './auth.js';
import { writeMcpConfig, removeMcpConfig, withMcpConfig, takesMcpConfig, withApprovalHook, withBoardWorkerSettings, withCodexWorkerTools, CODEX_HOOK_CONFIG_ENV } from './agent-mcp.js';
import { broadcastJobs, requestDispatch } from './jobs.js';
import { flushMessages, dropMessages, sendNotice } from './messages.js';
import { withSkillFamilies, reportUngrouped } from './skill-families.js';
import { refreshListing } from './skill-listing.js';
import { reportDuplicates } from './skill-duplicates.js';
import { sessionAgentFromCommand, permissionFlagsFromCommand } from '../lib/jobs.js';
import { trustDialogKey, liveBillion } from './billion.js';
import { codexTrustArgs } from './claude-trust.js';
import { dropApprovals } from './approvals.js';

let claudeSpawnBlocked = false;
export function blockClaudeSpawns(on) { claudeSpawnBlocked = on; }

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
      // than silently swallowing an unrelated bug. Written synchronously:
      // console.error to a pipe is async on Windows, and process.exit dropped
      // it, leaving a crash with no error to read.
      try { writeSync(2, `${err?.stack || err}\n`); } catch { /* exiting anyway */ }
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
 * Shared between createSessionFromConfig and Restart.
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
      : trackSyncFrames(session, data, now, { pane: (text) => isCodexPane(text, session.worktreePath || session.cwd) });
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
    if (!session.accountRotating) dropMessages(sessionId);
    if (session.isBillion) dropApprovals();
    updateState(session, broadcast);
    // A board worker gone frees its repo's slot.
    if (session.jobId && !session.accountRotating) requestDispatch();
    // What it is as it ends, which a relink or a board retirement may have
    // changed since session-created: the client's finished-worker path reads it.
    // `closed`: Agent 007 closed it (killSession), so there is nothing to
    // Restart; otherwise its program exited by itself and Restart brings it back.
    if (!session.accountRotating) broadcast({ type: 'session-ended', sessionId, reason: `Process exited with code ${exitCode}`,
      spawnedBy: session.spawnedBy, jobId: session.jobId, closed: !!session.closing });
  });

  session.stateCheckInterval = setInterval(() => {
    stopBillionUnderAccounts(session);
    updateState(session, broadcast);
  }, 1000);
}

// Billion, and board-dispatched Claude Code workers unless
// TRUST_BOARD_WORKTREES=0 (server/claude-trust.js pre-seeds their trust; this
// catches the dialog when that write lost a race). A dialog arrives in several
// reads, and a late one can still show the old cursor, so reads are collected
// until the screen has been quiet for a moment and the key is chosen from the
// settled drawing. Collected from the key onwards only, so an answered drawing
// is never answered twice. Capped, so a dialog that never changes can't be
// typed at forever. And only just after spawn: the dialog comes before Claude
// Code's first prompt, and on every start after the first there is none, so a
// watcher left armed would read the agent's whole session — and could type into
// it whenever its own output happened to look like that dialog.
const TRUST_SETTLE_MS = 400;
const TRUST_KEY_CAP = 4;
const TRUST_WINDOW_MS = 60_000;
const TRUST_SCREEN_CHARS = 8000;
function answerTrustDialog(session, data, now) {
  if (!session.answersTrust || (session.trustKeys || 0) >= TRUST_KEY_CAP) return;
  if (now - session.createdAt > TRUST_WINDOW_MS) {
    session.trustKeys = TRUST_KEY_CAP;
    session.trustScreen = '';
    clearTimeout(session.trustTimer);
    return;
  }
  session.trustScreen = ((session.trustScreen || '') + data).slice(-TRUST_SCREEN_CHARS);
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
export const CODEX_NO_UPDATE_ARGS = ['-c', 'check_for_update_on_startup=false'];
export function createSessionFromConfig({ sessionId, name, color, command, repoPath, worktreePath, branchName, repoSlug, cocktail, isTUI, ownerId, spawnedBy, jobId, agent, permissionFlags, origin, cwd: ownCwd, isBillion, approvalsToBillion, autoTrust, ghEnv = {}, rotationRestart = false, skills = [] }, broadcast) {
  const { file, args } = parseCommand(command);
  const isClaude = sessionAgentFromCommand(command) === 'claude';
  if (isClaude && claudeSpawnBlocked && !rotationRestart) return { error: 'Claude accounts are switching; try again shortly.' };
  if (isClaude && (rotationState().pending || rotationState().damaged)) return { error: 'Restore the interrupted Claude login in Settings before starting Claude.' };
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
  // A missing CLI "starts" on macOS and Linux and leaves a dead, empty tab.
  if (!commandExists(file, process.env, process.platform, cwd)) {
    return { error: missingCommandMessage(file) };
  }
  // Falls back to the bare name when nothing matched, leaving node-pty's own
  // lookup (and its catchable "File not found") in charge.
  const resolvedFile = resolveExecutable(file, process.env, process.platform, cwd) || file;

  // Minted before the spawn so it can go into the MCP config the agent reads at
  // startup, and parked on the session below so resolveAgentToken can find its
  // way back from a request to the agent that made it.
  let claudeSessionId = null;
  if (isClaude) {
    const selector = args.findIndex(a => ['--resume', '-r', '--session-id'].includes(a.split('=')[0]));
    if (selector >= 0) claudeSessionId = args[selector].includes('=') ? args[selector].slice(args[selector].indexOf('=') + 1) : args[selector + 1];
    else if (args.includes('--continue') || args.includes('-c')) claudeSessionId = claudeSessionIdFor(cwd);
    else { claudeSessionId = randomUUID(); args.unshift('--session-id', claudeSessionId); }
    if (args.includes('--fork-session')) claudeSessionId = null; // the CLI chooses a new id; do not resume the source
  }
  const agentToken = mintAgentToken();
  // Only for a command that can actually read it. Writing one for every session
  // would put a live board credential on disk for terminals that have no way to
  // use it — a plain `bash` tab does not need one.
  const mcpConfigPath = takesMcpConfig(file) ? writeMcpConfig(sessionId, agentToken) : null;
  // Billion's folder is Agent 007's own, so Codex trusts it the way a board
  // worker's worktree is trusted.
  const codexTrust = !!(autoTrust || isBillion) && sessionAgentFromCommand(command) === 'codex';
  // Codex's startup "update available" prompt runs the install and exits,
  // leaving a dead agent. Off per spawn (never in the owner's config.toml);
  // Settings offers the update instead (server/cli-update.js).
  const isCodex = sessionAgentFromCommand(command) === 'codex';
  const ownArgs = [...(isCodex ? CODEX_NO_UPDATE_ARGS : []), ...(codexTrust ? codexTrustArgs(cwd) : []), ...args];
  // A Codex worker on Billion's card gets the same board tools pre-allowed.
  // Inside withMcpConfig, whose server table override would otherwise replace them.
  const mcpArgs = withMcpConfig(file, approvalsToBillion ? withCodexWorkerTools(file, ownArgs, mcpConfigPath) : ownArgs, mcpConfigPath);
  // A worker on one of Billion's cards asks Billion before it asks a person
  // (server/approvals.js) — where the CLI can be hooked: Claude Code, and Codex
  // once its hook's hash was found at start. Recorded as whether the hook
  // actually went in.
  const hookedArgs = approvalsToBillion ? withApprovalHook(file, mcpArgs, mcpConfigPath) : mcpArgs;
  const hooked = hookedArgs !== mcpArgs;
  // No channel plugins in a board worker (withBoardWorkerSettings). A no-op
  // when the hook's --settings, which carries the same, went in above.
  const boardWorker = spawnedBy === 'board' || origin === 'board';
  const settledArgs = boardWorker ? withBoardWorkerSettings(file, hookedArgs) : hookedArgs;
  // Skill families (server/skill-families.js): every family's member listed by
  // name only, apart from the ones this agent's job switches on.
  const spawnArgs = isClaude ? withSkillFamilies(settledArgs, skills) : settledArgs;
  // A Claude Code updated since the last probe gets probed again, for the next spawn.
  if (isClaude && envSwitchOn(process.env.SKILL_FAMILIES)) refreshListing();

  // Codex's hook finds this session's MCP config here (agent-mcp.js).
  const hookEnv = hooked && sessionAgentFromCommand(command) === 'codex' ? { [CODEX_HOOK_CONFIG_ENV]: mcpConfigPath } : {};

  installAsyncSpawnGuard();
  let ptyProcess;
  try {
    ptyProcess = spawnPty(resolvedFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...ptyEnv(process.env), ...ghEnv, ...hookEnv },
    });
  } catch (err) {
    removeMcpConfig(sessionId);   // nothing will ever read it now
    return { error: `Failed to start "${command}". Is the command installed?` };
  }
  // Skills the scan for this spawn found in no family, told to Billion once
  // (Billion's own spawn is told from server.js, once it is on the board).
  if (isClaude && !isBillion) reportUngrouped(liveBillion(), sendNotice);
  if (isClaude && !isBillion) reportDuplicates(liveBillion(), sendNotice);
  // On Windows node-pty writes input through a socket on the console's input
  // pipe and listens for none of its errors. kill() closes the console under
  // any write still in flight, which then fails ("write EAGAIN" while the pipe
  // closes, "write EOF" once it has) as an uncaught exception: the guard above
  // exits on it, taking the office down (and, under Vitest, the test worker).
  // Typing into a tab and closing it is enough. The try/catch around
  // pty.write cannot see it; the write already returned. Drop the input.
  ptyProcess._agent?.inSocket?.on('error', (err) => {
    console.error(`Input to "${name}" was dropped: ${err.message}`);
  });

  const session = {
    id: sessionId,
    name,
    color,
    command,
    claudeSessionId,
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
    skills,                    // skill families it was started with; an account-rotation restart keeps them
    answersTrust: !!(isBillion || (autoTrust && !codexTrust)),   // see answerTrustDialog; Codex's flag leaves nothing to answer
    approvalsToBillion: hooked, // its permission dialogs go to Billion first
    ghEnv,                      // its repo's GitHub account (server/jobs.js ghEnvForRepo), kept for a rotation restart; never sent or saved
    exited: false,
    stateCheckInterval: null,
    repoPath,
    worktreePath,
    cwd,
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

// The process groups under a PTY's child, and how many processes they hold
// besides it. The child leads its own group (node-pty setsid()s it), but that
// group alone misses the usual leak: Claude Code runs each Bash command
// detached, in a session and group of its own, so a `node srv.mjs &` started
// there outlives the tab. Walked from parent links, which only reach them
// while the child still lives: a dead parent's children go to launchd/init.
// Never the server's own group, whatever the walk turns up.
function processTree(rootPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map();
  const pgidOf = new Map();
  for (const [pid, ppid, pgid] of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
    pgidOf.set(pid, pgid);
  }
  const groups = new Set([rootPid]);
  let count = 0;
  const stack = [rootPid];
  while (stack.length) {
    for (const pid of children.get(stack.pop()) || []) {
      count++;
      groups.add(pgidOf.get(pid));
      stack.push(pid);
    }
  }
  groups.delete(pgidOf.get(process.pid));
  for (const g of groups) if (!(g > 1)) groups.delete(g);
  return { count, groups };
}

// Ends a session's PTY and everything it started: SIGTERM to every process
// group under it, SIGKILL to what is left after the grace period. Only groups
// found under this PTY: nothing by port, name or cwd. On Windows, ConPTY's
// kill already takes the console's whole tree.
export function killSessionProcesses(session, { graceMs = 3000 } = {}) {
  if (process.platform === 'win32' || session.exited) {
    try { session.pty.kill(); } catch {}
    return;
  }
  let tree = { count: 0, groups: new Set([session.pty.pid]) };
  try { tree = processTree(session.pty.pid); } catch (err) {
    console.error(`${session.name}: could not list its processes:`, err.message);
  }
  try { session.pty.kill(); } catch {}
  const signal = (sig) => [...tree.groups].filter((g) => {
    try { process.kill(-g, sig); return true; } catch { return false; }
  });
  signal('SIGTERM');
  console.log(tree.count
    ? `${session.name}: stopping ${tree.count} process(es) it started, in ${tree.groups.size} group(s)`
    : `${session.name}: no processes of its own left to stop`);
  setTimeout(() => {
    const stuck = signal('SIGKILL');
    if (stuck.length) console.log(`${session.name}: SIGKILLed ${stuck.length} group(s) that outlived SIGTERM`);
  }, graceMs).unref();
}

// User accounts are read live, so they can appear while Billion runs. It
// belongs to no one, so every signed-in user could then drive an agent that
// never asks before acting: it stops, and Start stays refused (billionRuns).
// On the one-second tick, not on every chunk of output: it stats a file.
export function stopBillionUnderAccounts(session) {
  if (session.isBillion && !session.exited && authEnabled()) {
    try { session.pty.kill(); } catch {}
  }
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
