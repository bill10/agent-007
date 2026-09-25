import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveExecutable, isUsableCwd, commandExists, missingCommandMessage } from '../server/command-path.js';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { join, delimiter } from 'path';
import { tmpdir } from 'os';

// CreateProcessW only ever appends `.exe`, so a command installed as a `.cmd`
// shim (`claude`, `aider`, anything from npm) has to be resolved to its real
// filename before node-pty sees it. Getting this wrong crashes the whole
// server asynchronously, so the resolution rules get covered directly.
//
// These run on the Linux CI runner too, with platform forced to 'win32' — the
// reason resolveExecutable reads Windows' `;` PATH separator from a constant
// instead of from `path.delimiter`.
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
    // Same basename in both PATH entries, to pin the search order.
    writeFileSync(join(otherDir, 'claude.cmd'), '@echo off\n');
    writeFileSync(join(otherDir, 'tool.exe'), 'MZ');
    // Both extensions in one directory, to pin the PATHEXT order.
    writeFileSync(join(binDir, 'dual.cmd'), '@echo off\n');
    writeFileSync(join(binDir, 'dual.exe'), 'MZ');
    // Sitting in the working directory, where nothing should look.
    writeFileSync(join(base, 'hijack.cmd'), '@echo off\n');
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

  it('honours PATHEXT order within a directory', () => {
    expect(resolve('dual')).toBe(join(binDir, 'dual.exe'));
  });

  it('never searches the working directory, so a repo cannot hijack the command', () => {
    // cwd is the agent's worktree. cmd.exe would run ./hijack.cmd here;
    // child_process and PowerShell would not, and neither do we.
    expect(resolve('hijack')).toBe(null);
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

// A missing CLI must be caught before the spawn: on macOS and Linux node-pty
// "starts" it and the tab is an empty, dead terminal.
describe('commandExists', () => {
  let bin;
  beforeAll(() => {
    bin = realpathSync(mkdtempSync(join(tmpdir(), 'a007-cmdexists-')));
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(bin, 'notes'), 'not a program', { mode: 0o644 });
    mkdirSync(join(bin, 'codex'));
  });
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  it.skipIf(process.platform === 'win32')('finds an executable on PATH, and nothing else', () => {
    const env = { PATH: ['/no/such/dir', bin].join(delimiter) };
    expect(commandExists('claude', env, 'linux')).toBe(true);
    expect(commandExists('gemini', env, 'linux')).toBe(false);
    expect(commandExists('notes', env, 'linux')).toBe(false);   // not executable
    expect(commandExists('codex', env, 'linux')).toBe(false);   // a directory
    expect(commandExists('claude', {}, 'linux')).toBe(false);   // no PATH at all
    expect(commandExists('', env, 'linux')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('takes a path as a path, relative to the working directory', () => {
    expect(commandExists(join(bin, 'claude'), {}, 'linux')).toBe(true);
    expect(commandExists('./claude', {}, 'linux', bin)).toBe(true);
    expect(commandExists('./gemini', {}, 'linux', bin)).toBe(false);
  });

  it('uses the Windows lookup on Windows', () => {
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\n');
    expect(commandExists('codex', { PATH: bin, PATHEXT: '.CMD' }, 'win32')).toBe(true);
    expect(commandExists('claude', { PATH: bin, PATHEXT: '.CMD' }, 'win32')).toBe(false);
  });

  it('says how to install the CLIs it knows', () => {
    expect(missingCommandMessage('claude')).toMatch(/"claude" is not installed.*Install Claude Code/);
    expect(missingCommandMessage('codex')).toMatch(/npm install -g @openai\/codex/);
    expect(missingCommandMessage('aider')).toBe('"aider" is not installed, or not on the PATH Agent 007 was started with.');
  });
});
