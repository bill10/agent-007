// Entry-point detection for server.js.
//
// Node builds import.meta.url for the main module from the entry file's
// realpath (unless --preserve-symlinks-main), while process.argv[1] keeps the
// path as the user typed it. A naive comparison therefore misses launches
// through symlinks/junctions (macOS /tmp -> /private/tmp, relocated Windows
// folders), and string-suffix tricks miss percent-encoded characters (spaces,
// ~) in the install path. Comparing file URLs of the realpathed argv covers
// all of these; pathToFileURL applies the exact encoding Node uses for
// import.meta.url.
import { realpathSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

export function isDirectRun(importMetaUrl, argv1) {
  if (!argv1) return false;
  // Raw comparison first: covers --preserve-symlinks-main, where the loader
  // keeps the typed path instead of realpathing it.
  if (importMetaUrl === pathToFileURL(argv1).href) return true;
  try {
    let entryPath = realpathSync(argv1);
    if (statSync(entryPath).isDirectory()) {
      // `node .` — the loader resolved the entry via package.json "main".
      const pkg = JSON.parse(readFileSync(join(entryPath, 'package.json'), 'utf8'));
      entryPath = realpathSync(join(entryPath, pkg.main || 'index.js'));
    }
    return importMetaUrl === pathToFileURL(entryPath).href;
  } catch {
    // argv1 unresolvable (deleted between launch and eval, unreadable
    // package.json) — the raw comparison above was the last word.
    return false;
  }
}
