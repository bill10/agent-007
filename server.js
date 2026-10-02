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
import { mkdirSync, readFileSync } from 'fs';

import {
  PORT, HOST, LOOPBACK_HOSTS, WILDCARD_BIND_HOSTS, WORKTREE_DIR, sessions,
  codenamePool, colorCycler, nextSessionId,
} from './server/state.js';
import { loadConfig, recoverCrashedSessions, saveActiveSession, removeActiveSession, syncOrphansToConfig, sessionAgent, sessionPermissionFlags, sessionOrigin } from './server/config.js';
import { addRepo, createWorktree, removeWorktree, pruneWorktrees, discardWorktree, scanForOrphanedWorktrees, startTreeScanLoop, detectConflicts, deleteBranch } from './server/git.js';
import { createSessionFromConfig, killSessionProcesses, blockClaudeSpawns } from './server/pty.js';
import { setupWebSocket, broadcast, broadcastToBrowsers, sessionPayload, broadcastOrphansList, verifyClient, respawnAgent, respawnBoardWorkers, mayAnswerOwner } from './server/ws.js';
import { setupRoutes } from './server/http.js';
import { startDispatcher, stopDispatcher, boardSettings, releasePushedOrphans, requestDispatch, ghEnvForRepo, retireSpentSchedules, convertOnceSchedules } from './server/jobs.js';
import { orphans, config, CONFIG_DIR } from './server/state.js';
import { toolsFor } from './server/mcp.js';
import { sweepMcpConfigs, startCodexHookLookup } from './server/agent-mcp.js';
import { withDefaultPermission, envPermissionMode, PERMISSION_MODES, ENV_PERMISSION_MODE, sessionAgentFromCommand, deriveJobStatus } from './lib/jobs.js';
import { BILLION_NAME, billionEnabled, billionRuns, billionDir, ensureBillionRepo, refreshCharter, suggestProjectsDir, billionCommand, noAgentCommand, changedBoardTools, saveBoardTools, charterChanges, writeAgentsMd, billionAgent, saveBillionAgent, billionAgentWarning, noAgentNotice, notLoggedInNotice, setBillionNotice, switchBillion as switchBillionSteps, liveBillion, withBillionStopped } from './server/billion.js';
import { writeHandover } from './server/billion-handover.js';
import { wakeTick, billionBusy, WAKE_TICK_MS } from './server/billion-wake.js';
import { limitTick, cliReady, matchLimit, SETTLE_MS } from './server/billion-limit.js';
import { migrate as migrateAccount, rollback as rollbackAccount, retire as retireAccount, setup as setupAccount, setArmed as armAccount, isArmed as accountArmed, publicState as accountState, canMigrate, checkSwitch, recheck as recheckAccount, BUSY_ERROR } from './server/account-migration.js';
import { publicRotationState, rotationState, addRotationAccount, configureRotation, rotateAccount, recoverRotation } from './server/account-rotation.js';
import { assertClaudeProcessesManaged } from './server/claude-processes.js';
import { withClaudeSessionsStopped } from './server/claude-rotation-sessions.js';
import { takeMessages, restoreMessages, dropMessages, screenTail } from './server/messages.js';
import { allJobs } from './server/jobs.js';
import { commandExists, missingCommandMessage } from './server/command-path.js';
import { parseCommand } from './lib/helpers.js';
import { hasClaudeTranscript, codexSessionIdFor } from './server/agent-transcripts.js';
import { autoTrusts, trustClaudeFolder } from './server/claude-trust.js';
import { startTelegram, stopTelegram, notifyOwner, tellOwner, roundTick } from './server/owner.js';
import { comingRound } from './server/rounds.js';
import { setStatusFacts, publishStatus } from './server/billion-status.js';
import { startModelRefresh, modelsReady, availableModels, onModelsChange } from './server/models.js';
import { agentAccounts, refreshAgentAccounts } from './server/agent-accounts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, verifyClient });

