import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  billionEnabled, billionDir, ensureBillionRepo, refreshCharter, suggestProjectsDir, billionCommand, trustDialogKey,
} from '../server/billion.js';
import { CONFIG_DIR } from '../server/state.js';
import { parseCommand } from '../lib/helpers.js';
import { hasClaudeTranscript } from '../server/agent-transcripts.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'a007-billion-')), 'billion');
const log = (dir) => execFileSync('git', ['log', '--format=%s'], { cwd: dir }).toString().trim().split('\n');

describe('billionEnabled', () => {
  it('is on unless turned off', () => {
    expect(billionEnabled({})).toBe(true);
    expect(billionEnabled({ BILLION: '1' })).toBe(true);
    expect(billionEnabled({ BILLION: 'yes' })).toBe(true);
    for (const off of ['0', 'false', 'OFF', ' no ']) expect(billionEnabled({ BILLION: off })).toBe(false);
  });
});

describe('billionDir', () => {
  it('lives under the config dir unless BILLION_DIR says otherwise', () => {
    expect(billionDir({})).toBe(join(CONFIG_DIR, 'billion'));
    expect(billionDir({ BILLION_DIR: '/tmp/somewhere/b' })).toMatch(/somewhere[\\/]b$/);
  });
});

describe('ensureBillionRepo', () => {
  it('creates a committed repo from the templates on the first run', () => {
    const dir = fresh();
    expect(ensureBillionRepo(dir)).toEqual({ created: true });
    // Exactly these names: listed rather than probed, since macOS matches
    // charter.md to CHARTER.md. The template names must not come along.
    expect(readdirSync(dir).filter(f => f !== '.git').sort()).toEqual(['CHARTER.md', 'CLAUDE.md', 'COMPANY.md', 'STATE.md']);
    expect(readFileSync(join(dir, 'CHARTER.md'), 'utf8')).toMatch(/You are \*\*Billion\*\*/);
    // CLAUDE.md is the owner's, and pulls the charter in.
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toMatch(/^@CHARTER\.md$/m);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toMatch(/## Owner's rules/);
    expect(readFileSync(join(dir, 'STATE.md'), 'utf8')).toMatch(/^Status: not started$/m);
    expect(log(dir)).toEqual(['Billion: first run']);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()).toBe('');
  });

  it('leaves an existing repo exactly as it is', () => {
    const dir = fresh();
    ensureBillionRepo(dir);
    writeFileSync(join(dir, 'STATE.md'), 'Status: running\n');
    expect(ensureBillionRepo(dir)).toEqual({ created: false });
    expect(readFileSync(join(dir, 'STATE.md'), 'utf8')).toBe('Status: running\n');
    expect(log(dir)).toEqual(['Billion: first run']);
  });

  it('sets up a folder holding only what an OS leaves behind', () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.DS_Store'), '');
    expect(ensureBillionRepo(dir)).toEqual({ created: true });
  });

  it('keeps files already in a folder that is not a repo yet', () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'COMPANY.md'), '# Mine\n');
    expect(ensureBillionRepo(dir)).toEqual({ created: true });
    expect(readFileSync(join(dir, 'COMPANY.md'), 'utf8')).toBe('# Mine\n');
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
  });
});

