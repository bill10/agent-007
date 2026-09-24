import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveActiveSession, recoverCrashedSessions, sessionAgent, sessionPermissionFlags, sessionOrigin } from '../server/config.js';
import { config, orphans } from '../server/state.js';
import { CONFIG_PATH, CONFIG_DIR } from '../server/state.js';

// loadConfig reads CONFIG_PATH, which test/setup.js has already redirected to a
// throwaway directory via AGENT007_CONFIG_DIR.
function writeConfig(jobs) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({
    version: 1, repos: [], orphans: [], activeSessions: [], jobs,
  }));
}

afterEach(() => {
  try { rmSync(CONFIG_PATH); } catch {}
});

describe('restart recovery for in-flight jobs', () => {
  it('keeps a job that already has a branch in in-progress', () => {
    // The agent may have pushed and opened the PR before the server died.
    // Sending it back to To do would dispatch a second agent onto a `-2`
    // branch to redo work that is already up for review, and open a duplicate
    // PR. checkPullRequests can still resolve it from the branch alone.
    writeConfig([{
      id: 'j1', title: 'shipped it', repoPath: '/r', state: 'in-progress',
      agentSessionId: 'session-9', agentName: 'Viper',
      branchName: 'bill/add-thing', startedAt: '2026-08-27T00:00:00Z',
    }]);
    loadConfig();
    const job = config.jobs[0];
    expect(job.state).toBe('in-progress');
    expect(job.branchName).toBe('bill/add-thing');
    // The dead session link must go, or the cap would count a PTY that is gone.
    expect(job.agentSessionId).toBeNull();
    // The NAME is history — "Viper did this work" stays true across a restart,
    // and it is the credit the card exists to show. Only the session link,
    // which cannot survive the process, is dropped.
    expect(job.agentName).toBe('Viper');
    expect(job.startedAt).toBe('2026-08-27T00:00:00Z');
    expect(job.lastError).toMatch(/bill\/add-thing/);
  });

  // Nothing watches a no-PR card, so its note must not say the board is.
  it('points a no-PR job at re-adopting its agent, not at a PR watch', () => {
    writeConfig([{
      id: 'j1', title: 'research', repoPath: '/r', state: 'in-progress', requiresPr: false,
      agentSessionId: 'session-9', agentName: 'Viper', branchName: 'bill/research',
    }]);
    loadConfig();
    expect(config.jobs[0].lastError).toMatch(/re-adopt/);
    expect(config.jobs[0].lastError).not.toMatch(/watching for its PR/);
  });

  it('requeues a job that never got as far as a branch', () => {
    writeConfig([{
      id: 'j2', title: 'never started', repoPath: '/r', state: 'in-progress',
      agentSessionId: 'session-1', agentName: 'Apex', branchName: null,
      startedAt: '2026-08-27T00:00:00Z',
    }]);
    loadConfig();
    const job = config.jobs[0];
    expect(job.state).toBe('todo');
    expect(job.agentSessionId).toBeNull();
    expect(job.startedAt).toBeNull();
  });

  it('leaves todo and review jobs alone', () => {
    writeConfig([
      { id: 'a', title: 'queued', repoPath: '/r', state: 'todo' },
      { id: 'b', title: 'done', repoPath: '/r', state: 'review', prNumber: 3, branchName: 'bill/x' },
    ]);
    loadConfig();
    expect(config.jobs.map(j => j.state)).toEqual(['todo', 'review']);
    expect(config.jobs[1].prNumber).toBe(3);
  });

  it('survives a config with no jobs key at all', () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ version: 1, repos: [] }));
    loadConfig();
    expect(config.jobs).toEqual([]);
  });
});

