// A card's model: discovered per CLI at startup (Claude Code's aliases,
// Codex's model cache), validated against that list, and put on the spawned
// and re-spawned argv as one token.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { addJob, updateJob, boardSettings, allJobs, postJobForAgent, editJobForAgent, dispatchOnce, orphanResumePlan } from '../server/jobs.js';
import { parseCodexModels, discoverModels, refreshModels, CLAUDE_ALIASES } from '../server/models.js';
import { handleMcpMessage } from '../server/mcp.js';
import { parseCommand } from '../lib/helpers.js';
import { createJob, createRunJob, buildJobCommand, resumeCommand, resolveJobModel } from '../lib/jobs.js';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/codex-models-cache.json'), 'utf8');
const REPO = mkdtempSync(join(tmpdir(), 'a007-models-'));
const noop = () => {};
const MODELS = { claude: CLAUDE_ALIASES, codex: ['gpt-6-luna', 'gpt-5.5'] };

describe('discovery', () => {
  it('reads Codex\'s cache in picker order, leaving out the hidden models', () => {
    // codex-auto-review and gpt-reserve are visibility "hide" in the real cache.
    expect(parseCodexModels(FIXTURE)).toEqual(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
  });

  it('drops a slug that could not go on a command line, and survives junk', () => {
    const cache = JSON.stringify({ models: [
      { slug: '--yolo', visibility: 'list' }, { slug: 'a b', visibility: 'list' }, { slug: 'ok-1', visibility: 'list' }, null,
    ] });
    expect(parseCodexModels(cache)).toEqual(['ok-1']);
    expect(parseCodexModels('not json')).toEqual([]);
    expect(parseCodexModels('{"models":{}}')).toEqual([]);
  });

  it('offers Claude\'s aliases and Codex\'s cache, from CODEX_HOME, for CLIs that are installed', () => {
    const read = (p) => { expect(p).toBe(join('/ch', 'models_cache.json')); return FIXTURE; };
    const both = discoverModels({ env: { CODEX_HOME: '/ch' }, exists: () => true, read });
    expect(both.claude).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(both.codex).toContain('gpt-6-luna');
    expect(discoverModels({ env: {}, exists: (f) => f === 'claude', read })).toEqual({ claude: CLAUDE_ALIASES, codex: [] });
  });

  it('is empty when discovery fails', () => {
    const read = () => { throw new Error('ENOENT'); };
    expect(discoverModels({ env: {}, exists: () => false, read })).toEqual({ claude: [], codex: [] });
    expect(discoverModels({ env: {}, exists: () => true, read }).codex).toEqual([]);
  });
});

describe('validation', () => {
  it('takes a discovered model for the card\'s agent, empty as the default, and nothing else', () => {
    expect(resolveJobModel('', 'claude', MODELS)).toEqual({ model: null });
    expect(resolveJobModel(undefined, 'claude', MODELS)).toEqual({ model: null });
    expect(resolveJobModel('opus', 'claude', MODELS)).toEqual({ model: 'opus' });
    expect(resolveJobModel('gpt-5.5', 'codex', MODELS)).toEqual({ model: 'gpt-5.5' });
    for (const bad of ['gpt-5.5', 'opus --dangerously-skip-permissions', '--yolo', 42, {}]) {
      expect(resolveJobModel(bad, 'claude', MODELS).error).toMatch(/Unknown model/);
    }
    expect(resolveJobModel('opus', 'claude', { claude: [], codex: [] }).error).toMatch(/none discovered/);
    // A schedule's run carries its schedule's model: shape only.
    expect(resolveJobModel('opus', 'claude')).toEqual({ model: 'opus' });
    expect(resolveJobModel('a b', 'claude').error).toMatch(/Unknown model/);
  });
});

describe('command line', () => {
  it('passes the model as its own argument to each CLI', () => {
    const claude = createJob({ title: 't', repoPath: REPO, model: 'opus', availableModels: MODELS }).job;
    expect(parseCommand(buildJobCommand(claude)).args.slice(0, 4)).toEqual(['--permission-mode', 'auto', '--model', 'opus']);
    const codex = createJob({ title: 't', repoPath: REPO, agent: 'codex', model: 'gpt-5.5', availableModels: MODELS }).job;
    expect(parseCommand(buildJobCommand(codex)).args.slice(0, 2)).toEqual(['-m', 'gpt-5.5']);
    expect(buildJobCommand({ ...claude, model: null })).not.toMatch(/--model/);
    expect(createRunJob({ ...claude, id: 's' }).job.model).toBe('opus');
  });

  it('keeps it on a resume', () => {
    expect(parseCommand(resumeCommand('claude', 'auto', [], null, 'opus')).args).toEqual(['--continue', '--permission-mode', 'auto', '--model', 'opus']);
    expect(parseCommand(resumeCommand('codex', 'auto', [], null, 'gpt-5.5')).args).toEqual(['resume', '-m', 'gpt-5.5']);
    expect(resumeCommand('claude', null, [], null, 'x y')).toBe('claude --continue');
  });
});

describe('on the board', () => {
  beforeEach(() => {
    config.repos = [{ path: REPO }];
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
    sessions.clear();
    refreshModels({ env: {}, exists: () => true, read: () => FIXTURE });
  });

  it('rejects an unknown model at every door', () => {
    expect(addJob({ title: 't', repoPath: REPO, model: 'gpt-9' }, noop).error).toMatch(/Unknown model/);
    expect(postJobForAgent({ title: 't', repo: REPO, model: 'opus; rm -rf /' }, noop).error).toMatch(/Unknown model/);
    const { job } = addJob({ title: 't', repoPath: REPO }, noop);
    expect(updateJob(job.id, { model: 'gpt-6-luna' }).error).toMatch(/Unknown model/);
    expect(updateJob(job.id, { agent: 'codex', model: 'gpt-6-luna' }).job.model).toBe('gpt-6-luna');
    // Switching CLI without naming a model drops the old CLI's one.
    expect(updateJob(job.id, { agent: 'claude' }).job.model).toBeNull();
    expect(editJobForAgent({ id: job.id, model: 'sonnet' }, noop).changed).toEqual(['model']);
    expect(allJobs()[0].model).toBe('sonnet');
  });

  it('dispatches on the card\'s model, and a re-spawned worker keeps it', async () => {
    addJob({ title: 'hard one', repoPath: REPO, model: 'fable' }, noop);
    await dispatchOnce(async (command, name, repoPath, branch) => {
      const session = { id: 's1', name: 'A1', command, repoPath, branchName: branch, exited: false };
      sessions.set(session.id, session);
      return { session };
    }, noop);
    const [job] = allJobs();
    expect(parseCommand(sessions.get('s1').command).args).toContain('fable');
    sessions.clear();
    job.agentSessionId = null;
    const homes = { claude: join(REPO, 'no-claude'), codex: join(REPO, 'no-codex') };
    const plan = orphanResumePlan({ repoPath: REPO, branchName: job.branchName, worktreePath: '/wt/x', agent: 'claude' }, homes);
    expect(parseCommand(plan.command).args).toEqual(['--continue', '--permission-mode', 'auto', '--model', 'fable']);
  });

  it('lists the discovered models in the MCP tool descriptions and shows the model on read', () => {
    const reply = handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { models: { claude: ['opus'], codex: [] } });
    const post = reply.result.tools.find(t => t.name === 'post_job');
    expect(post.inputSchema.properties.model.description).toMatch(/claude: opus; codex: \(none found/);
    expect(reply.result.tools.find(t => t.name === 'edit_job').inputSchema.properties.model).toBeTruthy();
    const read = handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_job', arguments: { id: 'j' } } },
      { readJob: () => ({ job: { id: 'j', title: 'T', state: 'todo', repo: 'r', model: 'opus', attachments: [], postedAt: null } }) });
    expect(read.result.content[0].text).toMatch(/model: opus/);
  });
});