// --- HTTP routes ---
// broadcast is injected for the same reason server/jobs.js takes it as an
// argument: http.js must not import ws.js, and a job posted through the MCP
// tool has to repaint every open board the moment it lands.
// killSession is a hoisted declaration below: close_job retires a card's worker.
setupRoutes(app, join(__dirname, 'public'), { broadcast, killSession, respawnAgent });

// --- Orchestrators ---
// These span multiple modules (git, pty, config, ws) and stay here.

async function createSession(command, name, repoPath, customBranch, ownerId, meta = {}) {
  // A custom name must not already be a live label, an orphan's label, or a
  // worktree directory's codename: two holders of one name means the first
  // kill frees it while the other still names a directory on disk.
  if (name && codenamePool.has(name)) return { error: `An agent named ${name} already exists` };
  // A missing CLI, before any worktree is made for it: the board retries a
  // failed card every tick. A path is left to the spawn, which knows the cwd.
  const { file } = parseCommand(command);
  if (!/[\\/]/.test(file) && !commandExists(file)) return { error: missingCommandMessage(file) };
  // An agent someone starts gets the .env default mode for its CLI, unless its
  // command already says how it asks. The board settles its own workers' mode
  // (boardModeFor in server/jobs.js), so their commands are left as built.
  if (meta.spawnedBy !== 'board') command = withDefaultPermission(command);
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

  // A board worker's worktree is brand new, so Claude Code would stop at its
  // workspace-trust dialog until someone clicked (server/claude-trust.js).
  // Codex's is skipped by a flag instead (server/pty.js).
  const autoTrust = autoTrusts({ spawnedBy: meta.spawnedBy, worktreePath, command });
  if (autoTrust && sessionAgentFromCommand(command) === 'claude') trustClaudeFolder(worktreePath);

  const result = createSessionFromConfig({
    sessionId, name: agentName, color, command,
    repoPath: resolvedRepoPath, worktreePath, branchName,
    repoSlug, cocktail, ownerId: ownerId || null,
    spawnedBy: meta.spawnedBy || 'user', jobId: meta.jobId || null,
    approvalsToBillion: !!meta.approvalsToBillion, autoTrust,
    // A board worker gets its repo's GitHub account (server/jobs.js).
    ghEnv: meta.spawnedBy === 'board' ? await ghEnvForRepo(resolvedRepoPath) : {},
  }, broadcast);

  if (result.error) {
    codenamePool.recycle(agentName);
    // Spawn failed after the worktree was created — remove it and its branch
    // so a bad command doesn't leak a worktree + branch on disk.
    if (worktreePath && resolvedRepoPath) {
      await discardWorktree(resolvedRepoPath, worktreePath);
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
  // Board retirement must complete after rotation, not report a silent success
  // while the same worker is about to resume under its original session id.
  if (sessions.get(sessionId)?.accountRotating && switching) {
    try { await switching; } catch { /* Retirement still owns the stopped session. */ }
  }
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.rotationResume) { session.accountRotating = false; session.rotationResume = false; dropMessages(sessionId); }
  clearInterval(session.stateCheckInterval);
  clearTimeout(session.scanTimer);
  killSessionProcesses(session);

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
      jobId: session.jobId || null,
      approvalsToBillion: !!session.approvalsToBillion,
      reason, createdAt: new Date().toISOString(),
    };
    orphans.set(orphanId, orphan);
    syncOrphansToConfig(broadcast);
    broadcastOrphansList();
    broadcast({ type: 'notification', level: 'info', message: `${session.name} orphaned — worktree kept (${reason} changes)` });
  } else {
    codenamePool.recycle(session.name);
    if (session.worktreePath) codenamePool.recycle(basename(session.worktreePath)); // differs after a rename
  }
  sessions.delete(sessionId);
}

