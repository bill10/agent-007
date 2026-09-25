// CLAUDE_PERMISSION_MODE / CODEX_PERMISSION_MODE: the mode every agent the app
// starts runs in unless something more specific decides. What may override
// it, what it may never override, and that the flags land in the command so
// every reader of a session's mode sees them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// createSession's spawn, replaced: what matters is the command it is handed.
const spawned = [];
vi.mock('../server/pty.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createSessionFromConfig: vi.fn((cfg) => {
    spawned.push(cfg);
    return { session: { id: cfg.sessionId, name: cfg.name, command: cfg.command, pty: { cols: 80, rows: 24 } } };
  }),
}));

const { createSession, sessions } = await import('../server.js');
const { config } = await import('../server/state.js');
const { dispatchOnce, addJob, boardSettings, updateSettings, boardModeFor, orphanResumePlan } = await import('../server/jobs.js');
const { envPermissionMode, permissionModeFlags, withDefaultPermission, permissionFlagsFromCommand } = await import('../lib/jobs.js');
const { parseCommand } = await import('../lib/helpers.js');

const env = { CLAUDE_PERMISSION_MODE: 'bypassPermissions', CODEX_PERMISSION_MODE: 'bypassPermissions' };
const saved = { claude: process.env.CLAUDE_PERMISSION_MODE, codex: process.env.CODEX_PERMISSION_MODE };
afterEach(() => {
  for (const [agent, key] of [['claude', 'CLAUDE_PERMISSION_MODE'], ['codex', 'CODEX_PERMISSION_MODE']]) {
    if (saved[agent] === undefined) delete process.env[key]; else process.env[key] = saved[agent];
  }
  spawned.length = 0;
  sessions.clear();
});

