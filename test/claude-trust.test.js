// Pre-seeding Claude Code's workspace trust for board workers (server/claude-trust.js).
// Every test runs against a temp HOME: the real ~/.claude.json is never touched.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync, symlinkSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { autoTrusts, trustClaudeFolder } from '../server/claude-trust.js';

let home, file, wt;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-trust-')));
  file = join(home, '.claude.json');
  wt = join(home, 'worktrees', 'Falcon');
  mkdirSync(wt, { recursive: true });
});

describe('trustClaudeFolder', () => {
  it('adds only the one entry and keeps everything else, key order and mode included', () => {
    const before = {
      numStartups: 9, theme: 'light',
      projects: { '/elsewhere': { hasTrustDialogAccepted: false, allowedTools: ['Bash'] } },
      userID: 'u1',
    };
    writeFileSync(file, JSON.stringify(before, null, 2), { mode: 0o600 });
    expect(trustClaudeFolder(wt, { home, env: {} })).toBe(true);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after).toEqual({ ...before, projects: { ...before.projects, [wt]: { hasTrustDialogAccepted: true } } });
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('keeps the fields of an entry that already exists for the path', () => {
    writeFileSync(file, JSON.stringify({ projects: { [wt]: { allowedTools: ['Read'] } } }));
    trustClaudeFolder(wt, { home, env: {} });
    expect(JSON.parse(readFileSync(file, 'utf8')).projects[wt]).toEqual({ allowedTools: ['Read'], hasTrustDialogAccepted: true });
  });

  it('records the real path, as claude sees its cwd', () => {
    writeFileSync(file, '{}');
    trustClaudeFolder(join(wt, '..', 'Falcon'), { home, env: {} });
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).projects)).toEqual([wt]);
  });

  it('does not rewrite a file that already trusts the path', () => {
    const text = JSON.stringify({ projects: { [wt]: { hasTrustDialogAccepted: true } } });
    writeFileSync(file, text);
    expect(trustClaudeFolder(wt, { home, env: {} })).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('leaves a malformed file exactly as it was', () => {
    for (const text of ['{"projects": {', '[1,2]', 'null', '{"projects": [1]}', '{"projects": "x"}', `{"projects": {${JSON.stringify(wt)}: "x"}}`]) {
      writeFileSync(file, text);
      expect(trustClaudeFolder(wt, { home, env: {} })).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('writes through a symlinked file and leaves the link in place', () => {
    const real = join(home, 'dotfiles.json');
    writeFileSync(real, '{"theme":"dark"}');
    symlinkSync(real, file);
    expect(trustClaudeFolder(wt, { home, env: {} })).toBe(true);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ theme: 'dark', projects: { [wt]: { hasTrustDialogAccepted: true } } });
  });

  it('uses CLAUDE_CONFIG_DIR when set, as claude does', () => {
    const dir = join(home, 'profile');
    mkdirSync(dir);
    writeFileSync(join(dir, '.claude.json'), '{}');
    writeFileSync(file, '{}');
    expect(trustClaudeFolder(wt, { home, env: { CLAUDE_CONFIG_DIR: dir } })).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')).projects[wt]).toEqual({ hasTrustDialogAccepted: true });
    expect(readFileSync(file, 'utf8')).toBe('{}');
  });

  it('replaces a temp file left by a crash instead of writing through it', () => {
    writeFileSync(file, '{}', { mode: 0o600 });
    const stale = `${file}.agent007-${process.pid}.tmp`;
    writeFileSync(stale, 'junk', { mode: 0o644 });
    expect(trustClaudeFolder(wt, { home, env: {} })).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('does not create the file when claude has none', () => {
    expect(trustClaudeFolder(wt, { home, env: {} })).toBe(false);
    expect(readdirSync(home)).toEqual(['worktrees']);
  });
});

describe('autoTrusts', () => {
  const board = { spawnedBy: 'board', worktreePath: '/wt', command: "claude --permission-mode auto 'do it'" };
  it('covers board-dispatched Claude Code workers by default', () => {
    expect(autoTrusts(board, {})).toBe(true);
  });
  it('is off when TRUST_BOARD_WORKTREES opts out', () => {
    for (const v of ['0', 'false', 'OFF', 'no', ' 0 ']) expect(autoTrusts(board, { TRUST_BOARD_WORKTREES: v })).toBe(false);
    expect(autoTrusts(board, { TRUST_BOARD_WORKTREES: '1' })).toBe(true);
  });
  it('leaves hand-started agents, other CLIs and repo-less sessions alone', () => {
    expect(autoTrusts({ ...board, spawnedBy: 'user' }, {})).toBe(false);
    expect(autoTrusts({ ...board, command: 'codex exec hi' }, {})).toBe(false);
    expect(autoTrusts({ ...board, worktreePath: null }, {})).toBe(false);
  });
});