// Billion (server/billion.js): started at boot, and again only when someone
// asks — an agent that crashes in a loop is worse than one that stays stopped.
// Returns the running one if there is one. On whichever CLI billionAgent()
// says; `handover` starts it fresh after a switch, with `carried` the mail the
// last one had waiting.
// Async only for the model lists its prompt names: the first discovery is
// waited for, at most 15 s. Everything after that wait is synchronous, so two
// starts at once still find each other's session.
async function startBillion({ handover = false, carried = null } = {}) {
  const modelsIn = await modelsReady();
  for (const [id, s] of sessions) {
    if (!s.isBillion) continue;
    if (s.rotationResume) return { error: 'Retry the paused Claude conversations in Settings before starting Billion.' };
    if (!s.exited) return { session: s, existing: true };
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
  // Best effort: a charter that could not be committed is still the new one on
  // disk, and a Billion on last version's charter beats no Billion.
  if (!created) {
    try {
      if (refreshCharter(dir)) console.log('  Billion: charter updated to this version');
    } catch (err) {
      console.error(`Billion: could not commit the updated charter in ${dir}:`, err.message);
    }
  }
  // Codex's copy of the charter and the owner's rules. Best effort too: a
  // Claude Billion never reads it.
  try { writeAgentsMd(dir); } catch (err) {
    console.error(`Billion: could not write AGENTS.md in ${dir}:`, err.message);
  }
  const agent = billionAgent();
  const hasCli = commandExists(agent, process.env, process.platform, dir);
  // With the model lists toolsFor adds, so a list that changed since the last
  // start names post_job. Only when the CLI starts, so no start without it
  // uses up the notice: it is about Claude Code's resumed conversations, but
  // a Codex Billion reads the file too when its prompt had no model list.
  // Best effort, like the charter.
  let changedTools = [];
  if (hasCli) {
    try { changedTools = changedBoardTools(BILLION_TOOLS_FILE, billionTools()); } catch (err) {
      console.error(`Billion: could not save the board tool definitions to ${BILLION_TOOLS_FILE}:`, err.message);
    }
  }
  // Only when the CLI starts, like the tools, so a start without it does not
  // use up the notice. Best effort: a Billion without it still starts.
  let charterNotice = '';
  if (hasCli) {
    try { charterNotice = charterChanges(join(CONFIG_DIR, 'billion-charter.md'), readFileSync(join(dir, 'CHARTER.md'), 'utf8')); } catch (err) {
      console.error('Billion: could not compare the charter with the last one:', err.message);
    }
  }
  const command = hasCli ? billionCommand({
    agent,
    created,
    handover,
    hasConversation: !created && agent === 'claude' && hasClaudeTranscript(dir),
    codexSessionId: !created && agent === 'codex' ? codexSessionIdFor(dir) : null,
    dir,
    projectsHint: suggestProjectsDir(config.repos.map(r => r.path)),
    changedTools,
    toolsFile: BILLION_TOOLS_FILE,
    charterNotice,
    models: modelsIn ? availableModels() : null,
  }) : noAgentCommand(agent);
  const result = createSessionFromConfig({
    sessionId: nextSessionId(), name: BILLION_NAME, color: colorCycler.next(), command,
    repoPath: null, worktreePath: null, cwd: dir, isBillion: true, ownerId: null,
  }, broadcast);
  if (result.error) return result;
  // Mail waits until Billion calls billion_ready: at the end of its
  // introduction, and at the start of every cycle after a restart.
  result.session.messagesHeld = true;
  restoreMessages(result.session.id, carried);
  sessions.set(result.session.id, result.session);
  // Why it cannot talk yet, for its chat tab. Logged out, the CLI sits at its
  // own sign-in and never calls billion_ready, so mail would wait unexplained.
  const session = result.session;
  const cli = agent === 'codex' ? 'Codex (codex)' : 'Claude Code (claude)';
  if (!hasCli) session.notice = noAgentNotice(agent);
  else cliReady(agent).then((ok) => {
    // Only a definite no: a slow or failed check says nothing either way.
    if (ok !== false || session.exited || !session.messagesHeld) return;
    console.log(`  Billion: ${cli} is not logged in; its tab is at the sign-in`);
    setBillionNotice(session, notLoggedInNotice(agent), broadcast);
    // Its sign-in goes with it; a stopped Billion's bar says Start instead.
    session.pty.onExit(() => setBillionNotice(session, null, broadcast));
  });
  return { session: result.session, ...(hasCli ? {} : { notice: `${cli} is not installed; its tab says how to fix that` }) };
}

// Billion's board tools as it sees them, model lists included. Rewritten when
// a refresh finds new lists, so the copy its prompt points to stays current.
const BILLION_TOOLS_FILE = join(CONFIG_DIR, 'billion-tools.json');
const billionTools = () => toolsFor({ isBillion: true, agent: billionAgent() }, availableModels());
onModelsChange(() => {
  if (!liveBillion()) return;
  try { saveBoardTools(BILLION_TOOLS_FILE, billionTools()); } catch (err) {
    console.error(`Billion: could not save the board tool definitions to ${BILLION_TOOLS_FILE}:`, err.message);
  }
});

// Stops a running Billion and waits for it to go, handing back the mail it
// had waiting. SIGKILL after a few seconds, as at shutdown.
function stopBillion(session) {
  const carried = takeMessages(session.id);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); session.exited = true; resolve(carried); };
    const timer = setTimeout(() => {
      try { process.kill(session.pty.pid, 'SIGKILL'); } catch {}
      done();
    }, 3000);
    session.pty.onExit(done);
    try { session.pty.kill(); } catch { done(); }
  });
}