describe('the .env setting', () => {
  it('takes a known mode per CLI, and nothing else', () => {
    expect(envPermissionMode('claude', { CLAUDE_PERMISSION_MODE: ' plan ' })).toBe('plan');
    expect(envPermissionMode('codex', { CODEX_PERMISSION_MODE: 'dontAsk' })).toBe('dontAsk');
    expect(envPermissionMode('claude', { CLAUDE_PERMISSION_MODE: 'yolo' })).toBeNull();
    expect(envPermissionMode('claude', {})).toBeNull();
    expect(envPermissionMode('claude', { CODEX_PERMISSION_MODE: 'plan' })).toBeNull();   // each CLI its own
    expect(envPermissionMode('gemini', { CLAUDE_PERMISSION_MODE: 'plan' })).toBeNull();
    expect(envPermissionMode('constructor', {})).toBeNull();
  });

  it('becomes each CLI\'s own flags', () => {
    expect(permissionModeFlags('claude', 'bypassPermissions')).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(permissionModeFlags('codex', 'bypassPermissions')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(permissionModeFlags('codex', 'manual')).toEqual(['--ask-for-approval', 'on-request', '--sandbox', 'read-only']);
    expect(permissionModeFlags('codex', 'auto')).toEqual([]);
  });
});

describe('a command someone starts', () => {
  it('gets its CLI\'s default, right after the executable', () => {
    expect(withDefaultPermission('claude', env)).toBe('claude --permission-mode bypassPermissions');
    expect(withDefaultPermission('codex "fix it"', env)).toBe('codex --dangerously-bypass-approvals-and-sandbox "fix it"');
    expect(withDefaultPermission('/opt/homebrew/bin/claude --model opus', env))
      .toBe('/opt/homebrew/bin/claude --permission-mode bypassPermissions --model opus');
  });

  it('keeps a quoted executable path and its arguments intact', () => {
    const cmd = withDefaultPermission('"/Program Files/claude" --model "opus 4"', env);
    expect(parseCommand(cmd)).toEqual({ file: '/Program Files/claude', args: ['--permission-mode', 'bypassPermissions', '--model', 'opus 4'] });
  });

  it('leaves a command that already says how it asks exactly as typed', () => {
    // Values the allowlist doesn't know included: they are still the person's choice.
    for (const cmd of ['claude --dangerously-skip-permissions', 'claude --permission-mode plan', 'codex -s read-only', 'codex --yolo',
      'claude --permission-mode default', 'claude --permission-mode=default', 'codex -a untrusted', 'codex -auntrusted', 'codex --ask-for-approval=on-failure',
      // Codex's config overrides and profiles can set permissions the allowlist cannot see.
      'codex -c sandbox_mode=read-only', 'codex -csandbox_mode=read-only', 'codex --config=x', 'codex -p locked', 'codex -plocked', 'codex --profile=locked', 'codex --full-auto']) {
      expect(withDefaultPermission(cmd, env)).toBe(cmd);
    }
  });

  it('leaves everything else alone: other CLIs, a mode with no flags, no setting', () => {
    expect(withDefaultPermission('gemini', env)).toBe('gemini');
    expect(withDefaultPermission('bash', env)).toBe('bash');
    expect(withDefaultPermission('codex', { CODEX_PERMISSION_MODE: 'auto' })).toBe('codex');
    expect(withDefaultPermission('claude', {})).toBe('claude');
  });

  it('is what createSession spawns, for a person\'s agent but never a board worker\'s', async () => {
    Object.assign(process.env, env);
    await createSession('claude', null, null, null, null, {});
    expect(spawned[0].command).toBe('claude --permission-mode bypassPermissions');
    // The mode is in the command, where the messaging rule reads it.
    expect(permissionFlagsFromCommand(spawned[0].command)).toEqual(['--permission-mode', 'bypassPermissions']);
    await createSession('codex --sandbox read-only "x"', null, null, null, null, { spawnedBy: 'board' });
    expect(spawned[1].command).toBe('codex --sandbox read-only "x"');
  });
});

describe('the job board', () => {
  const REPO = mkdtempSync(join(tmpdir(), 'a007-permdef-'));
  beforeEach(() => {
    config.repos = [{ path: REPO }];
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
  });

  it('uses each CLI\'s default until a mode is picked in its dropdown', () => {
    process.env.CLAUDE_PERMISSION_MODE = 'plan';
    process.env.CODEX_PERMISSION_MODE = 'bypassPermissions';
    expect(boardModeFor('claude')).toBe('plan');
    expect(boardModeFor('codex')).toBe('bypassPermissions');
    updateSettings({ permissionMode: 'manual' }, () => {});
    expect(boardModeFor('claude')).toBe('manual');
    expect(boardModeFor('codex')).toBe('manual');
  });

  it('dispatches a card on each CLI with that CLI\'s default, and a card\'s own mode still wins', async () => {
    process.env.CLAUDE_PERMISSION_MODE = 'plan';
    process.env.CODEX_PERMISSION_MODE = 'bypassPermissions';
    const repos = [1, 2, 3].map(() => mkdtempSync(join(tmpdir(), 'a007-permdef-r-')));
    config.repos = repos.map(path => ({ path }));
    addJob({ title: 'Claude card', repoPath: repos[0], agent: 'claude' }, () => {});
    addJob({ title: 'Codex card', repoPath: repos[1], agent: 'codex' }, () => {});
    addJob({ title: 'Own mode', repoPath: repos[2], agent: 'codex', permissionMode: 'plan' }, () => {});
    const commands = {};
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      commands[repoPath] = command;
      return { session: { id: `s-${repoPath}`, name: 'W', repoPath, branchName: branch, state: 'WORKING', exited: false, jobId: meta.jobId } };
    }, () => {});
    expect(commands[repos[0]]).toMatch(/^claude --permission-mode plan /);
    expect(commands[repos[1]]).toMatch(/^codex --dangerously-bypass-approvals-and-sandbox /);
    expect(commands[repos[2]]).toMatch(/^codex --sandbox read-only /);
  });
});

describe('re-spawning an agent someone started', () => {
  it('uses the flags it ran with, and never the default in place of ones it did not record', () => {
    process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
    const base = { name: 'Old', repoPath: '/nowhere', branchName: 'x', worktreePath: '/nowhere/x', agent: 'claude', origin: 'user' };
    // Started as `claude --permission-mode default`: recorded nothing (the
    // allowlist doesn't read `default`), and must not come back in bypass.
    expect(orphanResumePlan({ ...base, permissionFlags: [] }).flags).toEqual([]);
    expect(orphanResumePlan({ ...base, permissionFlags: ['--permission-mode', 'plan'] }).flags).toEqual(['--permission-mode', 'plan']);
  });
});

