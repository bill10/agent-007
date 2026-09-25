// Claude Code stops at a workspace-trust dialog the first time it runs in a
// folder, and every board worker gets a brand-new worktree, so every dispatch
// used to wait for a click. Trust is recorded per absolute path in
// ~/.claude.json (projects[<path>].hasTrustDialogAccepted); writing that entry
// before the spawn skips the dialog. Verified against claude 2.1.282.
//
// Claude Code rewrites this file itself, constantly, so the write is kept as
// small as it can be: read, add one entry, write a temp file beside it, rename.
// A running claude that read the file before the rename and writes after it can
// still drop the entry, and a write of Claude Code's that lands while we
// build ours makes us give up rather than overwrite it, so the PTY answer
// (server/pty.js, answerTrustDialog) stays on as a fallback. A missing or
// unreadable file is left alone: it is Claude Code's, and a guess at its shape
// would be worse than one dialog.
import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { sessionAgentFromCommand } from '../lib/jobs.js';
import { envSwitchOn } from '../lib/helpers.js';

// Board-dispatched Claude Code workers only, and on unless
// TRUST_BOARD_WORKTREES says otherwise (0/false/off/no). Hand-started agents
// keep the dialog.
export function autoTrusts({ spawnedBy, worktreePath, command }, env = process.env) {
  return spawnedBy === 'board' && !!worktreePath && sessionAgentFromCommand(command) === 'claude'
    && envSwitchOn(env.TRUST_BOARD_WORKTREES);
}

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// True when the entry is there afterwards. Never throws. Workers inherit the
// server's environment, so CLAUDE_CONFIG_DIR moves their file and ours alike.
export function trustClaudeFolder(folder, { home = homedir(), env = process.env } = {}) {
  let file = join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  let tmp = null;
  try {
    file = realpathSync(file);   // a dotfiles symlink stays a symlink
    tmp = `${file}.agent007-${process.pid}.tmp`;
    const before = statSync(file);
    // claude records the path as its cwd reports it, which is the real one
    // (/tmp is /private/tmp on macOS).
    const path = realpathSync(folder);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    // Any part not shaped as expected means the file is not what we think it
    // is: leave it to Claude Code rather than overwrite what we don't know.
    const projects = data?.projects ?? {};
    if (!isRecord(data) || !isRecord(projects) || !isRecord(projects[path] ?? {})) return false;
    if (projects[path]?.hasTrustDialogAccepted === true) return true;
    data.projects = { ...projects, [path]: { ...projects[path], hasTrustDialogAccepted: true } };
    rmSync(tmp, { force: true });   // a leftover from a crash; 'wx' never follows one
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: before.mode & 0o777, flag: 'wx' });
    // Claude Code wrote the file while we built ours: renaming now would drop
    // its change. Leave it to the PTY fallback instead.
    const now = statSync(file);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size || now.ino !== before.ino) {
      rmSync(tmp, { force: true });
      return false;
    }
    renameSync(tmp, file);
    return true;
  } catch (err) {
    if (tmp) rmSync(tmp, { force: true });
    console.error(`Could not pre-trust ${folder} in ${file}: ${err.message}`);
    return false;
  }
}
