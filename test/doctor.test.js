import { describe, it, expect } from 'vitest';
import {
  runDoctor, failed, formatReport, formatStartup, versionAtLeast,
  checkNode, checkClis, checkGh, checkRepos, checkPort, checkSettings, checkVersion, checkTelegram, checkPlugins,
} from '../server/doctor.js';

// A machine where everything passes; each test breaks one thing. No real CLI,
// git, port or network is touched.
const CONFIG = '/cfg/config.json';
function probes(over = {}) {
  const files = {
    [CONFIG]: JSON.stringify({ repos: [{ path: '/r/app' }], jobs: [{ state: 'todo', agent: 'codex', repoPath: '/r/app' }, { state: 'done', agent: 'claude' }] }),
    '/home/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: {} }),
    ...over.files,
  };
  return {
    env: {},
    nodeVersion: '22.1.0',
    engines: '>=20.12',
    version: '0.40.0',
    loadPty: async () => ({}),
    which: (c) => `/bin/${c}`,
    scanAgents: async (clis) => clis.map(cli => ({ cli, version: '1.0', path: `/bin/${cli}`, accounts: [{ isDefault: true, loggedIn: true }] })),
    billionAgent: () => 'claude',
    billionRuns: () => true,
    ghAccounts: async () => ['alice', 'bob'],
    ghAccountFor: async () => ({ login: 'bob', token: 'ghp_secret' }),
    git: async (args) => (args.includes('get-url') ? 'git@github.com:acme/app.git\n' : args.includes('ls-remote') ? 'abc\trefs/heads/main\n' : '.git'),
    repoEnv: async () => ({ GH_TOKEN: 'ghp_secret' }),
    baseBranch: async () => 'main',
    exists: (p) => p in files || p.startsWith('/r/') || p.startsWith('/home/'),
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    port: 7007,
    host: '127.0.0.1',
    portState: async () => 'free',
    configPath: CONFIG,
    worktreeDir: '/home/.agent-007/worktrees',
    claudeDir: '/home/.claude',
    settingsLine: 'Settings: ~/.agent-007/.env',
    npmLatest: async () => '0.40.0',
    telegramGetMe: async () => ({ username: 'my_bot' }),
    ...over,
  };
}
const board = (p) => ({ repos: ['/r/app'], jobs: [{ state: 'todo', agent: 'codex' }], ...p });
const origin = async () => 'https://github.com/acme/app.git';
const statuses = (lines) => lines.map(l => l.status);