// Moves Billion to the other CLI, or to `to` (server/billion.js). One at a
// time: a second click while the first waits on the old one to exit would
// otherwise start a second Billion. `reason` is saved when the server made
// the switch itself (server/billion-limit.js).
let switching = null;
const BILLION_SWITCHING = 'Billion is already switching';
async function switchBillion(to, reason) {
  if (switching) return { error: BILLION_SWITCHING };
  const current = liveBillion() || [...sessions.values()].find(s => s.isBillion) || null;
  switching = switchBillionSteps({
    to, current, currentAgent: billionAgent(), dir: billionDir(),
    writeHandover, saveAgent: (agent) => saveBillionAgent(agent, process.env, undefined, reason), stop: stopBillion, start: startBillion,
  });
  try { return await switching; } finally { switching = null; }
}

// The owner's Claude account switch (server/account-migration.js): every
// action here is the browser's, gated in server/ws.js to the owner's browser
// alone; no board tool reaches any of it. The checks run first; only a switch
// that can start stops Billion (server/billion.js, withBillionStopped: its
// running claude would otherwise keep the old account's session and could
// write that account's token back) and starts it again after, on whatever
// login the swap left. A switch or rollback also holds the CLI-switch lock,
// so the button next to Billion's name cannot restart it mid-swap. The owner
// is told the emails and the result, never a token: on Telegram, and in the
// browser only for the armed switch (a click already gets its answer over the
// socket). Workers are left alone: claude re-reads its token every 30
// seconds; RECHECK_MS later the login is looked at again, in case one wrote
// the old account's token back first. The state goes to browsers only where
// the owner may act (user accounts off), as the actions themselves do.
const RECHECK_MS = 40_000;
const accountStatePayload = () => ({ type: 'account-state', ...accountState(), rotation: { ...publicRotationState(), resumePending: [...sessions.values()].some(s => s.rotationResume) } });
const announceAccount = () => { if (mayAnswerOwner()) broadcastToBrowsers(accountStatePayload()); };
async function tellOwnerOrShow(text, level, { show = true } = {}) {
  // In the Billion tab either way; a toast too unless it reached the phone.
  const result = await tellOwner(text, { broadcast, notice: true });
  if (!result.telegram && show && mayAnswerOwner()) broadcastToBrowsers({ type: 'notification', level, message: text });
}
const workersOnClaude = () => [...sessions.values()].filter(s => !s.isBillion && !s.exited && s.agent === 'claude').length;
async function aroundBillion(fn) {
  if (switching) return { error: BILLION_SWITCHING };
  switching = withBillionStopped(fn, {
    live: liveBillion, stop: stopBillion, start: startBillion,
    announce: (session) => broadcast(sessionPayload(session)),
    failed: (error) => tellOwnerOrShow(`Billion did not restart after the Claude account action: ${error}. Press Start next to Billion.`, 'error'),
  });
  try { return await switching; } finally { switching = null; }
}
// Rotation restarts every managed Claude session in its own conversation.
// Session ids and job links stay stable, including queued mail and UI tabs.
async function aroundClaude(fn) {
  if (switching) return { error: BILLION_SWITCHING, busy: true };
  blockClaudeSpawns(true);
  switching = assertClaudeProcessesManaged([...sessions.values()]).then(() => withClaudeSessionsStopped(async () => {
    await assertClaudeProcessesManaged([...sessions.values()]);
    return fn();
  }, {
    list: () => [...sessions.values()],
    idFor: session => session.claudeSessionId,
    stop: async session => {
      if (session.exited && session.rotationResume) return takeMessages(session.id);
      session.accountRotating = true;
      const held = session.messagesHeld;
      if (!session.rotationResume) session.rotationMessagesHeld = held;
      session.messagesHeld = true;
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('A Claude process did not stop; account switching was cancelled.')), 7000);
          session.pty.onExit(() => { clearTimeout(timeout); resolve(); });
          killSessionProcesses(session);
        });
        // killSessionProcesses also terminates detached tool children after 3s.
        await new Promise(resolve => setTimeout(resolve, 3100));
        return takeMessages(session.id);
      } catch (err) {
        // A late exit must retain mail and remain eligible for an exact retry.
        session.rotationResume = true;
        throw err;
      }
    },
    start: ({ session, command, carried }) => {
      clearTimeout(session.scanTimer);
      session.rotationResume = true;
      // Keep mail recoverable even if spawning the replacement fails.
      restoreMessages(session.id, carried);
      const result = createSessionFromConfig({ ...session, sessionId: session.id, command, rotationRestart: true, autoTrust: session.answersTrust }, broadcast);
      if (result.error) return result;
      result.session.rotationResume = false;
      result.session.accountRotating = false;
      result.session.messagesHeld = !!session.rotationMessagesHeld;
      result.session.lastWakeAt = session.lastWakeAt;
      result.session.wakeAt = session.wakeAt;
      sessions.set(session.id, result.session);
      if (session.worktreePath) { saveActiveSession(result.session, broadcast); startTreeScanLoop(result.session, broadcast); }
      broadcast(sessionPayload(result.session));
      return result;
    },
    failed: (session, error) => tellOwnerOrShow(`${session.name} could not resume after the account switch: ${error}`, 'error'),
  }));
  try { return await switching; }
  catch (err) { return { error: err.message, blocked: true, busy: !!err.busy }; }
  finally { switching = null; blockClaudeSpawns(false); requestDispatch(); }
}
async function rotateClaude(options = {}) {
  const result = await rotateAccount({ ...options, around: aroundClaude });
  if (result.error === BUSY_ERROR || result.error === BILLION_SWITCHING) result.busy = true;
  announceAccount();
  if (result.ok && !result.unchanged) await tellOwnerOrShow(`Claude account switched from ${result.oldEmail} to ${result.newEmail}. Claude conversations resumed.`, 'info');
  return result;
}
async function discoverRotationAccounts() {
  const scan = await refreshAgentAccounts();
  const folders = scan.agents.find(a => a.cli === 'claude')?.accounts.filter(a => a.loggedIn).map(a => a.folder) || [];
  if (!folders.length) return { error: 'No logged-in Claude accounts were found.' };
  const errors = [];
  for (const folder of folders) {
    const result = await addRotationAccount(folder);
    if (result.error) errors.push(result.error);
  }
  return errors.length ? { error: errors[0] } : { ok: true };
}

