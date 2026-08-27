import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isDirectRun } from '../server/direct-run.js';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

// isDirectRun decides whether server.js was the process entry point. Its
// failure mode is a silent exit 0 (the "npm start does nothing" bug), so every
// launch shape gets a test: plain paths, percent-encoded paths (spaces),
// symlinked ancestors, and `node .`. importMetaUrl is simulated the way Node
// builds it for the main module: pathToFileURL of the entry file's realpath.
describe('isDirectRun entry-point detection', () => {
  let base, spacedDir, entry;
  beforeAll(() => {
    // mkdtempSync gives a realpathed base, so fixtures below are symlink-free
    // except where a test creates one on purpose.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'a007-direct-')));
    spacedDir = join(base, 'dir with space');
    mkdirSync(spacedDir);
    entry = join(spacedDir, 'server.js');
    writeFileSync(entry, '// entry fixture');
  });
  afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const urlOf = (p) => pathToFileURL(realpathSync(p)).href;

  it('is false without argv[1] (embedding, node -e)', () => {
    expect(isDirectRun('file:///x/server.js', undefined)).toBe(false);
    expect(isDirectRun('file:///x/server.js', '')).toBe(false);
  });

  it('matches a plain direct run', () => {
    expect(isDirectRun(urlOf(entry), entry)).toBe(true);
  });

  it('matches when the install path contains a space (the original bug)', () => {
    // Sanity-check the fixture actually exercises percent-encoding, then the
    // old endsWith-style comparison's failure shape: %20 vs literal space.
    expect(urlOf(entry)).toContain('%20');
    expect(urlOf(entry).endsWith(entry.replace(/\\/g, '/'))).toBe(false);
    expect(isDirectRun(urlOf(entry), entry)).toBe(true);
  });

  it('matches a launch through a symlinked directory', () => {
    const link = join(base, 'link');
    try {
      // 'junction' works unprivileged on Windows and is ignored elsewhere.
      symlinkSync(spacedDir, link, 'junction');
    } catch {
      return; // symlinks unavailable in this environment — nothing to test
    }
    const typedPath = join(link, 'server.js');
    expect(typedPath).not.toBe(entry);
    // import.meta.url carries the realpath; argv[1] carries the typed path.
    expect(isDirectRun(urlOf(entry), typedPath)).toBe(true);
  });

  it('matches --preserve-symlinks-main, where import.meta.url keeps the typed path', () => {
    const link = join(base, 'link-preserve');
    try {
      symlinkSync(spacedDir, link, 'junction');
    } catch {
      return;
    }
    const typedPath = join(link, 'server.js');
    expect(isDirectRun(pathToFileURL(typedPath).href, typedPath)).toBe(true);
  });

  it('matches `node .` via package.json main', () => {
    writeFileSync(join(spacedDir, 'package.json'), JSON.stringify({ main: 'server.js' }));
    expect(isDirectRun(urlOf(entry), spacedDir)).toBe(true);
  });

  it('is false for `node .` when main points at a different file', () => {
    const other = join(spacedDir, 'other.js');
    writeFileSync(other, '// other entry');
    writeFileSync(join(spacedDir, 'package.json'), JSON.stringify({ main: 'other.js' }));
    // other.js is the entry; server.js is merely imported by it.
    expect(isDirectRun(urlOf(entry), spacedDir)).toBe(false);
  });

  it('is false when argv[1] is a different file (test runner import)', () => {
    const runner = join(base, 'vitest.mjs');
    writeFileSync(runner, '// fake runner');
    expect(isDirectRun(urlOf(entry), runner)).toBe(false);
  });

  it('is false when argv[1] no longer exists', () => {
    expect(isDirectRun(urlOf(entry), join(base, 'gone.js'))).toBe(false);
  });

  it('fixture filename mirrors the real entry point', () => {
    // The guard's stderr warning keys off basename equality with server.js;
    // keep the fixture honest so these tests model the real launch.
    expect(basename(entry)).toBe('server.js');
  });
});
