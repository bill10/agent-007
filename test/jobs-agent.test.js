// Which CLI a card is dispatched on: claude (the default) or codex. The value
// reaches the spawned argv, so it is allowlisted like the permission mode; a
// card an agent posts defaults to the poster's own CLI; and Codex, having no
// --permission-mode, gets the board's mode folded into its one flag.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { addJob, updateJob, updateSettings, boardSettings, allJobs, postJobForAgent, dispatchOnce, listJobsForAgent } from '../server/jobs.js';
import { parseCommand } from '../lib/helpers.js';
import { createJob, buildJobCommand, buildJobPrompt, jobAgentFromCommand, jobAgent, JOB_AGENTS, PERMISSION_MODES, CODEX_MODE_FLAGS } from '../lib/jobs.js';

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

  it('maps every Claude mode onto a Codex flag, and never --add-dir', () => {
    const job = codex({ attachments: [{ name: 'a.png', path: '/cfg/attachments/j1/a.png' }] });
    // Every allowlisted mode has an entry, so a strict board can never fall
    // through to Codex's default by omission.
    expect(Object.keys(CODEX_MODE_FLAGS).sort()).toEqual([...PERMISSION_MODES].sort());
    const want = {
      auto: [], acceptEdits: [],
      plan: ['--sandbox', 'read-only'],
      manual: ['--ask-for-approval', 'untrusted'],
      dontAsk: ['--ask-for-approval', 'never'],
      bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
    };
    for (const mode of PERMISSION_MODES) {
      // From the board, and from the card itself (a ws edit can store one).
      for (const cmd of [buildJobCommand(job, { permissionMode: mode }), buildJobCommand({ ...job, permissionMode: mode })]) {
        const { args } = parseCommand(cmd);
        expect(args.slice(0, -1)).toEqual(want[mode]);
        expect(args.at(-1)).toBe(buildJobPrompt(job));
        expect(cmd).not.toContain('--add-dir');
      }
    }
  });

  it('binds a read-only board to a codex card, whoever posted it', () => {
    resetBoard();
    updateSettings({ permissionMode: 'plan' }, noop);
    const { job } = postJobForAgent({ title: 'x', repo: REPO, agent: 'codex', session: { name: 'Onyx', command: 'claude', repoPath: REPO } }, noop);
    expect(buildJobCommand(job, { permissionMode: boardSettings().permissionMode })).toMatch(/^codex --sandbox read-only "/);
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

describe('reading the agent off a card', () => {
  it('falls back to claude for anything hand-edited into config.json, and for no card at all', () => {
    // The stored value is re-checked against the allowlist on every read, so a
    // card holding a value that is not a CLI never reaches the argv as one.
    expect(jobAgent({ agent: 'gemini' })).toBe('claude');
    expect(jobAgent({ agent: 'codex --yolo' })).toBe('claude');
    expect(jobAgent(null)).toBe('claude');
    expect(createJob({ title: 't', repoPath: REPO, agent: null }).job.agent).toBe('claude');
  });

  it('judges the executable the way the MCP-config gate does: basename, extension stripped', () => {
    expect(jobAgentFromCommand('codexy --flag')).toBe('claude');
    expect(jobAgentFromCommand('codex-foo')).toBe('claude');
    expect(jobAgentFromCommand('  codex')).toBe('codex');
    expect(jobAgentFromCommand(42)).toBe('claude');
    expect(jobAgentFromCommand('/usr/local/bin/codex --model o3')).toBe('codex');
    expect(jobAgentFromCommand('"codex" --model o3')).toBe('codex');
    expect(jobAgentFromCommand('codex.cmd')).toBe('codex');
    // npx is the executable; what it runs is not the board's business.
    expect(jobAgentFromCommand('npx codex')).toBe('claude');
  });

  it('refuses a non-string agent without echoing it, and bounds a long one', () => {
    expect(createJob({ title: 't', repoPath: REPO, agent: { x: 1 } }).error).toMatch(/Unknown agent a object/);
    const long = 'x'.repeat(500);
    const err = createJob({ title: 't', repoPath: REPO, agent: long }).error;
    expect(err).toContain('x'.repeat(40));
    expect(err.length).toBeLessThan(120);
  });

  it('gives a scheduled codex card the scheduled suffix, which names no ship skill', () => {
    // scheduledPromptSuffix ignores the agent: a scheduled run opens no PR, so
    // neither spelling belongs there.
    const prompt = buildJobPrompt(createJob({ title: 't', repoPath: REPO, agent: 'codex', type: 'scheduled', schedule: '@daily' }).job);
    expect(prompt).toContain('scheduled run');
    expect(prompt).not.toMatch(/[$/]ship/);
  });
});

describe('the summary an agent reads', () => {
  beforeEach(resetBoard);

  it('names the CLI each card runs on', () => {
    addJob({ title: 'c', repoPath: REPO, agent: 'codex' }, noop);
    addJob({ title: 'old', repoPath: REPO }, noop);
    delete allJobs()[1].agent;   // a card written before the field existed
    expect(listJobsForAgent().jobs.map(j => j.agent)).toEqual(['codex', 'claude']);
  });
});

describe('postJobForAgent edges', () => {
  beforeEach(resetBoard);

  it('treats a session with no command, and an empty agent, as the poster CLI or claude', () => {
    expect(postJobForAgent({ title: 'x', session: { name: 'A', repoPath: REPO } }, noop).job.agent).toBe('claude');
    // '' is "unnamed", so it still follows the poster rather than forcing claude.
    expect(postJobForAgent({ title: 'x', agent: '', session: { name: 'A', command: 'codex', repoPath: REPO } }, noop).job.agent).toBe('codex');
  });

  it('refuses an agent outside the allowlist as a plain error', () => {
    expect(postJobForAgent({ title: 'x', repo: REPO, agent: 'gemini' }, noop).error).toMatch(/Unknown agent/);
    expect(allJobs()).toHaveLength(0);
  });
});

describe('updateJob and the agent field', () => {
  beforeEach(resetBoard);

  it('leaves the agent alone when the edit does not mention it', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO, agent: 'codex' }, noop);
    updateJob(job.id, { title: 'renamed' }, noop);
    expect(allJobs()[0].agent).toBe('codex');
    expect(allJobs()[0].title).toBe('renamed');
  });

  it('refuses a bad agent before touching anything else on the card', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO }, noop);
    expect(updateJob(job.id, { title: 'renamed', agent: 'gemini' }, noop).error).toMatch(/Unknown agent/);
    expect(allJobs()[0].title).toBe('x');
    expect(allJobs()[0].agent).toBe('claude');
  });
});