// While Billion is out of the way for a swap, nobody starts another one under it.
const startBillionUnlessSwitching = async () => (switching ? { error: BILLION_SWITCHING } : startBillion());
async function switchAccount(how, { fromBrowser = false } = {}) {
  const can = canMigrate();
  if (can.error) return can;
  const check = await checkSwitch(can.folder);
  if (check.error) {
    if (check.error !== BUSY_ERROR) await tellOwnerOrShow(`Claude account switch to ${accountState().newEmail || 'the new account'} not started: ${check.error}`, 'error', { show: !fromBrowser });
    return check;
  }
  const result = await aroundBillion(() => migrateAccount(can.folder));
  if (result.error === BUSY_ERROR || result.error === BILLION_SWITCHING) return result;   // the other run tells the owner
  const workers = workersOnClaude();
  await tellOwnerOrShow(result.ok
    ? `Claude account switched${how ? ` (${how})` : ''}: the default Claude Code login is now ${result.newEmail}, was ${result.oldEmail}. Backup in ${result.backupDir}. Leave ${can.folder} alone; retire it from the app once you have checked the switch.${workers ? ` ${workers} Claude Code worker(s) were running; they pick the new token up within 30 seconds, and the login is checked again in ${RECHECK_MS / 1000} seconds.` : ''}`
    : `Claude account switch to ${check.newEmail} failed: ${result.error}`, result.ok ? 'info' : 'error', { show: !fromBrowser });
  if (result.ok) {
    setTimeout(async () => {
      const again = await recheckAccount();
      if (again.error && again.error !== BUSY_ERROR) {   // busy: another action is on it and reports itself
        announceAccount();
        await tellOwnerOrShow(`Claude account: ${again.error}. Roll back, then Switch now again once the workers are idle.`, 'error');
      }
    }, RECHECK_MS).unref?.();
  }
  return result;
}
// Keys looked up with Object.hasOwn: a message naming a prototype key is not an action.
const accountActions = {
  'rotation-discover': () => discoverRotationAccounts(),
  'rotation-add': msg => typeof msg.folder === 'string' ? addRotationAccount(msg.folder) : { error: 'Give a Claude config folder.' },
  'rotation-configure': msg => configureRotation(msg),
  'rotation-switch': msg => typeof msg.id === 'string' && /^[a-f0-9]{64}$/.test(msg.id) ? rotateClaude({ id: msg.id }) : { error: 'Select a saved Claude account.' },
  'rotation-recover': () => recoverRotation(aroundClaude),
  'rotation-resume': () => aroundClaude(async () => ({ ok: true })),
  setup: (msg) => setupAccount(msg.folder),
  arm: (msg) => armAccount(msg.on !== false),
  migrate: () => switchAccount('by the owner', { fromBrowser: true }),
  rollback: async () => {
    const result = await aroundBillion(() => rollbackAccount());
    if (result.error !== BUSY_ERROR && result.error !== BILLION_SWITCHING) {
      await tellOwnerOrShow(result.ok ? `Claude account rolled back: the default Claude Code login is ${result.email} again.` : `Claude account rollback failed: ${result.error}`, result.ok ? 'info' : 'error', { show: false });
    }
    return result;
  },
  retire: () => retireAccount(),
};
async function accountAction(msg) {
  const name = typeof msg.action === 'string' && Object.hasOwn(accountActions, msg.action) ? msg.action : null;
  if (!name) return { error: `Unknown account action ${String(msg.action).slice(0, 40)}` };
  const result = await accountActions[name](msg);
  announceAccount();
  return result;
}

