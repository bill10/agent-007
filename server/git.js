// Git operations — exec, worktree management, file tree scanning, diffs

import { execFile as execFileCb } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { mkdirSync } from 'fs';
import { basename, isAbsolute, join, sep } from 'path';
import { realpathSync } from 'fs';
import { createHash } from 'crypto';
import {
  config, orphans, sessions, knownConflictKeys,
  codenamePool, cocktailPool, colorCycler,
  GIT_AUTO_TIMEOUT, GIT_USER_TIMEOUT, WORKTREE_DIR,
} from './state.js';
import { saveConfig, syncOrphansToConfig } from './config.js';
import { parseGitStatus, buildFileTree, repoDirName } from '../lib/helpers.js';

// --- Git Exec ---
export function gitExec(args, opts = {}) {
  const timeout = opts.timeout || GIT_AUTO_TIMEOUT;
  const cwd = opts.cwd;
  // LC_ALL=C so stderr stays English. createWorktree decides whether to retry by
  // matching git's message, and distro git ships translated message catalogs — a
  // non-English operator would otherwise turn every branch collision into a hard
  // spawn failure.
  // GIT_TERMINAL_PROMPT=0 so a command that needs credentials fails fast instead
  // of blocking on a prompt nobody can answer. Only the pre-spawn fetch talks to
  // a network today, but a server must never be one auth prompt away from
  // hanging, so it is set for every git call.
  const env = { ...process.env, LC_ALL: 'C', LANGUAGE: '', GIT_TERMINAL_PROMPT: '0' };
  return new Promise((resolve, reject) => {
    execFileCb('git', args, { timeout, maxBuffer: 1024 * 1024, cwd, env }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// --- Path Validation ---
export async function validateRepoPath(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') return { valid: false, error: 'Path is required' };
  // isAbsolute rather than a leading-slash test: an absolute Windows path is
  // `C:\repo` or `\\server\share`, neither of which starts with a slash, so the
  // old check rejected every path on Windows. The point of the guard is to stop
  // a relative path resolving against the server's own cwd, which isAbsolute
  // enforces on both platforms.
  if (!isAbsolute(repoPath)) return { valid: false, error: 'Path must be absolute' };
  if (!existsSync(repoPath)) return { valid: false, error: 'Directory does not exist' };
  let resolvedPath;
  try { resolvedPath = realpathSync(repoPath); } catch { return { valid: false, error: 'Cannot resolve path' }; }
  try { await gitExec(['-C', resolvedPath, 'rev-parse', '--git-dir']); } catch { return { valid: false, error: 'Not a git repository' }; }
  try {
    await gitExec(['-C', resolvedPath, 'rev-parse', 'HEAD']);
  } catch {
    try {
      await gitExec(['-C', resolvedPath, 'commit', '--allow-empty', '-m', 'Initial commit']);
      console.log(`Created initial commit for empty repo: ${resolvedPath}`);
    } catch (err) {
      return { valid: false, error: 'Repository has no commits and could not create one' };
    }
  }
  return { valid: true, resolvedPath };
}

// --- Repo Management ---

// How long to wait for the pre-spawn fetch. Longer than GIT_AUTO_TIMEOUT because
// this one talks to the network, but bounded: a slow or unreachable remote must
// delay a spawn, never block it. On timeout we fall back to local refs.
//
// This sits inside the spawn path, so it has to fit the client's spawn budget
// (see the spawn-form timeout in public/app.js) with room left for the worktree
// add and the PTY spawn. Raise one without the other and a slow fetch makes the
// UI report a timeout for a spawn that is still on its way to succeeding.
const FETCH_TIMEOUT = 10000;

// The repo's base branch, by name (no `origin/` prefix). Asks the remote's own
// HEAD first, so a repo whose default is `develop` or `trunk` is handled without
// a hardcoded list; falls back to the two common names, then null.
export async function resolveBaseBranch(repoPath) {
  try {
    const ref = await gitExec(['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
    const name = ref.trim().replace('refs/remotes/origin/', '');
    if (name) return name;
  } catch (_) {}
  for (const candidate of ['main', 'master']) {
    try {
      await gitExec(['-C', repoPath, 'rev-parse', '--verify', candidate]);
      return candidate;
    } catch (_) {}
  }
  return null;
}

// What a new agent's branch should start FROM.
//
// `worktree add -b <name>` with no start-point uses HEAD of the main checkout —
// whatever the user happens to have checked out there. That is wrong twice over:
// a local base branch that has fallen behind silently starts the agent on
// superseded code, and a user sitting on an unrelated feature branch hands the
// agent that branch's half-finished work, which then rides along in its PR.
//
// So: refresh the remote refs, then branch from `origin/<base>` — what a person
// does by hand with `git fetch && git checkout -b feature origin/main`.
//
// Every step degrades instead of failing. No network, no remote, or a repo that
// has never been pushed falls back to the local base branch, and a repo with
// neither falls back to null, which means "use HEAD" — the old behaviour, which
// is still correct for a brand-new repo with a single branch.
async function resolveStartPoint(repoPath, explicit) {
  // An explicitly requested start-point is the user's call, but it arrives from
  // a WebSocket message and lands in a git argument list, so it is checked
  // twice before use.
  //
  // A leading dash is refused outright: `worktree add <path> -b <name> --detach`
  // parses that as an OPTION, not a commit-ish (git says "options '-b', '-B',
  // and '--detach' cannot be used together"), and a `--` delimiter does not
  // protect this position. No legitimate value is affected — a git ref name
  // cannot begin with a dash.
  //
  // Then it must actually resolve. Without that a typo fails later inside
  // `worktree add` with a message about a branch the user never typed; here it
  // fails immediately, naming what they asked for.
  if (explicit) {
    if (explicit.startsWith('-')) {
      return { error: `Invalid start point "${explicit}" — a branch, tag or commit cannot start with "-"` };
    }
    try {
      await gitExec(['-C', repoPath, 'rev-parse', '--verify', '--quiet', `${explicit}^{commit}`]);
    } catch (_) {
      return { error: `Start point "${explicit}" not found in this repository` };
    }
    return { ref: explicit };
  }

  try {
    await gitExec(['-C', repoPath, 'fetch', 'origin', '--quiet'], { timeout: FETCH_TIMEOUT });
  } catch (_) {
    // Offline, no remote, or auth prompt suppressed. Local refs may be stale,
    // which is still better than HEAD of an unrelated branch.
  }

  const base = await resolveBaseBranch(repoPath);
  if (!base) return { ref: null };
  for (const ref of [`origin/${base}`, base]) {
    try {
      await gitExec(['-C', repoPath, 'rev-parse', '--verify', ref]);
      return { ref };
    } catch (_) {}
  }
  return { ref: null };
}

// The `${gitUser}` half of every branch this app creates, e.g. `bill/vesper`.
// Falls back to `agent` when the repo has no user.name configured.
async function branchPrefix(repoPath) {
  try {
    const name = (await gitExec(['-C', repoPath, 'config', 'user.name'])).trim().toLowerCase().replace(/\s+/g, '-');
    // An UNSET user.name exits non-zero and lands in the catch, but one set to
    // the empty string exits 0 with empty output. Without this the prefix is
    // '', every candidate becomes `/vesper`, and git rejects all of them
    // ("not a valid branch name") — so every spawn in that repo fails after
    // walking the whole pool.
    return name || 'agent';
  } catch (_) {
    return 'agent';
  }
}

export async function addRepo(repoPath, broadcast) {
  const validation = await validateRepoPath(repoPath);
  if (!validation.valid) return { error: validation.error };
  const resolved = validation.resolvedPath;
  if (config.repos.some(r => r.path === resolved)) {
    return { ok: true, path: resolved, slug: basename(resolved) };
  }
  config.repos.push({ path: resolved, addedAt: new Date().toISOString() });
  saveConfig(broadcast);
  broadcastReposList(broadcast);
  return { ok: true, path: resolved, slug: basename(resolved) };
}

export function removeRepo(repoPath, broadcast) {
  config.repos = config.repos.filter(r => r.path !== repoPath);
  saveConfig(broadcast);
  broadcastReposList(broadcast);
}

export function broadcastReposList(broadcast) {
  if (!broadcast) return;
  broadcast({
    type: 'repos-list',
    repos: config.repos.map(r => ({
      path: r.path,
      slug: basename(r.path),
      exists: existsSync(r.path),
    })),
  });
}

// --- Worktree Management ---
// Only a BRANCH collision is worth retrying under a different cocktail. The
// worktree-dir collision (`fatal: '<path>' already exists`) also contains the
// words "already exists" but no other name can fix it, so matching the looser
// substring would walk the entire pool for nothing.
//
// Two messages, because git checks the branch then locks the ref: the common one
// comes from the existence check, and the second from losing the lock race after
// passing that check. Both mean the same thing — the name is taken, try another.
const BRANCH_EXISTS_RE = /a branch named .* already exists|cannot lock ref '[^']*': reference already exists/;

// Branch names that exist on the remote. Needed because a finished job deletes
// its LOCAL branch but deliberately leaves the remote one alone — that is the
// open PR. So `worktree add -b` will happily hand out a name whose remote
// counterpart still exists, and the new agent's first `git push -u` then fails
// non-fast-forward (or, worse, force-pushes over someone's open PR).
//
// Best-effort: on a timeout, no remote, or no network this returns null and the
// caller falls back to local-only checking, which is what it did before.
async function remoteBranchNames(repoPath) {
  try {
    const out = await gitExec(['-C', repoPath, 'ls-remote', '--heads', 'origin']);
    const names = new Set();
    for (const line of out.split('\n')) {
      const match = line.match(/refs\/heads\/(.+)$/);
      if (match) names.add(match[1].trim());
    }
    return names;
  } catch {
    return null;
  }
}

// Ask git for a name rather than tracking which names are free.
//
// `worktree add -b` creates the ref atomically: it either succeeds, or it tells us
// the branch is taken and leaves nothing behind (no partial worktree dir to clean
// up — verified). So we walk candidates until one lands. That also settles
// concurrent spawns for free: two agents opening with the same cocktail can't both
// win, and the loser simply takes the next candidate instead of erroring.
//
// `customBranch` never retries — the user asked for that specific name, so a
// collision is an error to report, not a cue to silently pick something else.
export async function createWorktree(repoPath, agentName, customBranch, { suffixOnCollision = false, startPoint = null } = {}) {
  const dirName = repoDirName(repoPath);
  const gitUser = await branchPrefix(repoPath);
  const worktreePath = join(WORKTREE_DIR, dirName, agentName);
  mkdirSync(join(WORKTREE_DIR, dirName), { recursive: true });

  // Resolved once: the fetch inside it must not run per candidate name.
  const resolved = await resolveStartPoint(repoPath, startPoint);
  if (resolved.error) return { error: resolved.error };
  const start = resolved.ref;

  const attempt = async (cocktail) => {
    const branchName = `${gitUser}/${cocktail}`;
    const args = ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branchName];
    if (start) args.push(start);
    try {
      await gitExec(args);
      return { worktreePath, branchName, cocktail, startPoint: start };
    } catch (err) {
      const msg = err.stderr || err.message || '';
      if (BRANCH_EXISTS_RE.test(msg)) return { branchTaken: true, branchName };
      return { error: `Failed to create worktree: ${msg}` };
    }
  };

  if (customBranch) {
    // suffixOnCollision is for names DERIVED from something else — the job
    // board builds a branch from the job title, and two jobs may reasonably
    // share a title ("fix flaky test"). A hard failure there would strand the
    // job forever, so walk -2, -3, ... the same way the cocktail pool does.
    //
    // A name the USER typed still fails loudly: they asked for that specific
    // branch, so a collision is something to report, not to silently rename.
    if (suffixOnCollision) {
      const MAX_SUFFIX = 50;
      const remote = await remoteBranchNames(repoPath);
      for (let n = 1; n <= MAX_SUFFIX; n++) {
        const candidate = n === 1 ? customBranch : `${customBranch}-${n}`;
        // Skip names already taken on the remote, not just locally.
        if (remote && remote.has(`${gitUser}/${candidate}`)) continue;
        const result = await attempt(candidate);
        if (result.branchTaken) continue;
        return result;
      }
      return { error: `Could not find a free branch name based on "${customBranch}"` };
    }
    const result = await attempt(customBranch);
    if (result.branchTaken) {
      return { error: `Branch "${result.branchName}" already in use — choose a different agent name` };
    }
    return result;
  }

  // Bounded so a repo that somehow rejects everything fails loudly instead of
  // spawning git in a loop. Either bound can end the walk, so report what actually
  // happened rather than assuming we spent the whole budget.
  const MAX_TRIES = 100;
  let tries = 0;
  for (const cocktail of cocktailPool.candidates(repoPath)) {
    if (tries >= MAX_TRIES) break;
    tries++;
    const result = await attempt(cocktail);
    if (result.branchTaken) { cocktailPool.reject(repoPath, cocktail); continue; }
    return result;
  }
  return { error: `Could not find a free branch name after ${tries} attempts` };
}

export async function removeWorktree(session) {
  if (!session.worktreePath || !session.repoPath) return { orphaned: false };
  if (!existsSync(join(session.worktreePath, '.git'))) {
    return existsSync(session.worktreePath) ? { orphaned: true, reason: 'broken-worktree' } : { orphaned: false };
  }
  try {
    let reason = null;
    try {
      const status = await gitExec(['-C', session.worktreePath, 'status', '--porcelain']);
      if (status.trim()) reason = 'uncommitted';
    } catch { reason = 'uncommitted'; }
    // Fully pushed to its upstream? Then nothing is at risk locally — the
    // commits are on the remote. This is exactly the state right after
    // `gh pr create`, so a finished job's worktree and local branch can be
    // removed even though the branch is not merged into the base branch. The
    // pull request is unaffected: it references the remote branch, not this
    // worktree. Without this check the base-branch test below calls every
    // PR-ready branch "unpushed" and orphans it, which would leave one stale
    // worktree per completed job.
    let fullyPushed = false;
    if (!reason) {
      try {
        const local = (await gitExec(['-C', session.worktreePath, 'rev-parse', 'HEAD'])).trim();
        const upstream = (await gitExec(['-C', session.worktreePath, 'rev-parse', '@{u}'])).trim();
        fullyPushed = !!local && local === upstream;
      } catch {
        // No upstream configured, or the remote ref is unknown locally: treat
        // as not pushed and fall through to the conservative base-branch check.
        fullyPushed = false;
      }
    }
    if (!reason && !fullyPushed) {
      const baseBranch = await resolveBaseBranch(session.repoPath);
      if (baseBranch) {
        try {
          const log = await gitExec(['-C', session.repoPath, 'log', `${baseBranch}..${session.branchName}`, '--oneline']);
          if (log.trim()) reason = 'unpushed';
        } catch { reason = 'unpushed'; }
      }
    }
    if (reason) return { orphaned: true, reason };
    try { await gitExec(['-C', session.repoPath, 'worktree', 'remove', session.worktreePath]); } catch {
      try { await gitExec(['-C', session.repoPath, 'worktree', 'remove', '--force', session.worktreePath]); } catch (err) {
        console.error('Force worktree remove failed:', err.message);
        return { orphaned: true, reason: 'cleanup-failed' };
      }
    }
    await deleteBranch(session.repoPath, session.branchName);
    return { orphaned: false };
  } catch (err) {
    console.error('Worktree cleanup error:', err.message);
    return { orphaned: true, reason: 'cleanup-failed' };
  }
}

// Delete an agent's branch, cleaning up first so it actually succeeds. If the
// worktree directory was removed but git still registers it (a "prunable"
// worktree), `git branch -D` refuses with "branch is checked out at <path>" and
// the branch leaks. Pruning stale registrations first clears that, so the branch
// is really deleted instead of accumulating until every cocktail name is taken.
export async function deleteBranch(repoPath, branchName) {
  if (!repoPath || !branchName) return;
  try { await gitExec(['-C', repoPath, 'worktree', 'prune']); } catch {}
  try {
    await gitExec(['-C', repoPath, 'branch', '-D', branchName]);
  } catch (err) {
    console.error(`Failed to delete branch ${branchName}:`, err.stderr || err.message);
  }
}

export async function pruneWorktrees() {
  for (const repo of config.repos) {
    if (!existsSync(repo.path)) continue;
    try { await gitExec(['-C', repo.path, 'worktree', 'prune']); } catch (err) {
      console.warn(`Worktree prune failed for ${repo.path}:`, err.message);
    }
  }
}

export async function scanForOrphanedWorktrees(broadcast) {
  if (!existsSync(WORKTREE_DIR)) return;
  try {
    for (const repoDir of readdirSync(WORKTREE_DIR)) {
      const repoWorktreePath = join(WORKTREE_DIR, repoDir);
      let stat;
      try { stat = statSync(repoWorktreePath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const agentDir of readdirSync(repoWorktreePath)) {
        const worktreePath = join(repoWorktreePath, agentDir);
        try { if (!statSync(worktreePath).isDirectory()) continue; } catch { continue; }
        if ([...orphans.values()].some(o => o.worktreePath === worktreePath)) continue;
        if ([...sessions.values()].some(s => s.worktreePath === worktreePath)) continue;
        let repoPath = null;
        try {
          const gitDir = await gitExec(['-C', worktreePath, 'rev-parse', '--git-dir']);
          const match = gitDir.trim().match(/^(.+)\/\.git\/worktrees\//);
          if (match) repoPath = match[1];
        } catch { continue; }
        if (!repoPath) continue;
        let branchName = null;
        try {
          const head = await gitExec(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
          branchName = head.trim();
        } catch { branchName = 'unknown'; }
        const orphanId = `orphan-${Date.now()}-${agentDir}`;
        const orphan = {
          id: orphanId, name: agentDir, repoPath, repoSlug: basename(repoPath),
          worktreePath, branchName, color: colorCycler.next(),
          reason: 'discovered', createdAt: new Date().toISOString(),
        };
        orphans.set(orphanId, orphan);
        codenamePool.addUsed(agentDir);
        console.log(`Discovered orphaned worktree: ${agentDir} in ${repoPath}`);
      }
    }
    if (orphans.size > 0) syncOrphansToConfig(broadcast);
  } catch (err) {
    console.error('Orphan scan error:', err.message);
  }
}

// --- File Tree Scanning ---
export async function scanFileTree(session, broadcast) {
  if (!session.worktreePath) return;
  if (!existsSync(session.worktreePath)) return;
  try {
    try {
      const head = await gitExec(['-C', session.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const currentBranch = head.trim();
      if (currentBranch && currentBranch !== session.branchName) {
        session.branchName = currentBranch;
        if (broadcast) broadcast({ type: 'branch-changed', sessionId: session.id, branchName: currentBranch });
      }
    } catch (_) {}
    const stdout = await gitExec(['-C', session.worktreePath, 'status', '--porcelain=v1']);
    const hash = createHash('md5').update(stdout).digest('hex');
    if (hash === session.lastTreeHash) return;
    session.lastTreeHash = hash;
    const files = parseGitStatus(stdout);
    const tree = buildFileTree(files, basename(session.repoPath));
    session.fileTree = files;
    session.changedCount = files.length;
    let additions = 0, removals = 0;
    try {
      const diffStat = await gitExec(['-C', session.worktreePath, 'diff', '--numstat']);
      for (const line of diffStat.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const a = parseInt(parts[0], 10);
          const r = parseInt(parts[1], 10);
          if (!isNaN(a)) additions += a;
          if (!isNaN(r)) removals += r;
        }
      }
    } catch (_) {}
    session.additions = additions;
    session.removals = removals;
    if (broadcast) broadcast({ type: 'file-tree', sessionId: session.id, tree, files, changedCount: files.length, additions, removals });
    const conflicts = detectConflicts(session.repoPath);
    if (broadcast) broadcast({ type: 'conflicts-update', conflicts });
  } catch (err) {
    console.error(`File tree scan failed for ${session.id}:`, err.message);
  }
}

// Poll cadence for the recurring file-tree/branch scan. The branch shown in the
// UI is refreshed on every cycle (see DESIGN.md "Branch sync"), so this also
// governs how quickly a `git checkout -b` inside the terminal is reflected.
export const SCAN_INTERVAL_MS = 1500;

// Start (or restart) the recurring scan loop for a session. Self-reschedules
// after each scan completes rather than using setInterval, so slow git calls
// never overlap. Stops once the session has exited. `session.scanTimer` holds
// the pending timer so killSession/onExit can cancel it.
//
// Idle gate: a session's branch/tree/diff only changes as a result of terminal
// activity (the agent running git/edit commands), which bumps lastOutputAt in
// the PTY onData handler. So we skip the git scan on cycles where there's been
// no new output since the last scan — an idle session costs zero git calls.
// The first cycle always scans so a fresh session shows its initial tree. This
// gate lives in the loop, not scanFileTree, so manual refresh-tree still scans
// unconditionally. Tradeoff: worktree changes made outside this terminal aren't
// picked up until the next terminal activity or a manual refresh.
export function startTreeScanLoop(session, broadcast) {
  clearTimeout(session.scanTimer);
  const tick = async () => {
    const hasNewOutput = session.lastOutputAt !== session.lastScanOutputAt;
    if (!session.scannedOnce || hasNewOutput) {
      session.scannedOnce = true;
      // Capture before the await: output arriving mid-scan advances lastOutputAt
      // past this value, so the next cycle rescans instead of dropping the change.
      session.lastScanOutputAt = session.lastOutputAt;
      await scanFileTree(session, broadcast);
    }
    if (!session.exited) session.scanTimer = setTimeout(tick, SCAN_INTERVAL_MS);
  };
  session.scanTimer = setTimeout(tick, SCAN_INTERVAL_MS);
}

// --- Conflict Detection ---
export function detectConflicts(repoPath) {
  const repoSessions = [...sessions.values()].filter(s => s.repoPath === repoPath && s.fileTree);
  const conflicts = [];
  const currentKeys = new Set();
  for (let i = 0; i < repoSessions.length; i++) {
    for (let j = i + 1; j < repoSessions.length; j++) {
      const a = repoSessions[i], b = repoSessions[j];
      const pathsA = a.fileTree.map(f => f.path);
      const pathsB = b.fileTree.map(f => f.path);
      const overlap = pathsA.filter(p => pathsB.includes(p));
      if (overlap.length > 0) {
        conflicts.push({ sessionIds: [a.id, b.id], files: overlap });
        for (const file of overlap) {
          const key = [a.id, b.id].sort().join('\0') + '\0' + file;
          if (!knownConflictKeys.has(key)) {
            // broadcast handled by caller
          }
          currentKeys.add(key);
        }
      }
    }
  }
  knownConflictKeys.clear();
  for (const key of currentKeys) knownConflictKeys.add(key);
  return conflicts;
}

// --- Diff ---
// Read a file inside the worktree, refusing paths that escape it. `filePath` is
// client-controlled and get-diff is open to non-owners (phase 2 read surface), so
// without this a `../../../etc/passwd` reads arbitrary host files. realpathSync
// also collapses symlinks, blocking symlink-based escapes.
function readInsideWorktree(worktreePath, filePath) {
  const root = realpathSync(worktreePath);
  const full = realpathSync(join(worktreePath, filePath));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('path escapes worktree');
  }
  return readFileSync(full, 'utf8');
}

export async function getDiff(session, filePath, status) {
  if (!session.worktreePath) return '';
  try {
    switch (status) {
      case 'M':
        return await gitExec(['-C', session.worktreePath, 'diff', '--', filePath], { timeout: GIT_USER_TIMEOUT });
      case 'A': {
        try {
          const cached = await gitExec(['-C', session.worktreePath, 'diff', '--cached', '--', filePath], { timeout: GIT_USER_TIMEOUT });
          if (cached.trim()) return cached;
        } catch {}
        try { return await gitExec(['-C', session.worktreePath, 'show', `:${filePath}`], { timeout: GIT_USER_TIMEOUT }); } catch {
          return readInsideWorktree(session.worktreePath, filePath);
        }
      }
      case 'D':
        return await gitExec(['-C', session.worktreePath, 'diff', '--', filePath], { timeout: GIT_USER_TIMEOUT });
      case '?': {
        try {
          const content = readInsideWorktree(session.worktreePath, filePath);
          return content.split('\n').map((line) => `+${line}`).join('\n');
        } catch (err) { return `Error reading file: ${err.message}`; }
      }
      case 'R':
        return await gitExec(['-C', session.worktreePath, 'diff', 'HEAD', '--', filePath], { timeout: GIT_USER_TIMEOUT });
      default:
        return await gitExec(['-C', session.worktreePath, 'diff', '--', filePath], { timeout: GIT_USER_TIMEOUT });
    }
  } catch (err) { return `Error loading diff: ${err.message}`; }
}
