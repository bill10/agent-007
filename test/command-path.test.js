import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveExecutable, isUsableCwd } from '../server/command-path.js';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// CreateProcessW only ever appends `.exe`, so a command installed as a `.cmd`
// shim (`claude`, `aider`, anything from npm) has to be resolved to its real
// filename before node-pty sees it. Getting this wrong crashes the whole
// server asynchronously, so the resolution rules get covered directly.
describe('resolveExecutable on Windows', () => {
  let base, binDir, otherDir;
  const env = () => ({
    PATH: [binDir, otherDir].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  });

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'a007-cmdpath-')));
    binDir = join(base, 'bin');
    otherDir = join(base, 'other');
    mkdirSync(binDir);
    mkdirSync(otherDir);
    // The npm shape: an extensionless bash shim next to the launchable .cmd.
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\n');
    writeFileSync(join(binDir, 'claude.cmd'), '@echo off\n');
    writeFileSync(join(otherDir, 'tool.exe'), 'MZ');
    writeFileSync(join(otherDir, 'claude.cmd'), '@echo off\n');
  });
  afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const resolve = (file, cwd = base) => resolveExecutable(file, env(), 'win32', cwd);

  it('skips the extensionless shim for the .cmd CreateProcessW can launch', () => {
    // The original bug: node-pty found the shim, Windows then looked for
    // claude.exe and failed with error code 2.
    expect(resolve('claude')).toBe(join(binDir, 'claude.cmd'));
  });

  it('finds an .exe further down PATH', () => {
    expect(resolve('tool')).toBe(join(otherDir, 'tool.exe'));
  });

  it('takes the first PATH entry that matches', () => {
    expect(resolve('claude')).toBe(join(binDir, 'claude.cmd'));
  });

  it('honours PATHEXT order within a directory', () => {
    writeFileSync(join(binDir, 'dual.cmd'), '@echo off\n');
    writeFileSync(join(binDir, 'dual.exe'), 'MZ');
    expect(resolve('dual')).toBe(join(binDir, 'dual.exe'));
  });

  it('uses a command that already carries a launchable extension verbatim', () => {
    expect(resolve('claude.cmd')).toBe(join(binDir, 'claude.cmd'));
  });

  it('resolves an absolute path without consulting PATH', () => {
    expect(resolve(join(otherDir, 'tool'))).toBe(join(otherDir, 'tool.exe'));
    expect(resolve(join(otherDir, 'tool.exe'))).toBe(join(otherDir, 'tool.exe'));
  });

  it('does not fall back to PATH for a path-shaped command', () => {
    expect(resolve(join(otherDir, 'dual'))).toBe(null);
  });

  it('returns null when nothing matches, so the caller keeps the bare name', () => {
    expect(resolve('definitely-not-installed')).toBe(null);
  });

  it('leaves non-Windows platforms to execvp', () => {
    expect(resolveExecutable('claude', env(), 'linux', base)).toBe(null);
    expect(resolveExecutable('claude', env(), 'darwin', base)).toBe(null);
  });

  it('handles an empty command', () => {
    expect(resolveExecutable('', env(), 'win32', base)).toBe(null);
  });
});

describe('isUsableCwd', () => {
  let base;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'a007-cwd-')));
    writeFileSync(join(base, 'file.txt'), 'x');
  });
  afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  it('accepts an existing directory', () => {
    expect(isUsableCwd(base)).toBe(true);
  });

  // A deleted worktree is the re-spawn failure: CreateProcessW rejects it with
  // error code 267 from the console host, far too late for a try/catch.
  it('rejects a missing directory', () => {
    expect(isUsableCwd(join(base, 'gone'))).toBe(false);
  });

  it('rejects a file and a blank path', () => {
    expect(isUsableCwd(join(base, 'file.txt'))).toBe(false);
    expect(isUsableCwd('')).toBe(false);
    expect(isUsableCwd(null)).toBe(false);
  });
});