describe('doctor checks', () => {
  it('versionAtLeast compares numerically', () => {
    expect(versionAtLeast('20.12.0', '20.12')).toBe(true);
    expect(versionAtLeast('20.9.0', '20.12')).toBe(false);
    expect(versionAtLeast('v22.0.0', '20.12')).toBe(true);
  });

  it('node: old Node and an unloadable node-pty are ✗ with a fix', async () => {
    expect(statuses(await checkNode(probes()))).toEqual(['ok', 'ok']);
    const lines = await checkNode(probes({ nodeVersion: '18.0.0', loadPty: async () => { throw new Error('bad ELF'); } }));
    expect(statuses(lines)).toEqual(['fail', 'fail']);
    expect(lines.every(l => l.fix)).toBe(true);
  });

  it('a missing CLI is ✗ only when Billion or a card uses it', async () => {
    const none = async () => [];
    const lines = await checkClis(probes({ scanAgents: none }), board());
    expect(lines[0]).toMatchObject({ status: 'fail', text: expect.stringContaining('Billion runs on it') });
    expect(lines[1]).toMatchObject({ status: 'fail', text: expect.stringContaining('a board card uses it') });
    const unused = await checkClis(probes({ scanAgents: none, billionRuns: () => false }), board({ jobs: [] }));
    expect(statuses(unused)).toEqual(['na', 'na']);
  });

  it('a logged-out CLI that is used is ✗ with its login command', async () => {
    const scan = async (clis) => clis.map(cli => ({ cli, version: '1', path: `/bin/${cli}`, accounts: [{ isDefault: true, loggedIn: false }] }));
    const [claude, codex] = await checkClis(probes({ scanAgents: scan }), board());
    expect(claude).toMatchObject({ status: 'fail', fix: 'claude auth login' });
    expect(codex).toMatchObject({ status: 'fail', fix: 'codex login' });
  });

  it('gh: per-repo account, ✗ when none can see it, never a token', async () => {
    const lines = await checkGh(probes(), board(), origin);
    expect(statuses(lines)).toEqual(['ok', 'ok']);
    expect(lines[1].text).toBe('acme/app: reachable as bob');
    expect(JSON.stringify(lines)).not.toContain('ghp_secret');
    const none = await checkGh(probes({ ghAccountFor: async () => null }), board(), origin);
    expect(none[1].status).toBe('fail');
    const out = await checkGh(probes({ ghAccounts: async () => [] }), board(), origin);
    expect(out[0]).toMatchObject({ status: 'fail', fix: 'gh auth login' });
  });

  it('gh missing is ✗ only with a GitHub repo on the board; fast never asks gh', async () => {
    const noGh = (c) => (c === 'gh' ? null : `/bin/${c}`);
    expect((await checkGh(probes({ which: noGh }), board(), origin))[0].status).toBe('fail');
    expect((await checkGh(probes({ which: noGh }), board({ repos: [] }), origin))[0].status).toBe('na');
    const asked = [];
    const fast = await checkGh(probes({ ghAccounts: async () => { asked.push(1); return []; } }), board(), origin, { fast: true });
    expect(fast).toEqual([{ status: 'ok', text: 'gh installed' }]);
    expect(asked).toEqual([]);
  });

  it('repos: missing path, not git, no origin, no main on the remote', async () => {
    const at = async (p) => (await checkRepos(probes(p.probes), board(), p.origin || origin))[1];
    expect((await at({})).status).toBe('ok');
    expect((await at({ probes: { exists: () => false } })).text).toMatch(/does not exist/);
    expect((await at({ probes: { git: async (a) => { if (a.includes('rev-parse')) throw new Error('no'); return ''; } } })).text).toMatch(/not a git repository/);
    expect((await at({ origin: async () => null })).text).toMatch(/no origin remote/);
    expect((await at({ probes: { git: async (a) => (a.includes('ls-remote') ? '' : '.git') } })).text).toMatch(/no main branch/);
    expect((await checkRepos(probes({ which: () => null }), board(), origin))[0].status).toBe('fail');
  });

  it('repos: ls-remote runs as the repo\'s gh account', async () => {
    const envs = [];
    await checkRepos(probes({ git: async (a, t, env) => { if (a.includes('ls-remote')) envs.push(env); return 'x'; } }), board(), origin);
    expect(envs).toEqual([{ GH_TOKEN: 'ghp_secret' }]);
  });

  it('port: free, held by Agent 007 (✗ only when starting), held by something else', async () => {
    expect((await checkPort(probes()))[0].status).toBe('ok');
    const ours = probes({ portState: async () => 'agent-007' });
    expect((await checkPort(ours))[0]).toMatchObject({ status: 'ok', text: expect.stringContaining('this Agent 007') });
    expect((await checkPort(ours, { starting: true }))[0].status).toBe('fail');
    expect((await checkPort(probes({ portState: async () => 'other' })))[0]).toMatchObject({ status: 'fail', fix: expect.stringContaining('--port 7008') });
  });

  it('settings: the settings line, and config.json parses / missing / broken', () => {
    expect(statuses(checkSettings(probes(), board()))).toEqual(['ok', 'ok']);
    expect(checkSettings(probes(), { missing: true, repos: [], jobs: [] })[1].status).toBe('na');
    expect(checkSettings(probes(), { error: 'Unexpected token', repos: [], jobs: [] })[1].status).toBe('fail');
  });

  it('version: latest, behind (named, not ✗), offline (–)', async () => {
    expect((await checkVersion(probes()))[0].status).toBe('ok');
    expect((await checkVersion(probes({ npmLatest: async () => '0.41.0' })))[0]).toMatchObject({ status: 'ok', text: expect.stringContaining('0.41.0 is out') });
    expect((await checkVersion(probes({ npmLatest: async () => null })))[0].status).toBe('na');
  });

  it('telegram: off, answers, rejected, unreachable; the token never shows', async () => {
    expect((await checkTelegram(probes()))[0].status).toBe('na');
    const env = { TELEGRAM_BOT_TOKEN: '123:SECRET' };
    const all = [
      await checkTelegram(probes({ env })),
      await checkTelegram(probes({ env, telegramGetMe: async () => ({ rejected: true }) })),
      await checkTelegram(probes({ env, telegramGetMe: async () => null })),
    ];
    expect(all.map(l => l[0].status)).toEqual(['ok', 'fail', 'na']);
    expect(JSON.stringify(all)).not.toContain('SECRET');
  });

  it('plugins: local registrations in a board worktree or a gone folder are ✗', () => {
    const files = { '/home/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: {
      'tg@x': [{ scope: 'local', projectPath: '/home/.agent-007/worktrees/app-1' }, { scope: 'local', projectPath: '/gone' }, { scope: 'local', projectPath: '/r/app' }],
      'p@x': [{ scope: 'user' }],
    } }) };
    const lines = checkPlugins(probes({ files }));
    expect(statuses(lines)).toEqual(['fail', 'fail']);
    expect(lines[0].fix).toMatch(/^claude plugin uninstall tg@x --scope local/);
    expect(checkPlugins(probes())[0].status).toBe('ok');
  });
});

describe('runDoctor', () => {
  it('all passing: nothing failed, report has no ✗, start prints nothing', async () => {
    const results = await runDoctor({ probes: probes() });
    expect(failed(results)).toBe(false);
    expect(formatReport(results)).not.toContain('✗');
    expect(formatStartup(results, 'agent-007 doctor')).toBe('');
  });

  it('a ✗ fails the run and prints its fix; start prints only ✗ lines and the doctor command', async () => {
    const results = await runDoctor({ probes: probes({ portState: async () => 'other' }) });
    expect(failed(results)).toBe(true);
    expect(formatReport(results)).toMatch(/✗ port 7007 is in use by another program\n {4}fix: /);
    const start = formatStartup(results, 'npm start -- doctor');
    expect(start).not.toContain('✓');
    expect(start.split('\n').at(-1)).toBe('  Run `npm start -- doctor` for details.');
  });

  it('fast runs no network check', async () => {
    const net = () => { throw new Error('network in fast mode'); };
    const results = await runDoctor({ fast: true, probes: probes({ npmLatest: net, telegramGetMe: net, ghAccounts: net, ghAccountFor: net, repoEnv: net }) });
    expect(failed(results)).toBe(false);
    expect(results.map(r => r.title)).toEqual(['Node', 'Agent CLIs', 'GitHub', 'Port', 'Settings']);
  });

  it('fast keeps to its budget and drops a check that hangs', async () => {
    const started = Date.now();
    const results = await runDoctor({ fast: true, budgetMs: 100, probes: probes({ portState: () => new Promise(() => {}) }) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(results.map(r => r.title)).not.toContain('Port');
    expect(results.map(r => r.title)).toContain('Node');
  });

  it('a check that throws is one ✗, not a crash', async () => {
    const results = await runDoctor({ probes: probes({ portState: async () => { throw new Error('boom'); } }) });
    expect(formatReport(results)).toContain('✗ Port check failed: boom');
  });
});