describe('restart recovery for a running agent', () => {
  beforeEach(() => orphans.clear());
  afterEach(() => orphans.clear());

  it('remembers which CLI the agent ran, so the orphan resumes with the right one', () => {
    // The worktree must exist or the crashed session is skipped as gone.
    const wt = mkdtempSync(join(tmpdir(), 'a007-wt-'));
    const wt2 = mkdtempSync(join(tmpdir(), 'a007-wt-'));
    const wt3 = mkdtempSync(join(tmpdir(), 'a007-wt-'));
    try {
      writeConfig([]);
      loadConfig();
      saveActiveSession({ name: 'Onyx', command: 'codex --dangerously-bypass-approvals-and-sandbox "do it"', repoPath: '/r', repoSlug: 'r', worktreePath: wt, branchName: 'b/onyx', color: '#000', cocktail: 'onyx' });
      saveActiveSession({ name: 'Viper', command: 'claude --permission-mode auto "do it"', repoPath: '/r', repoSlug: 'r', worktreePath: wt2, branchName: 'b/viper', color: '#000', cocktail: 'viper' });
      expect(config.activeSessions.map(s => s.agent)).toEqual(['codex', 'claude']);
      // And the permission flags each was started with, for a re-spawn that
      // has no job card to ask.
      expect(config.activeSessions.map(s => s.permissionFlags)).toEqual([['--dangerously-bypass-approvals-and-sandbox'], ['--permission-mode', 'auto']]);
      saveActiveSession({ name: 'Dispatched', command: 'codex "job"', spawnedBy: 'board', repoPath: '/r', repoSlug: 'r', worktreePath: wt3, branchName: 'b/dispatched', color: '#000', cocktail: 'dispatched' });
      expect(config.activeSessions.map(s => s.origin)).toEqual(['user', 'user', 'board']);

      // What the next start does with that record.
      loadConfig();
      recoverCrashedSessions();
      const byName = Object.fromEntries([...orphans.values()].map(o => [o.name, o]));
      expect(byName.Onyx.agent).toBe('codex');
      expect(byName.Onyx.permissionFlags).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
      expect(byName.Viper.agent).toBe('claude');
      expect(byName.Viper.permissionFlags).toEqual(['--permission-mode', 'auto']);
      expect(byName.Dispatched.origin).toBe('board');
      expect(byName.Onyx.origin).toBe('user');
      expect(config.orphans.find(o => o.name === 'Onyx').permissionFlags).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
      expect(config.orphans.find(o => o.name === 'Onyx').agent).toBe('codex');   // persisted, for the restart after this one
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(wt2, { recursive: true, force: true });
      rmSync(wt3, { recursive: true, force: true });
    }
  });

  it('prefers the session\'s own note over its command, and derives one only when there is none', () => {
    expect(sessionAgent({ agent: 'codex', command: 'bash -lc codex' })).toBe('codex');
    expect(sessionAgent({ agent: 'claude', command: 'codex resume' })).toBe('claude');
    expect(sessionAgent({ agent: null, command: 'codex resume' })).toBeNull();
    expect(sessionAgent({ command: 'claude --continue' })).toBe('claude');
    expect(sessionAgent({ command: 'gemini' })).toBeNull();
    expect(sessionAgent({})).toBeNull();
  });

  it('records flags for a session that owns them, and none for a board dispatch', async () => {
    // A board dispatch runs under its card's mode, which the board resolves
    // again at every re-spawn against its current setting; freezing the
    // dispatch-time flags on the session would let a bypass card retired long
    // ago come back as a bypass agent after the board was tightened.
    const { createSessionFromConfig } = await import('../server/pty.js');
    const spawn = (extra) => createSessionFromConfig({
      sessionId: `s-${Math.random().toString(36).slice(2)}`, name: 'T', color: '#000',
      command: process.platform === 'win32' ? 'cmd /c exit' : 'true', ...extra,
    }, () => {});
    // The command is a stand-in; the flags are judged from its text only when the CLI is one of ours,
    // so pass them in the way the ws re-adopt does and check the rule, not the parser.
    const own = spawn({ spawnedBy: 'user', permissionFlags: ['--sandbox', 'read-only'] });
    const board = spawn({ spawnedBy: 'board', permissionFlags: undefined });
    const passed = spawn({ spawnedBy: 'board', permissionFlags: ['--approve-for-me'] });
    try {
      expect(own.session.permissionFlags).toEqual(['--sandbox', 'read-only']);
      expect(board.session.permissionFlags).toEqual([]);
      expect(passed.session.permissionFlags).toEqual(['--approve-for-me']);   // an explicit answer wins
      // Lineage: a board dispatch is 'board'; a re-adopt opened as a user tab
      // keeps the orphan's origin it was handed.
      expect(own.session.origin).toBe('user');
      expect(board.session.origin).toBe('board');
      const readopted = spawn({ spawnedBy: undefined, origin: 'board', permissionFlags: [] });
      try { expect(readopted.session.origin).toBe('board'); expect(readopted.session.spawnedBy).toBe('user'); }
      finally { try { readopted.session.pty.kill(); } catch {} clearInterval(readopted.session.stateCheckInterval); }
      // And on the records: the active-session entry and the orphan it becomes.
      expect(sessionOrigin({ spawnedBy: 'board' })).toBe('board');
      expect(sessionOrigin({ origin: 'board', spawnedBy: 'user' })).toBe('board');
      expect(sessionOrigin({ spawnedBy: 'user' })).toBe('user');
      expect(sessionOrigin({})).toBe('user');
    } finally {
      for (const r of [own, board, passed]) { try { r.session.pty.kill(); } catch {} clearInterval(r.session.stateCheckInterval); }
    }
  });

  it('tolerates a session record written before the CLI was noted', () => {
    const wt = mkdtempSync(join(tmpdir(), 'a007-wt-'));
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({
        version: 1, repos: [], orphans: [], jobs: [],
        activeSessions: [{ name: 'Old', repoPath: '/r', repoSlug: 'r', worktreePath: wt, branchName: 'b/old', color: '#000' }],
      }));
      loadConfig();
      recoverCrashedSessions();
      expect([...orphans.values()][0].agent).toBeNull();
      expect([...orphans.values()][0].permissionFlags).toEqual([]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('passes a stored record\'s flags through the allowlist again, and only with a CLI of ours', () => {
    // config.json is hand-editable: what comes back onto the resume argv is
    // whatever the allowlist lets through, not whatever the file says. Each
    // record needs its own live worktree, or recovery skips it as gone.
    const wts = Array.from({ length: 5 }, () => mkdtempSync(join(tmpdir(), 'a007-wt-')));
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({
        version: 1, repos: [], orphans: [], jobs: [],
        activeSessions: [
          { name: 'Junk', agent: 'codex', permissionFlags: ['--sandbox', 'nope', '--approve-for-me', '--rm', '-rf', '/'], worktreePath: wts[0], branchName: 'b/junk' },
          { name: 'Text', agent: 'codex', permissionFlags: '--approve-for-me', worktreePath: wts[1], branchName: 'b/text' },
          { name: 'Cross', agent: 'claude', permissionFlags: ['--sandbox', 'read-only'], worktreePath: wts[2], branchName: 'b/cross' },
          { name: 'Alien', agent: 'gemini', permissionFlags: ['--permission-mode', 'plan'], worktreePath: wts[3], branchName: 'b/alien' },
          { name: 'Older', agent: 'claude', worktreePath: wts[4], branchName: 'b/older' },   // written before the flags were noted
        ],
      }));
      loadConfig();
      recoverCrashedSessions();
      const byName = Object.fromEntries([...orphans.values()].map(o => [o.name, [o.agent, o.permissionFlags]]));
      expect(byName).toEqual({
        Junk: ['codex', ['--approve-for-me']],
        Text: ['codex', []],
        Cross: ['claude', []],
        Alien: [null, []],
        Older: ['claude', []],
      });
      // And that is what is persisted for the restart after this one.
      expect(config.orphans.find(o => o.name === 'Junk').permissionFlags).toEqual(['--approve-for-me']);
      expect(config.activeSessions).toEqual([]);
    } finally {
      for (const wt of wts) rmSync(wt, { recursive: true, force: true });
    }
  });

  it('takes the flags a session carries over its command, and reads the command only when it carries none', () => {
    // Every PTY session carries them (createSessionFromConfig reads them off
    // the command at spawn); a bare object, as a test or an older caller
    // builds one, gets them read off the command the same way.
    expect(sessionPermissionFlags({ permissionFlags: ['--approve-for-me'], command: 'codex -s read-only' })).toEqual(['--approve-for-me']);
    expect(sessionPermissionFlags({ permissionFlags: [], command: 'codex -s read-only' })).toEqual([]);
    expect(sessionPermissionFlags({ command: 'codex -s read-only' })).toEqual(['--sandbox', 'read-only']);
    expect(sessionPermissionFlags({ permissionFlags: '--approve-for-me', command: 'claude --permission-mode plan' })).toEqual(['--permission-mode', 'plan']);
    expect(sessionPermissionFlags({ command: 'bash -lc "codex -s read-only"' })).toEqual([]);
    expect(sessionPermissionFlags({ command: 'gemini --yolo' })).toEqual([]);
    expect(sessionPermissionFlags({})).toEqual([]);

    // A re-adopted session's own note goes onto its record verbatim, whatever
    // its command says: the note came off the command at spawn, and the
    // record is re-checked against the allowlist on the way back in.
    const wt = mkdtempSync(join(tmpdir(), 'a007-wt-'));
    try {
      writeConfig([]);
      loadConfig();
      saveActiveSession({ name: 'Back', command: 'codex resume --sandbox read-only', permissionFlags: ['--sandbox', 'read-only'], agent: 'codex', worktreePath: wt, branchName: 'b/back' });
      saveActiveSession({ name: 'Guess', command: 'codex resume --sandbox read-only', permissionFlags: ['--sandbox', 'read-only'], agent: null, worktreePath: wt, branchName: 'b/guess' });
      saveActiveSession({ name: 'Bare', worktreePath: wt, branchName: 'b/bare' });
      expect(config.activeSessions.map(s => [s.name, s.agent, s.permissionFlags])).toEqual([
        ['Back', 'codex', ['--sandbox', 'read-only']],
        ['Guess', null, ['--sandbox', 'read-only']],
        ['Bare', null, []],
      ]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('notes a CLI only for a command that is literally one, and codex by the binary alone', () => {
    // A re-adopted agent already on `codex resume` and one spawned as
    // /opt/homebrew/bin/codex each record what their own re-adopt would need.
    // A plain terminal tab, a gemini, and a Codex started from inside a shell
    // record nothing: the note outranks every other witness at re-adopt time,
    // and "claude" by default would have sent a `bash -lc codex` back up as
    // Claude Code, past the job card and the transcripts that knew better. A
    // session with no worktree has nothing to re-adopt and is not recorded.
    const wt = mkdtempSync(join(tmpdir(), 'a007-wt-'));
    try {
      writeConfig([]);
      loadConfig();
      saveActiveSession({ name: 'Bare', worktreePath: wt, branchName: 'b/bare' });
      saveActiveSession({ name: 'Back', command: 'codex resume', worktreePath: wt, branchName: 'b/back' });
      saveActiveSession({ name: 'Brew', command: '/opt/homebrew/bin/codex --model o3', worktreePath: wt, branchName: 'b/brew' });
      saveActiveSession({ name: 'Gemini', command: 'gemini', worktreePath: wt, branchName: 'b/gemini' });
      saveActiveSession({ name: 'Shell', command: 'bash -lc codex', worktreePath: wt, branchName: 'b/shell' });
      // A re-adopted orphan whose CLI was only guessed carries agent: null on
      // the session itself, and that provenance beats its resume command —
      // otherwise a wrong guess would be recorded as fact on the next close.
      saveActiveSession({ name: 'Guess', command: 'codex resume', agent: null, worktreePath: wt, branchName: 'b/guess' });
      saveActiveSession({ name: 'NoTree', command: 'codex' });
      expect(config.activeSessions.map(s => [s.name, s.agent])).toEqual([
        ['Bare', null], ['Back', 'codex'], ['Brew', 'codex'], ['Gemini', null], ['Shell', null], ['Guess', null],
      ]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('restart recovery for finished cards', () => {
  it('drops the dead agent link on review and done cards, keeping the credit', () => {
    // Session ids come from a counter that restarts at zero, so a stale
    // `session-3` on an archived card can later name a completely unrelated
    // live agent — and deleting that card would kill it and release its
    // worktree. The name stays: it is the record of who did the work.
    writeConfig([
      {
        id: 'j1', title: 'in review', repoPath: '/r', state: 'review',
        agentSessionId: 'session-3', agentName: 'Viper',
        branchName: 'bill/a', prNumber: 1, reviewAt: '2026-08-27T00:00:00Z',
      },
      {
        id: 'j2', title: 'archived', repoPath: '/r', state: 'done',
        agentSessionId: 'session-3', agentName: 'Apex',
        branchName: 'bill/b', prNumber: 2,
        prMergedAt: '2026-08-27T00:00:00Z', doneAt: '2026-08-27T00:00:01Z',
      },
    ]);
    loadConfig();
    for (const job of config.jobs) expect(job.agentSessionId).toBeNull();
    expect(config.jobs[0].agentName).toBe('Viper');
    expect(config.jobs[1].agentName).toBe('Apex');
    // Nothing else about a finished card moves.
    expect(config.jobs[1].state).toBe('done');
    expect(config.jobs[1].prMergedAt).toBe('2026-08-27T00:00:00Z');
  });

});

describe('stale agent links after a restart', () => {
  it('clears the session link on a review job too, not just in-flight ones', () => {
    // Session ids are only unique within a process generation, so a link kept
    // on a finished card could resolve to an unrelated agent after a restart.
    writeConfig([{
      id: 'r1', title: 'shipped', repoPath: '/r', state: 'review',
      agentSessionId: 'session-5', agentName: 'Shadow',
      branchName: 'bill/x', prNumber: 20,
    }]);
    loadConfig();
    const job = config.jobs[0];
    expect(job.agentSessionId).toBeNull();
    expect(job.agentName).toBe('Shadow');   // credit kept
    expect(job.state).toBe('review');
    expect(job.prNumber).toBe(20);
  });

  it('clears it on a todo job as well', () => {
    writeConfig([{ id: 't1', title: 'queued', repoPath: '/r', state: 'todo', agentSessionId: 'session-2' }]);
    loadConfig();
    expect(config.jobs[0].agentSessionId).toBeNull();
  });
});

describe('a schedule saved mid-run by a server from before v0.4.9.0', () => {
  it('goes back to To do, naming the dead run\'s branch', () => {
    writeConfig([{
      id: 's1', title: 'Daily digest', repoPath: '/r', type: 'scheduled', schedule: '0 9 * * *',
      state: 'in-progress', agentSessionId: 'session-9', agentName: 'Viper', lastRunSessionId: 'session-8',
      branchName: 'bill/digest', runCount: 4,
    }]);
    loadConfig();
    const job = config.jobs[0];
    expect(config.jobs).toHaveLength(1);
    expect(job.state).toBe('todo');
    expect(job.branchName).toBeNull();
    expect(job.runCount).toBe(4);
    expect(job.lastRunSessionId).toBeUndefined();
    expect(job.lastError).toMatch(/bill\/digest/);
  });

  it('goes back to To do from Review too, and says nothing of a branch it never had', () => {
    writeConfig([{
      id: 's2', title: 'Daily digest', repoPath: '/r', type: 'scheduled', schedule: '@daily',
      state: 'review', agentSessionId: 'session-3', lastError: null,
    }]);
    loadConfig();
    expect(config.jobs[0].state).toBe('todo');
    expect(config.jobs[0].lastError).toBeNull();
  });
});
