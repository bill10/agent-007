// Which CLI last worked in a directory, read off the transcripts the CLIs
// themselves leave behind. The last resort when re-adopting an orphan whose
// record does not say (written before the agent was noted, or discovered from
// a bare worktree on disk) and whose branch has no job card.
//
// Claude Code keeps one directory per working directory under
// ~/.claude/projects, named after the path with every character that is not a
// letter or digit turned into a dash. Codex keeps one rollout file per session
// under ~/.codex/sessions/YYYY/MM/DD, whose first line is a session_meta
// record naming its cwd. Each CLI honours its own home override
// (CLAUDE_CONFIG_DIR, CODEX_HOME), so the probe does too, or an agent that
// ran with one would be looked for in the wrong place.
//
// Where both left something, the newer transcript wins: it is the session
// `--continue` / a Codex resume of that worktree's newest session would pick
// up anyway.

import { readdirSync, statSync, openSync, readSync, closeSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'); }
function codexHome() { return process.env.CODEX_HOME || join(homedir(), '.codex'); }

// Newest transcript's mtime, or null when there is none.
function newestClaudeTranscript(worktreePath, home) {
  const dir = join(home, 'projects', worktreePath.replace(/[^A-Za-z0-9]/g, '-'));
  let newest = null;
  for (const ent of safeReaddir(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const m = transcriptMtime(join(dir, ent.name));
    if (m !== null && (newest === null || m > newest)) newest = m;
  }
  return newest;
}

// A transcript's mtime, or null for one that could not be a session: empty,
// or not a regular file. Both CLIs' homes are the user's own, so this is not
// a defence against an attacker there — who already has everything — but an
// empty stray or a directory named like a transcript must not outvote the
// real session next to it, and a FIFO must never be opened at all, since a
// synchronous open on one without a writer would stall the whole server.
function transcriptMtime(path) {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0 ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

// Only the first line of each rollout is read: the cwd is on it, and a long
// session's file can run to many megabytes. That line is not short, though —
// the session_meta record carries Codex's full base instructions, some 22 KB
// in codex-cli 0.153 — so it is read in chunks up to the first newline, with a
// cap in case some future record never ends.
const ROLLOUT_CHUNK_BYTES = 16 * 1024;
const ROLLOUT_LINE_CAP_BYTES = 1024 * 1024;

// The session's cwd and id, or null for a rollout that is not an
// interactive, top-level session.
function rolloutMeta(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const chunks = [];
    let total = 0;
    let line = null;
    while (total < ROLLOUT_LINE_CAP_BYTES) {
      const buf = Buffer.alloc(ROLLOUT_CHUNK_BYTES);
      const n = readSync(fd, buf, 0, ROLLOUT_CHUNK_BYTES, total);
      if (n === 0) { line = Buffer.concat(chunks); break; }
      chunks.push(buf.subarray(0, n));
      total += n;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl !== -1) { line = Buffer.concat(chunks).subarray(0, total - n + nl); break; }
    }
    if (line === null) return null;   // capped out without a newline
    const meta = JSON.parse(line.toString('utf8'));
    if (!meta || meta.type !== 'session_meta' || !meta.payload) return null;
    // Only an interactive, top-level session counts: Codex's resume picker
    // skips `codex exec` runs and subagent threads, so a rollout of either
    // kind is not evidence that anything can be resumed here — and a Claude
    // agent shelling out to `codex exec` in its own worktree leaves exactly
    // such a rollout, newer than its own transcript. Fields absent on older
    // rollouts are read as interactive.
    const { source, thread_source: thread } = meta.payload;
    if (source !== undefined && source !== 'cli') return null;
    if (thread !== undefined && thread !== 'user') return null;
    return { cwd: meta.payload.cwd, id: meta.payload.id || meta.payload.session_id || null };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

// Newest matching rollout as { m, id } (its mtime and session id), or null.
// Only files newer than `floor` are considered — transcriptsFor passes the
// Claude transcript's mtime, since a Codex session no newer than that can
// never win the comparison and so need not be opened; codexSessionIdFor
// passes none, so a miss there reads up to ROLLOUT_SCAN_CAP first lines. Stat everything first (cheap), then read first lines newest
// first and stop at the first cwd match: a hit costs a few reads however many
// months of sessions sit on disk, and this runs on the ws thread, where every
// millisecond is one nobody's terminal gets. A miss would otherwise read
// every file newer than the floor, bounded only by history, so the scan stops
// after the newest ROLLOUT_SCAN_CAP rollouts: an orphan whose last Codex
// session is older than that many later sessions is a stale one, and for it
// the answer falls back to the default, exactly as it did before this probe.
const ROLLOUT_SCAN_CAP = 500;

function newestCodexTranscript(worktreePaths, home, floor = -Infinity) {
  const candidates = [];
  const walk = (dir, depth) => {
    for (const ent of safeReaddir(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 3) walk(path, depth + 1);   // sessions/YYYY/MM/DD, no deeper
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;   // symlinks and FIFOs included
      const m = transcriptMtime(path);
      if (m !== null && m > floor) candidates.push({ path, m });
    }
  };
  // gstack-shortcut(dec-75da2913-0e19-4bf8-95c9-429bcbdaa95c): stats every rollout in history, synchronously, upgrade when Codex history reaches thousands of rollouts or a re-spawn stalls terminals.
  walk(join(home, 'sessions'), 0);
  candidates.sort((a, b) => b.m - a.m);
  for (const { path, m } of candidates.slice(0, ROLLOUT_SCAN_CAP)) {
    const meta = rolloutMeta(path);
    if (meta && worktreePaths.includes(meta.cwd)) return { m, id: meta.id };
  }
  return null;
}

function maxOf(values) {
  const known = values.filter(v => v !== null);
  return known.length ? Math.max(...known) : null;
}

function safeReaddir(dir, opts) { try { return readdirSync(dir, opts); } catch { return []; } }

// Which CLI last worked in the path — 'claude', 'codex', or null when neither
// has a transcript for it — and, when it is Codex, that session's id, from
// the same scan.
//
// Both CLIs record the physical directory they ran in (getcwd), so a worktree
// reached through a symlink — /tmp on macOS is /private/tmp, a linked home —
// is filed under the resolved path. Looked up under both forms.
function pathForms(worktreePath) {
  let real = worktreePath;
  try { real = realpathSync.native(worktreePath); } catch {}
  return real === worktreePath ? [worktreePath] : [worktreePath, real];
}

export function transcriptsFor(worktreePath, { claude = claudeHome(), codex = codexHome() } = {}) {
  const none = { agent: null, codexSessionId: null };
  if (!worktreePath) return none;
  const forms = pathForms(worktreePath);
  const c = maxOf(forms.map(p => newestClaudeTranscript(p, claude)));
  const x = newestCodexTranscript(forms, codex, c === null ? -Infinity : c);
  if (c === null && x === null) return none;
  if (x === null || (c !== null && x.m <= c)) return { agent: 'claude', codexSessionId: null };
  return { agent: 'codex', codexSessionId: x.id };
}

export function agentFromTranscripts(worktreePath, homes) {
  return transcriptsFor(worktreePath, homes).agent;
}

// The id of the newest interactive Codex session that ran in exactly this
// worktree, or null. `codex resume --last` cannot be trusted with this: its
// cwd filter treats every worktree of one repo as the same place, so an agent
// re-spawned in one worktree resumed whichever sibling's session was newest —
// and, with that sibling still running, stalled on "This conversation is open
// in another app". Resuming by id pins each agent to its own conversation.
export function codexSessionIdFor(worktreePath, { codex = codexHome() } = {}) {
  if (!worktreePath) return null;
  return newestCodexTranscript(pathForms(worktreePath), codex)?.id ?? null;
}
