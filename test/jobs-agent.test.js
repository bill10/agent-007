// Which CLI a card is dispatched on: claude (the default) or codex. The value
// reaches the spawned argv, so it is allowlisted like the permission mode; a
// card an agent posts defaults to the poster's own CLI; and Codex, having no
// --permission-mode, gets the board's mode folded into its one flag.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { addJob, updateJob, updateSettings, boardSettings, allJobs, postJobForAgent, dispatchOnce } from '../server/jobs.js';
import { parseCommand } from '../lib/helpers.js';
import { createJob, buildJobCommand, buildJobPrompt, jobAgentFromCommand, jobAgent, JOB_AGENTS } from '../lib/jobs.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-jobagent-'));
const noop = () => {};

function resetBoard() {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
}

describe('createJob agent', () => {
  it('defaults to claude, accepts codex, refuses anything else', () => {
    expect(createJob({ title: 't', repoPath: REPO }).job.agent).toBe('claude');
    expect(createJob({ title: 't', repoPath: REPO, agent: '' }).job.agent).toBe('claude');
    expect(createJob({ title: 't', repoPath: REPO, agent: 'codex' }).job.agent).toBe('codex');
    for (const bad of ['gemini', 'codex --yolo', 'CODEX', 42, {}]) {
      expect(createJob({ title: 't', repoPath: REPO, agent: bad }).error).toMatch(/Unknown agent/);
    }
  });

  it('reads a card written before the field existed as claude', () => {
    expect(jobAgent({ title: 'old' })).toBe('claude');
    expect(JOB_AGENTS).toEqual(['claude', 'codex']);
  });
});

describe('buildJobCommand for codex', () => {
  const codex = (over = {}) => createJob({ title: 'Fix "it"', repoPath: REPO, agent: 'codex', ...over }).job;

  it('runs codex with no flag in auto, and the whole prompt as one argv', () => {
    const parsed = parseCommand(buildJobCommand(codex({ permissionMode: 'auto' })));
    expect(parsed.file).toBe('codex');
    expect(parsed.args).toEqual([buildJobPrompt(codex())]);
  });

  it('maps bypassPermissions onto the bypass flag, from the card or the board', () => {
    const own = parseCommand(buildJobCommand(codex({ permissionMode: 'bypassPermissions' })));
    expect(own.args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(own.args).toHaveLength(2);
    const board = parseCommand(buildJobCommand(codex(), { permissionMode: 'bypassPermissions' }));
    expect(board.args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
  });

  it('runs every other board mode with no flag, and never --add-dir', () => {
    const job = codex({ attachments: [{ name: 'a.png', path: '/cfg/attachments/j1/a.png' }] });
    for (const mode of ['acceptEdits', 'plan', 'manual']) {
      const cmd = buildJobCommand(job, { permissionMode: mode });
      expect(parseCommand(cmd).args).toHaveLength(1);
      expect(cmd).not.toContain('--add-dir');
    }
  });

  it('tells codex to run $ship, not /ship', () => {
    const prompt = buildJobPrompt(codex());
    expect(prompt).toMatch(/run \$ship\./);
    expect(prompt).not.toContain('/ship');
    expect(buildJobPrompt(createJob({ title: 't', repoPath: REPO }).job)).toContain('/ship');
  });
});

describe('a card posted by an agent', () => {
  beforeEach(resetBoard);

  it('defaults to the CLI of the agent posting it', () => {
    expect(jobAgentFromCommand('codex --model o3')).toBe('codex');
    expect(jobAgentFromCommand('claude --continue')).toBe('claude');
    expect(jobAgentFromCommand('gemini')).toBe('claude');
    expect(jobAgentFromCommand(undefined)).toBe('claude');
    const session = { name: 'Onyx', command: 'codex', repoPath: REPO };
    expect(postJobForAgent({ title: 'x', session }, noop).job.agent).toBe('codex');
    expect(postJobForAgent({ title: 'x', agent: 'claude', session }, noop).job.agent).toBe('claude');
    expect(postJobForAgent({ title: 'x', repo: REPO }, noop).job.agent).toBe('claude');
    expect(postJobForAgent({ title: 'x', repo: REPO, agent: 7 }, noop).error).toMatch(/agent must be a string/);
  });
});

describe('the board', () => {
  beforeEach(resetBoard);

  it('edits the agent on a To do card and dispatches with it', async () => {
    const { job } = addJob({ title: 'x', repoPath: REPO }, noop);
    expect(updateJob(job.id, { agent: 'codex' }, noop).error).toBeUndefined();
    expect(allJobs()[0].agent).toBe('codex');
    expect(updateJob(job.id, { agent: 'nope' }, noop).error).toMatch(/Unknown agent/);
    updateSettings({ running: true, permissionMode: 'bypassPermissions' }, noop);
    const calls = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      calls.push(command);
      const session = { id: 's1', name: 'A', command, repoPath, state: 'WORKING', exited: false, lastOutputAt: Date.now(), spawnedBy: meta?.spawnedBy, jobId: meta?.jobId };
      sessions.set(session.id, session);
      return { session };
    }, noop, {});
    expect(calls).toHaveLength(1);
    expect(parseCommand(calls[0]).file).toBe('codex');
    expect(parseCommand(calls[0]).args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
  });
});