describe('edges of the default', () => {
  it('reads a flag-shaped prompt after `--` as the prompt, and still adds the default', () => {
    const cmd = withDefaultPermission('claude -- --dangerously-skip-permissions', env);
    expect(cmd).toBe('claude --permission-mode bypassPermissions -- --dangerously-skip-permissions');
    expect(permissionFlagsFromCommand(cmd)).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  it('rebuilds a quoted codex path, and leaves one alone when the mode has no flags', () => {
    const cmd = withDefaultPermission('"/my tools/codex" "fix it"', env);
    expect(parseCommand(cmd)).toEqual({ file: '/my tools/codex', args: ['--dangerously-bypass-approvals-and-sandbox', 'fix it'] });
    expect(withDefaultPermission('"/my tools/codex" "fix it"', { CODEX_PERMISSION_MODE: 'acceptEdits' })).toBe('"/my tools/codex" "fix it"');
  });

  it('has no flags for a CLI it does not know, or a mode that is not one', () => {
    expect(permissionModeFlags('gemini', 'plan')).toEqual([]);
    expect(permissionModeFlags('claude', 'yolo')).toEqual([]);
  });

  it('spawns a person\'s agent unchanged when the .env value is not a mode', async () => {
    process.env.CLAUDE_PERMISSION_MODE = 'yolo';
    await createSession('claude', null, null, null, null, {});
    expect(spawned[0].command).toBe('claude');
  });
});

describe('re-spawning a board agent', () => {
  const REPO = mkdtempSync(join(tmpdir(), 'a007-permdef-o-'));
  beforeEach(() => {
    config.repos = [{ path: REPO }];
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
  });
  const base = { name: 'Old', repoPath: REPO, branchName: 'b1', worktreePath: '/nowhere/b1', agent: 'codex' };

  it('with its card gone, resumes in the CLI\'s .env mode, not with the default as extra flags', () => {
    process.env.CODEX_PERMISSION_MODE = 'plan';
    const plan = orphanResumePlan({ ...base, origin: 'board', permissionFlags: [] });
    expect(plan.mode).toBe('plan');
    expect(plan.flags).toEqual([]);
  });

  it('with its card, resumes in the card\'s CLI .env mode until the board picks one', () => {
    process.env.CODEX_PERMISSION_MODE = 'bypassPermissions';
    const { job } = addJob({ title: 'Card', repoPath: REPO, agent: 'codex' }, () => {});
    Object.assign(job, { state: 'in-progress', branchName: 'b1' });
    expect(orphanResumePlan({ ...base, origin: 'board' }).mode).toBe('bypassPermissions');
    updateSettings({ permissionMode: 'manual' }, () => {});
    expect(orphanResumePlan({ ...base, origin: 'board' }).mode).toBe('manual');
  });

  it('a hand-spawned one with no flags and no .env default resumes with none', () => {
    delete process.env.CLAUDE_PERMISSION_MODE;
    expect(orphanResumePlan({ ...base, agent: 'claude', origin: 'user', branchName: 'nomatch' }).flags).toEqual([]);
  });
});

describe('the .env default changing while a card spawns', () => {
  const REPO = mkdtempSync(join(tmpdir(), 'a007-permdef-race-'));
  beforeEach(() => {
    config.repos = [{ path: REPO }];
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
  });

  it('abandons the spawn, as a board retune would', async () => {
    process.env.CLAUDE_PERMISSION_MODE = 'plan';
    addJob({ title: 'Racing', repoPath: REPO, agent: 'claude' }, () => {});
    const killed = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
      const session = { id: 's-race', name: 'W', command, repoPath, branchName: branch, state: 'WORKING', exited: false, jobId: meta.jobId };
      sessions.set(session.id, session);
      return { session };
    }, () => {}, { killSession: async (id) => { killed.push(id); } });
    expect(killed).toEqual(['s-race']);
    expect(config.jobs[0].state).toBe('todo');
  });
});