describe('refreshCharter', () => {
  it('brings an older charter up to date in a commit of its own, leaving the owner\'s files alone', () => {
    const dir = fresh();
    ensureBillionRepo(dir);
    writeFileSync(join(dir, 'CHARTER.md'), 'an older charter\n');
    writeFileSync(join(dir, 'CLAUDE.md'), '@CHARTER.md\n\n## Owner\'s rules\n- New repos go in ~/Code\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'older'], { cwd: dir });
    writeFileSync(join(dir, 'STATE.md'), 'Status: mid-cycle, not committed\n');

    expect(refreshCharter(dir)).toBe(true);
    expect(readFileSync(join(dir, 'CHARTER.md'), 'utf8')).toMatch(/You are \*\*Billion\*\*/);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toMatch(/~\/Code/);
    expect(log(dir)[0]).toBe('Agent 007: update the charter');
    // Billion's own uncommitted work is not swept into that commit.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()).toBe(' M STATE.md\n');
  });

  it('does nothing when the charter is current', () => {
    const dir = fresh();
    ensureBillionRepo(dir);
    expect(refreshCharter(dir)).toBe(false);
    expect(log(dir)).toEqual(['Billion: first run']);
  });
});

describe('suggestProjectsDir', () => {
  it('picks the folder holding most repos, not their common prefix', () => {
    // resolve(), like the code: on Windows it puts a drive in front.
    expect(suggestProjectsDir(['/u/Projects/a', '/u/Projects/b', '/u/elsewhere/c'])).toBe(resolve('/u/Projects'));
  });

  it('ignores repos inside Agent 007\'s own folder', () => {
    const own = join(CONFIG_DIR, 'worktrees', 'x');
    expect(suggestProjectsDir([own, join(own, '..', 'y')])).toBeNull();
    expect(suggestProjectsDir([own, '/u/Projects/a'])).toBe(resolve('/u/Projects'));
  });

  it('has nothing to suggest with no repos', () => {
    expect(suggestProjectsDir([])).toBeNull();
  });
});

describe('billionCommand', () => {
  const dir = '/home/me/.agent-007/billion';
  const promptOf = (cmd) => parseCommand(cmd).args.at(-1);

  it('introduces itself on a fresh repo, never continuing', () => {
    const cmd = billionCommand({ created: true, hasConversation: true, dir, projectsHint: '/home/me/Projects' });
    const { file, args } = parseCommand(cmd);
    expect(file).toBe('claude');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--continue');
    expect(promptOf(cmd)).toMatch(/first run/i);
    expect(promptOf(cmd)).toContain('Suggest /home/me/Projects');
    expect(promptOf(cmd)).toContain(dir);
  });

  it('continues the last conversation after a restart', () => {
    const cmd = billionCommand({ created: false, hasConversation: true, dir, projectsHint: null });
    expect(parseCommand(cmd).args).toContain('--continue');
    // A restart can land mid-introduction, so the prompt covers both.
    expect(promptOf(cmd)).toMatch(/not started/);
    expect(promptOf(cmd)).toMatch(/operating loop/);
    expect(promptOf(cmd)).toMatch(/without suggesting/);
  });

  it('starts cleanly when there is no conversation to continue', () => {
    const cmd = billionCommand({ created: false, hasConversation: false, dir, projectsHint: null });
    expect(parseCommand(cmd).args).not.toContain('--continue');
  });

  it('keeps a folder with quotes and spaces intact through parseCommand', () => {
    const odd = '/Users/a "b"\\c/billion';
    expect(promptOf(billionCommand({ created: true, hasConversation: false, dir: odd, projectsHint: null }))).toContain(odd);
  });
});

describe('trustDialogKey', () => {
  // As Claude Code 2.1 draws it, stripped: cursor moves stand in for spaces.
  const dialog = (selected) => [
    'Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?',
    selected === 'no' ? '❯No,exit' : ' No, exit',
    selected === 'yes' ? '❯ Yes, I trust this folder' : 'Yes,Itrustthisfolder',
    'Entertoconfirm·Esctocancel',
  ].join('\n');

  it('moves off "No, exit", then confirms "Yes"', () => {
    expect(trustDialogKey(dialog('no'))).toBe('\x1b[B');
    expect(trustDialogKey(dialog('yes'))).toBe('\r');
  });

  it('follows the last cursor drawn when an older drawing is still in the text', () => {
    expect(trustDialogKey(dialog('no') + '\n No, exit❯Yes, I trust this folder')).toBe('\r');
    expect(trustDialogKey(dialog('yes') + '\n❯No, exit Yes, I trust this folder')).toBe('\x1b[B');
  });

  it('leaves anything else alone', () => {
    expect(trustDialogKey('❯ No, exit')).toBeNull();          // some other "No, exit" menu
    expect(trustDialogKey('> Try "fix the tests"')).toBeNull();
    expect(trustDialogKey('')).toBeNull();
  });
});

describe('hasClaudeTranscript', () => {
  it('finds a conversation Claude Code left in exactly that folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'a007-claude-home-'));
    const dir = '/tmp/some folder/billion';
    expect(hasClaudeTranscript(dir, { claude: home })).toBe(false);
    const project = join(home, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'x.jsonl'), '{}\n');
    expect(hasClaudeTranscript(dir, { claude: home })).toBe(true);
    expect(hasClaudeTranscript('/tmp/elsewhere', { claude: home })).toBe(false);
    expect(hasClaudeTranscript('', { claude: home })).toBe(false);
  });
});
