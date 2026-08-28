// Path shapes, for the directory browser.
//
// The server answers with paths in its own platform's shape, so the browser
// cannot assume POSIX: an absolute path is `/home/me` on Linux and macOS but
// `C:\Users\me` or `\\server\share` on Windows. Treating those Windows forms as
// relative is what made the repo picker discard a typed path there.

/** True for an absolute POSIX path, a drive-letter path, or a UNC share. */
export function isAbsolutePath(p) {
  return !!p && (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\'));
}

/**
 * Append a child to a directory path, keeping the separator that path already
 * uses and not doubling the one a root already ends with.
 */
export function joinBrowsePath(dir, name) {
  const sep = !dir.startsWith('/') && dir.includes('\\') ? '\\' : '/';
  return /[\\/]$/.test(dir) ? dir + name : dir + sep + name;
}
