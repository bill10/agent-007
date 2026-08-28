// Windows executable resolution for PTY spawns.
//
// node-pty checks that the command exists before returning, but it launches
// through CreateProcessW with the *unresolved* name. CreateProcessW only ever
// appends `.exe` — it does not consult PATHEXT — so an npm-installed command
// like `claude` (which ships as `claude.cmd` plus an extensionless bash shim)
// passes node-pty's existence check and then fails inside the console host
// with "Cannot create process, error code: 2" (ERROR_FILE_NOT_FOUND).
//
// Worse, that failure is raised on the conout worker thread *after* spawn()
// has already returned, so it lands as an uncaught exception rather than
// something the caller can try/catch. Resolving the command to a full path
// with a launchable extension up front is what keeps it from happening.

import { statSync } from 'fs';
import { delimiter, extname, isAbsolute, resolve, sep } from 'path';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * Resolve `file` to a path CreateProcessW can actually launch.
 *
 * Returns the resolved absolute path, or null when nothing matched — callers
 * fall back to the original name so node-pty keeps whatever resolution it can
 * do on its own. Non-Windows platforms are returned unchanged: execvp handles
 * PATH lookup there and has no PATHEXT quirk.
 *
 * @param {string} file      command as typed, e.g. 'claude'
 * @param {object} [env]     environment to read PATH/PATHEXT from
 * @param {string} [platform]
 * @param {string} [cwd]     base for relative paths
 */
export function resolveExecutable(file, env = process.env, platform = process.platform, cwd = process.cwd()) {
  if (platform !== 'win32' || !file) return null;

  // PATHEXT is conventionally uppercase but the files on disk are not, and the
  // resolved path ends up in log lines and error messages, so match the
  // lowercase convention. Windows itself does not care either way.
  const exts = (env.PATHEXT || DEFAULT_PATHEXT)
    .split(';')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  // A command that already carries a launchable extension is used verbatim;
  // anything else gets each PATHEXT entry appended, the same order cmd.exe
  // would try them in.
  const ownExt = extname(file);
  const candidates = ownExt && exts.includes(ownExt.toLowerCase())
    ? [file]
    : exts.map(e => file + e);

  // A command containing a separator is a path, not a PATH lookup.
  if (file.includes('/') || file.includes(sep) || isAbsolute(file)) {
    for (const candidate of candidates) {
      const full = resolve(cwd, candidate);
      if (isFile(full)) return full;
    }
    return null;
  }

  const dirs = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  // cmd.exe looks in the working directory before PATH.
  for (const dir of [cwd, ...dirs]) {
    for (const candidate of candidates) {
      const full = resolve(dir.replace(/^"|"$/g, ''), candidate);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/**
 * True when `dir` is usable as a PTY working directory.
 *
 * CreateProcessW rejects a missing lpCurrentDirectory with error code 267
 * (ERROR_DIRECTORY) — and, like the command lookup above, it does so
 * asynchronously. A re-spawn whose worktree has since been deleted is the
 * common way to get there, so the caller checks first and reports a real
 * error instead of taking the server down.
 */
export function isUsableCwd(dir) {
  if (!dir) return false;
  try { return statSync(dir).isDirectory(); } catch { return false; }
}