// The server's operating loop for Billion (server/billion-wake.js): sooner
// while one of its cards is being worked, or just reached Review or finished CI.
let wakeTimer = null;
let accountLimitRunning = false;
async function workerAccountLimitTick(now) {
  if (accountLimitRunning || switching || !mayAnswerOwner() || !rotationState().enabled) return;
  const session = [...sessions.values()].find(s => !s.exited && !s.isBillion && s.agent === 'claude'
    && s.state !== 'WORKING' && now - (s.lastOutputAt || 0) >= SETTLE_MS
    && !(s.rotationRetryAt > now) && matchLimit(screenTail(s.ringBuffer.getAll().join(''), 15))?.kind === 'hard');
  if (!session) return;
  accountLimitRunning = true;
  try {
    const hit = matchLimit(screenTail(session.ringBuffer.getAll().join(''), 15));
    const result = await rotateClaude({ limited: !session.rotationMarked, line: hit.line, allowCurrent: !!session.rotationMarked });
    if (result.busy) return;
    session.rotationMarked = true;
    if (result.exhausted || result.error) {
      session.rotationRetryAt = Number.isFinite(result.retryAt) ? result.retryAt : now + 30 * 60_000;
      if (!session.rotationNotified) { session.rotationNotified = true; await tellOwnerOrShow(result.error || 'Claude accounts are unavailable. Workers will retry after a usage reset.', 'info'); }
    }
  } finally { accountLimitRunning = false; }
}
function startBillionWakes() {
  clearInterval(wakeTimer);
  wakeTimer = setInterval(() => {
    const now = Date.now();
    workerAccountLimitTick(now).catch(() => console.error('Claude worker account rotation failed.'));
    const session = liveBillion();
    if (!session || accountLimitRunning || switching) return;
    const busy = billionBusy(allJobs(), (job) => (job.agentSessionId ? sessions.get(job.agentSessionId) : null),
      session.lastWakeAt || session.createdAt || 0, now);
    wakeTick(session, { now, busy });
    limitTick(session, {
      now,
      switchTo: async (to, reason) => {
        const result = await switchBillion(to, reason);
        if (!result.error && !result.existing) broadcast(sessionPayload(result.session));
        return result;
      },
      // Billion stalled with no one to unstick it: super urgent, so the phone too.
      notify: (text) => notifyOwner(text, { broadcast, telegram: true }),
      // No Telegram: the browser's notice instead.
      tell: (text) => tellOwnerOrShow(text, 'info'),
      // Armed by the owner, and only while the owner may act (user accounts
      // off): the account switch comes before any move to Codex.
      rotation: mayAnswerOwner() && rotationState().enabled ? {
        run: (hit, { limited }) => rotateClaude({ limited, line: hit.line, allowCurrent: !limited }),
        fallback: () => rotationState().fallback,
        prepare: () => rotateClaude({ allowCurrent: true, preferCurrent: true }),
      } : null,
      migration: {
        armed: () => mayAnswerOwner() && !rotationState().accounts.length && !rotationState().damaged && accountArmed(),
        run: (hit) => switchAccount(`armed: Claude Code said "${hit.line}"`).finally(announceAccount),
      },
    }).catch(err => console.error('Billion: usage-limit check failed:', err.message));
  }, WAKE_TICK_MS);
  wakeTimer.unref?.();
}

