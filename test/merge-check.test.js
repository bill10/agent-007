// merge_check (issue #192): which workflows a merge sets off, which of them
// deploy, the owner's per-repo policy, and that only Billion has the tool.

import { describe, it, expect, afterEach } from 'vitest';
import { analyzeWorkflows, matchesFilters, shouldAsk, mergeCheck } from '../server/merge-check.js';
import { handleMcpMessage, toolsFor } from '../server/mcp.js';
import { config } from '../server/state.js';
import { updateSettings, deployMergePolicyFor } from '../server/jobs.js';

const wf = (path, text) => ({ path: `.github/workflows/${path}`, text });
const run = (workflows, files = ['src/app.js'], base = 'main') => analyzeWorkflows({ workflows, base, files });

const DEPLOY_SCRAPER = wf('deploy-scraper.yml', `
name: Deploy scraper
on:
  push:
    branches: [main]
    paths: ['scraper/**']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
`);

const TESTS = wf('test.yml', `
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci && npm test
`);

describe('analyzeWorkflows', () => {
  it('counts a push to main whose path filter matches, and why', () => {
    const r = run([DEPLOY_SCRAPER], ['scraper/main.py', 'README.md']);
    expect(r.matches).toEqual([{
      workflow: '.github/workflows/deploy-scraper.yml', job: 'build', trigger: 'push to main',
      why: ['uses aws-actions/configure-aws-credentials@v4'], environment: null,
    }]);
    expect(r.unknown).toEqual([]);
  });

  it('skips it when no changed file matches the paths, or the base is another branch', () => {
    expect(run([DEPLOY_SCRAPER], ['web/index.html']).triggered).toEqual([]);
    expect(run([DEPLOY_SCRAPER], ['scraper/main.py'], 'develop').triggered).toEqual([]);
  });

  it('paths-ignore and ! negation', () => {
    const ignore = wf('d.yml', 'on:\n  push:\n    paths-ignore: ["docs/**"]\njobs:\n  deploy:\n    runs-on: x\n');
    expect(run([ignore], ['docs/a.md']).matches).toEqual([]);
    expect(run([ignore], ['docs/a.md', 'src/b.js']).matches).toHaveLength(1);
    expect(matchesFilters(['src/**', '!src/**/*.md'], 'src/x/y.md')).toBe(false);
    expect(matchesFilters(['src/**', '!src/**/*.md'], 'src/x/y.js')).toBe(true);
    expect(matchesFilters(['**/README.md'], 'README.md')).toBe(true);
    expect(matchesFilters(['*.js'], 'a/b.js')).toBe(false);
  });

  it('follows a workflow_run chain from a triggered workflow', () => {
    const deploy = wf('cd.yml', `
on:
  workflow_run:
    workflows: [Tests]
    types: [completed]
    branches: [main]
jobs:
  ship:
    runs-on: ubuntu-latest
    environment: production
    steps: [{ run: echo hi }]
`);
    const r = run([TESTS, deploy]);
    expect(r.matches).toEqual([expect.objectContaining({
      workflow: '.github/workflows/cd.yml', job: 'ship', trigger: 'workflow_run after "Tests"', environment: 'production',
    })]);
    // Nothing sets off Tests: nothing chains.
    expect(run([DEPLOY_SCRAPER, { ...deploy }], ['x']).matches).toEqual([]);
  });

  it('environment: production and npm publish both count', () => {
    const r = run([wf('rel.yml', `
on: { push: { branches: [main] } }
jobs:
  a:
    runs-on: x
    environment: { name: production, url: https://x }
  b:
    runs-on: x
    steps:
      - run: |
          npm ci
          npm publish --access public
`)]);
    expect(r.matches.map(m => [m.job, m.why])).toEqual([
      ['a', ['environment: production']],
      ['b', ['runs "npm publish"']],
    ]);
  });

  it('a plain test workflow runs but deploys nothing', () => {
    const r = run([TESTS]);
    expect(r.triggered).toEqual([{ workflow: '.github/workflows/test.yml', trigger: 'push to main' }]);
    expect(r.matches).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('unreadable or invalid YAML is unknown, never no deploy', () => {
    const r = run([wf('bad.yml', 'on: [push\njobs: {'), { path: '.github/workflows/gone.yml', error: 'HTTP 403' }]);
    expect(r.matches).toEqual([]);
    expect(r.unknown).toEqual([
      expect.stringMatching(/^\.github\/workflows\/bad\.yml: not valid YAML/),
      '.github/workflows/gone.yml: could not read it (HTTP 403)',
    ]);
    expect(shouldAsk('ask', r)).toBe(true);
  });

  it('pull_request closed counts; tag workflows only when something makes a tag', () => {
    const closed = wf('pc.yml', 'on:\n  pull_request:\n    types: [closed]\n    branches: [main]\njobs:\n  deploy:\n    runs-on: x\n');
    expect(run([closed]).matches).toHaveLength(1);
    const onTag = wf('tag.yml', 'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    runs-on: x\n');
    expect(run([TESTS, onTag]).matches).toEqual([]);
    expect(run([TESTS, onTag]).notes[0]).toMatch(/tag\.yml run on a tag or release/);
    const tagger = wf('tagger.yml', 'on: push\njobs:\n  t:\n    runs-on: x\n    steps: [{ run: "git tag v1 && git push --tags" }]\n');
    expect(run([tagger, onTag]).matches).toEqual([expect.objectContaining({ workflow: '.github/workflows/tag.yml', job: 'publish' })]);
  });

  it('looks inside a local reusable workflow; an external one is unknown', () => {
    const lib = wf('lib.yml', 'on: workflow_call\njobs:\n  up:\n    runs-on: x\n    steps: [{ run: "fly deploy" }]\n');
    const caller = wf('main.yml', 'on: push\njobs:\n  go:\n    uses: ./.github/workflows/lib.yml\n  other:\n    uses: org/ci/.github/workflows/x.yml@v1\n');
    const r = run([caller, lib]);
    expect(r.matches).toEqual([expect.objectContaining({ workflow: '.github/workflows/lib.yml', job: 'up', why: ['runs "fly deploy"'] })]);
    expect(r.unknown).toEqual([expect.stringMatching(/job other: calls org\/ci/)]);
  });
});

describe('policy', () => {
  const prod = { matches: [{ environment: 'production' }], unknown: [] };
  const npm = { matches: [{ environment: null }], unknown: [] };
  const none = { matches: [], unknown: [] };

  it('ask / never-ask / ask-production-only', () => {
    expect([shouldAsk('ask', npm), shouldAsk('ask', none)]).toEqual([true, false]);
    expect([shouldAsk('never-ask', prod), shouldAsk('never-ask', { matches: [], unknown: ['x'] })]).toEqual([false, false]);
    expect([shouldAsk('ask-production-only', prod), shouldAsk('ask-production-only', npm)]).toEqual([true, false]);
    expect(shouldAsk('ask-production-only', { matches: [{ environment: 'Prod' }], unknown: [] })).toBe(true);
    expect(shouldAsk('ask-production-only', { matches: [], unknown: ['x'] })).toBe(true);
  });

  afterEach(() => { config.repos = []; delete config.jobBoard; });

  it('is set per configured repo, defaults to ask, and ignores junk', () => {
    config.repos = [{ path: '/r/a' }];
    expect(deployMergePolicyFor('/r/a')).toBe('ask');
    updateSettings({ deployMergePolicy: { repo: '/r/a', policy: 'never-ask' } });
    expect(deployMergePolicyFor('/r/a')).toBe('never-ask');
    updateSettings({ deployMergePolicy: { repo: '/r/b', policy: 'never-ask' } });   // not a configured repo
    updateSettings({ deployMergePolicy: { repo: '/r/a', policy: 'sometimes' } });
    expect(deployMergePolicyFor('/r/b')).toBe('ask');
    expect(deployMergePolicyFor('/r/a')).toBe('never-ask');
    updateSettings({ deployMergePolicy: { repo: '/r/a', policy: 'ask' } });
    expect(config.jobBoard.deployMergePolicy).toEqual({});
    config.jobBoard.deployMergePolicy = { '/r/a': 'whatever' };   // hand-edited
    expect(deployMergePolicyFor('/r/a')).toBe('ask');
  });
});

describe('mergeCheck', () => {
  const PR = 'https://github.com/o/r/pull/7';
  const fakeGh = (routes) => async (args) => {
    const path = args.find(a => a.startsWith('repos/'));
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    if (!hit || hit[1] instanceof Error) throw hit?.[1] || Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' });
    return hit[1];
  };
  const base = {
    'repos/o/r/pulls/7/files': 'scraper/a.py\n',
    'repos/o/r/pulls/7': JSON.stringify({ title: 'T', state: 'open', base: { ref: 'main' }, changed_files: 1 }),
    'repos/o/r/contents/.github/workflows?': JSON.stringify([{ type: 'file', name: 'deploy-scraper.yml', path: '.github/workflows/deploy-scraper.yml' }]),
    'repos/o/r/contents/.github/workflows/deploy-scraper.yml': DEPLOY_SCRAPER.text,
    'repos/o/r/environments': 'production\n',
  };
  const opts = (routes) => ({ jobs: [{ id: 'j1', title: 'C', prUrl: PR, repoPath: null }], findRepo: async () => null, accountFor: async () => null, gh: fakeGh(routes) });

  it('reports the deploy and should_ask, by card id or URL', async () => {
    const r = await mergeCheck('j1', opts(base));
    expect(r).toMatchObject({ repo: 'o/r', policy: 'ask', deploys: true, should_ask: true, environments: ['production'], unknown: [] });
    expect((await mergeCheck(PR, opts(base))).deploys).toBe(true);
  });

  it('an API error reading workflows is unknown, not no deploy', async () => {
    const r = await mergeCheck(PR, opts({ ...base, 'repos/o/r/contents/.github/workflows?': Object.assign(new Error('x'), { stderr: 'HTTP 502' }) }));
    expect(r).toMatchObject({ deploys: false, should_ask: true, unknown: ['.github/workflows: HTTP 502'] });
  });

  it('no workflows folder is a plain no', async () => {
    const { 'repos/o/r/contents/.github/workflows?': _, ...rest } = base;
    const r = await mergeCheck(PR, opts(rest));
    expect(r).toMatchObject({ deploys: false, should_ask: false, unknown: [] });
  });

  it('a card with no PR, or an unknown ref, is an error', async () => {
    expect((await mergeCheck('nope', opts(base))).error).toMatch(/neither/);
    expect((await mergeCheck('j2', { ...opts(base), jobs: [{ id: 'j2', title: 'C' }] })).error).toMatch(/no pull request/);
  });
});

describe('the merge_check tool', () => {
  const call = (ctx) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merge_check', arguments: { pr: 'x' } } }, ctx);

  it('is Billion\'s alone', () => {
    expect(toolsFor({ isBillion: true }).some(t => t.name === 'merge_check')).toBe(true);
    expect(toolsFor({}).some(t => t.name === 'merge_check')).toBe(false);
    expect(call({ session: {} }).error.message).toMatch(/Unknown tool/);
  });

  it('says what deploys and that it must ask', async () => {
    const r = await call({ session: { isBillion: true }, mergeCheck: async () => ({
      repo: 'o/r', pr: { number: 7, title: 'T', base: 'main', state: 'open' }, policy: 'ask', deploys: true, should_ask: true,
      matches: [{ workflow: 'd.yml', job: 'build', trigger: 'push to main', why: ['environment: production'] }],
      triggered: [{ workflow: 'd.yml' }, { workflow: 't.yml', trigger: 'push to main' }], unknown: [], environments: [], notes: [],
    }) });
    const text = r.result.content[0].text;
    expect(text).toMatch(/should_ask: true — do not merge/);
    expect(text).toMatch(/d\.yml job build \(push to main\): environment: production/);
    expect(text).toMatch(/Also runs, no deploy found:\n {2}t\.yml/);
  });
});