describe('an agent retuned while the card is spawning', () => {
  beforeEach(resetBoard);

  // Same hazard as a permission mode changed mid-spawn: the argv was built
  // before the await in createSession, so a card switched to codex while its
  // claude process was starting would run claude with the board saying codex.
  it('does not claim the card, kills the spawn, and leaves it in To do with the new agent', async () => {
    const { job } = addJob({ title: 'switched', repoPath: REPO }, noop);
    updateSettings({ running: true }, noop);
    const calls = [];
    const killed = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      calls.push(command);
      const session = { id: 's1', name: 'A', command, repoPath, state: 'WORKING', exited: false, lastOutputAt: Date.now(), spawnedBy: meta?.spawnedBy, jobId: meta?.jobId };
      sessions.set(session.id, session);
      updateJob(job.id, { agent: 'codex' }, noop);   // stands in for the WS handler
      return { session };
    }, noop, { killSession: async (id) => { killed.push(id); } });
    expect(parseCommand(calls[0]).file).toBe('claude');
    expect(killed).toEqual(['s1']);
    expect(allJobs()[0].state).toBe('todo');
    expect(allJobs()[0].agentSessionId).toBeNull();
    expect(allJobs()[0].agent).toBe('codex');
  });

  // The recheck compares the argv itself, so an edit to anything the prompt
  // is built from — here the title — abandons the spawn too, and the next
  // tick sends the card out as it now reads rather than as it was.
  it('does not claim a card whose text was edited mid-spawn either', async () => {
    const { job } = addJob({ title: 'before', repoPath: REPO }, noop);
    updateSettings({ running: true }, noop);
    const killed = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      const session = { id: 's1', name: 'A', command, repoPath, state: 'WORKING', exited: false, lastOutputAt: Date.now(), spawnedBy: meta?.spawnedBy, jobId: meta?.jobId };
      sessions.set(session.id, session);
      updateJob(job.id, { title: 'after' }, noop);
      return { session };
    }, noop, { killSession: async (id) => { killed.push(id); } });
    expect(killed).toEqual(['s1']);
    expect(allJobs()[0].state).toBe('todo');
    expect(allJobs()[0].title).toBe('after');
  });

  it('does not claim a card repointed at another repo mid-spawn', async () => {
    const other = mkdtempSync(join(tmpdir(), 'a007-jobagent-other-'));
    config.repos.push({ path: other });
    const { job } = addJob({ title: 'moving', repoPath: REPO }, noop);
    updateSettings({ running: true }, noop);
    const killed = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      const session = { id: 's1', name: 'A', command, repoPath, state: 'WORKING', exited: false, lastOutputAt: Date.now(), spawnedBy: meta?.spawnedBy, jobId: meta?.jobId };
      sessions.set(session.id, session);
      updateJob(job.id, { repoPath: other }, noop);
      return { session };
    }, noop, { killSession: async (id) => { killed.push(id); } });
    expect(killed).toEqual(['s1']);
    expect(allJobs()[0].state).toBe('todo');
    expect(allJobs()[0].worktreePath ?? null).toBeNull();
  });
});