// Rounds (server/rounds.js) and the Billion tab's status line
// (server/billion-status.js): whether or not Billion runs, a round still
// comes due and the line still says so.
let roundTimer = null;
const sessionForJob = (job) => (job.agentSessionId ? sessions.get(job.agentSessionId) : null);
function startRounds() {
  setStatusFacts(() => ({
    billion: liveBillion(),
    workers: allJobs().filter(job => job.postedByBillion && job.state === 'in-progress'
      && deriveJobStatus(job, sessionForJob(job)) === 'running').length,
    nextRoundAt: comingRound()?.at ?? null,
  }));
  clearInterval(roundTimer);
  let ticking = false;
  roundTimer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await roundTick({ broadcast });
      publishStatus(broadcast);
    } catch (err) {
      console.error('Rounds: tick failed:', err.message);
    } finally {
      ticking = false;
    }
  }, WAKE_TICK_MS);
  roundTimer.unref?.();
}

// --- WebSocket ---
setupWebSocket(wss, { createSession, killSession, startBillion: startBillionUnlessSwitching, switchBillion, accountAction, accountState: accountStatePayload });

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
  // Before anything spawns: a Codex worker on Billion's card is hooked only
  // once Codex has told us the hook's hash (a second or so, 10 at most; skipped without codex).
  await startCodexHookLookup();
  loadConfig();
  // Reserved whether or not it runs: no other agent may take the name that
  // send_message delivers to Billion by.
  codenamePool.reserve(BILLION_NAME);
  recoverCrashedSessions(broadcast);
  mkdirSync(WORKTREE_DIR, { recursive: true });
  await pruneWorktrees();
  await scanForOrphanedWorktrees(broadcast);
  // Not awaited: each check can ask the remote, and boot must not wait on the network.
  releasePushedOrphans(broadcast).then(n => { if (n) console.log(`  Released ${n} orphaned worktree(s) now on the remote`); })
    .catch(err => console.error('Orphan re-check failed:', err.message));
  // The loop always runs; each tick is a no-op while settings.running is false.
  // Keeping one timer alive (instead of creating/destroying it on toggle) means
  // the Start button only has to flip a boolean, and a config restored with
  // running:true resumes dispatching without any extra wiring.
  // Before the dispatcher: a card's model is checked against this list.
  startModelRefresh();
  // The scan the start's doctor check began (bin/agent-007.js), or a new one.
  agentAccounts();
  // A once schedule not yet fired becomes a one-time card with its start time;
  // then one-date schedules ("0 10 24 9 *") that have already run are done:
  // archived here, each one logged, rather than left showing next year's date.
  convertOnceSchedules(broadcast);
  retireSpentSchedules(broadcast);
  startDispatcher(createSession, broadcast, {
    onSessionCreated: (s) => broadcast(sessionPayload(s)),
    killSession,
    // Billion's workers orphaned by this restart come back on the first scan.
    respawnWorkers: () => respawnBoardWorkers(),
  });
  if (boardSettings().running) console.log('  Job board dispatcher: running');
  if (process.env.RESPAWN_BOARD_WORKERS === '0') console.log('  Board workers stay orphaned after a restart (RESPAWN_BOARD_WORKERS=0)');
  // A misspelt mode would otherwise be ignored without a word.
  for (const [agent, key] of Object.entries(ENV_PERMISSION_MODE)) {
    const raw = (process.env[key] || '').trim();
    if (raw && !envPermissionMode(agent)) console.warn(`  ${key}=${raw} is not a permission mode (${PERMISSION_MODES.join(', ')}); ignored`);
    else if (raw) console.log(`  ${agent} agents start in ${raw} unless told otherwise`);
  }
  if (billionRuns()) {
    const warning = billionAgentWarning();
    if (warning) console.warn(`  ${warning}`);
    const { error, notice, session } = await startBillion();
    startBillionWakes();
    console.log(error ? `  Billion: not started (${error})` : notice ? `  Billion: ${notice}` : `  Billion: running on ${session.agent} in ${billionDir()}`);
  } else if (billionEnabled()) {
    console.log('  Billion: off while user accounts are enabled');
  }
  // After Billion, so a reply waiting in Telegram finds it running.
  startTelegram({ broadcast });
  startRounds();
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
  stopTelegram();
  clearInterval(wakeTimer);
  clearInterval(roundTimer);
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
export { app, server, wss, startup, gracefulShutdown, sessions, createSession, killSession, startBillion, switchBillion };

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
