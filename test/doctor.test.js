import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'http';
import { createServer } from 'net';
import { join, posix, win32 } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { telegramGetMe } from '../server/owner.js';
import {
  portState, runDoctor, failed, formatReport, formatStartup, versionAtLeast,
  insideDir, checkNode, checkClis, checkGh, checkRepos, checkPort, checkSettings, checkVersion, checkTelegram, checkPlugins, checkSkills, toNpm, fromNpm,
} from '../server/doctor.js';

// A machine where everything passes; each test breaks one thing. No real CLI,
// git or network is touched; only the portState tests open loopback sockets.
const CONFIG = '/cfg/config.json';
// A home with a working ship skill for each CLI (symlinked, as gstack does).
function skillHome({ claude = true, codex = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'doctor-skills-'));
  const real = join(home, 'gstack-src');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'SKILL.md'), '---\nname: ship\n---\nbody\n');
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  mkdirSync(join(home, '.codex/skills'), { recursive: true });
  if (claude) symlinkSync(real, join(home, '.claude/skills/ship'));
  if (codex) symlinkSync(real, join(home, '.codex/skills/gstack-ship'));
  return { claudeDir: join(home, '.claude'), codexDir: join(home, '.codex'), agentsDir: join(home, '.agents'), home };
}
// Joined as checkPlugins joins it (backslashes on Windows).
const PLUGINS = join('/home/.claude', 'plugins', 'installed_plugins.json');
function probes(over = {}) {
  const files = {
    [CONFIG]: JSON.stringify({ repos: [{ path: '/r/app' }], jobs: [{ state: 'todo', agent: 'codex', repoPath: '/r/app' }, { state: 'done', agent: 'claude' }] }),
    [PLUGINS]: JSON.stringify({ plugins: {} }),
    ...over.files,
  };
  return {
    env: {},
    nodeVersion: '22.1.0',
    engines: '>=20.12',
    version: '0.40.1.0',
    loadPty: async () => ({}),
    which: (c) => `/bin/${c}`,
    scanAgents: async () => ['claude', 'codex'].map(cli => ({ cli, version: '1.0', path: `/bin/${cli}`, accounts: [{ isDefault: true, loggedIn: true }] })),
    billionAgent: () => 'claude',
    billionRuns: () => true,
    ghAccounts: async () => ['alice', 'bob'],
    ghAccountFor: async () => ({ login: 'bob', token: 'ghp_secret' }),
    git: async (args) => (args.includes('get-url') ? 'git@github.com:acme/app.git\n' : args.includes('ls-remote') ? 'abc\trefs/heads/main\n' : '.git'),
    repoEnv: (account) => ({ GH_TOKEN: account.token }),
    baseBranch: async () => 'main',
    exists: (p) => p in files || p.startsWith('/r/') || p.startsWith('/home/'),
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    port: 7007,
    host: '127.0.0.1',
    portState: async () => 'free',
    configPath: CONFIG,
    worktreeDir: '/home/.agent-007/worktrees',
    claudeDir: '/home/.claude',
    ...skillHome(),
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
    const scan = async () => ['claude', 'codex'].map(cli => ({ cli, version: '1', path: `/bin/${cli}`, accounts: [{ isDefault: true, loggedIn: false }] }));
    const [claude, codex] = await checkClis(probes({ scanAgents: scan }), board());
    expect(claude).toMatchObject({ status: 'fail', fix: 'claude auth login' });
    expect(codex).toMatchObject({ status: 'fail', fix: 'codex login' });
  });

  it('gh: per-repo account, ✗ when none can see it, never a token', async () => {
    const lines = await checkGh(probes(), board(), origin);
    expect(statuses(lines)).toEqual(['ok', 'ok']);
    expect(lines[1].text).toBe('acme/app: board workers use bob');
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
    expect(envs).toEqual([{ GH_TOKEN: 'ghp_secret', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' }]);
    // No ssh command of the owner's (core.sshCommand unset): ssh is told not to prompt.
    const batch = [];
    const unset = async (a, t, env) => { if (a.includes('config')) throw new Error('unset'); if (a.includes('ls-remote')) batch.push(env.GIT_SSH_COMMAND); return 'x'; };
    await checkRepos(probes({ git: unset }), board(), origin);
    await checkRepos(probes({ git: unset, env: { GIT_SSH_COMMAND: 'ssh -i k' } }), board(), origin);
    await checkRepos(probes({ git: unset, env: { GIT_SSH: '/usr/bin/plink' } }), board(), origin);
    expect(batch).toEqual(['ssh -o BatchMode=yes', undefined, undefined]);
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
    // Value: protects=VERSION compared in npm's A.B.(C*1000+D) form; fails_when=0.40.1.0 reads as behind npm's 0.40.1000; why_new=release encoding; seam=none
    expect(toNpm('0.40.1.0')).toBe('0.40.1000');
    expect(fromNpm('0.40.1002')).toBe('0.40.1.2');
    expect((await checkVersion(probes({ npmLatest: async () => '0.40.1000' })))[0].text).toBe('version 0.40.1.0, the latest');
    expect((await checkVersion(probes({ npmLatest: async () => '0.41.0' })))[0]).toMatchObject({ status: 'ok', text: expect.stringContaining('0.41.0.0 is out') });
    expect((await checkVersion(probes({ npmLatest: async () => '0.40.1001' })))[0].text).toContain('0.40.1.1 is out');
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
    const files = { [PLUGINS]: JSON.stringify({ plugins: {
      // worktrees-old sits beside the worktree folder, not in it.
      'tg@x': [{ scope: 'local', projectPath: '/home/.agent-007/worktrees/app-1' }, { scope: 'local', projectPath: '/gone' }, { scope: 'local', projectPath: '/r/app' }, { scope: 'local', projectPath: '/home/.agent-007/worktrees-old/app' }],
      'p@x': [{ scope: 'user' }],
    } }) };
    const lines = checkPlugins(probes({ files, claudeDir: '/home/.claude' }));
    expect(statuses(lines)).toEqual(['fail', 'fail']);
    expect(lines[0].fix).toMatch(/^cd \/home\/\.agent-007\/worktrees\/app-1 && claude plugin uninstall tg@x --scope local/);
    // A gone folder is made again for the uninstall, which applies where it runs.
    expect(lines[1].fix).toMatch(/^mkdir -p \/gone && cd \/gone && claude plugin uninstall tg@x --scope local && rmdir \/gone/);
    expect(checkPlugins(probes({ claudeDir: '/home/.claude' }))[0].status).toBe('ok');
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
    expect(results.map(r => r.title)).toEqual(['Node', 'Agent CLIs', 'GitHub', 'Skills', 'Port', 'Settings']);
  });

  it('fast keeps to its budget and drops a check that hangs', async () => {
    const started = Date.now();
    const results = await runDoctor({ fast: true, budgetMs: 300, probes: probes({ portState: () => new Promise(() => {}) }) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(results.map(r => r.title)).not.toContain('Port');
    expect(results.map(r => r.title)).toContain('Node');
  });

  it('a check that throws is one ✗, not a crash', async () => {
    const results = await runDoctor({ probes: probes({ portState: async () => { throw new Error('boom'); } }) });
    expect(formatReport(results)).toContain('✗ Port check failed: boom');
  });
});

describe('doctor gaps', () => {
  // Value: protects=readBoard (done cards ignored, card repos merged and deduped, broken JSON is ✗ not a crash); fails_when=the done filter, dedupe or parse catch is dropped; why_new=checkSettings was only fed hand-built boards; seam=none
  it('reads config.json: done cards ignored, card repos merged, broken JSON is a Settings ✗', async () => {
    const files = { [CONFIG]: JSON.stringify({
      repos: [{ path: '/r/app' }],
      jobs: [{ state: 'todo', agent: 'codex', repoPath: '/r/app' }, { state: 'todo', agent: 'codex', repoPath: '/r/lib' }, { state: 'done', agent: 'claude', repoPath: '/r/old' }],
    }) };
    const ok = await runDoctor({ probes: probes({ files, billionRuns: () => false }) });
    const by = (rs, t) => rs.find(r => r.title === t).lines;
    expect(by(ok, 'Settings')[1].text).toMatch(/parses \(2 repos, 2 open cards\)/);
    expect(by(ok, 'Agent CLIs')[0].status).toBe('ok');
    const noClaude = await runDoctor({ probes: probes({ files, billionRuns: () => false, scanAgents: async () => [] }) });
    expect(statuses(by(noClaude, 'Agent CLIs'))).toEqual(['na', 'fail']);
    const broken = await runDoctor({ probes: probes({ files: { [CONFIG]: '{nope' } }) });
    expect(by(broken, 'Settings')[1]).toMatchObject({ status: 'fail', text: expect.stringContaining('does not parse') });
    expect(failed(broken)).toBe(true);
  });

  // Value: protects=fast run passes starting=true to checkPort; fails_when=a start no longer warns that another Agent 007 holds the port (or doctor wrongly ✗s its own server); why_new=checkPort was only called directly; seam=none
  it('another Agent 007 on the port is ✗ at start, ✓ under doctor', async () => {
    const p = probes({ portState: async () => 'agent-007' });
    const start = await runDoctor({ fast: true, probes: p });
    expect(formatStartup(start, 'agent-007 doctor')).toContain('held by another Agent 007');
    expect(failed(await runDoctor({ probes: p }))).toBe(false);
  });

  // Value: protects=checkRepos unreachable-origin branch, non-GitHub remote skipping gh env, base-branch fallback; fails_when=stderr is dropped, gh token is asked for a non-GitHub remote, or a baseBranch error crashes the check; why_new=no test hit the catch or the non-GitHub path; seam=none
  it('repos: unreachable origin shows stderr; non-GitHub remote runs without gh env; base falls back to main', async () => {
    const err = Object.assign(new Error('Command failed'), { stderr: 'fatal: could not read Username\nmore' });
    const [, down] = await checkRepos(probes({ git: async (a) => { if (a.includes('ls-remote')) throw err; return '.git'; } }), board(), origin);
    expect(down).toMatchObject({ status: 'fail', text: '/r/app: could not reach origin (fatal: could not read Username)' });
    // Value: protects=no token in a git error reaches the screen; fails_when=the userinfo redaction is dropped; why_new=only plain stderr was covered; seam=none
    // Assembled, so no literal credential URL sits in the repo for secret scanners.
    const leak = Object.assign(new Error('x'), { stderr: `fatal: unable to access 'https://${['bob', 'ghp_secret'].join(':')}@github.com/acme/app.git/'` });
    const [, redacted] = await checkRepos(probes({ git: async (a) => { if (a.includes('ls-remote')) throw leak; return '.git'; } }), board(), origin);
    expect(redacted.text).toContain('https://***@github.com/acme/app.git');
    expect(redacted.text).not.toContain('ghp_secret');
    const envs = []; const heads = [];
    const plain = probes({
      repoEnv: () => { throw new Error('asked gh for a non-GitHub repo'); },
      baseBranch: async () => { throw new Error('no base'); },
      git: async (a, t, env) => { if (a.includes('ls-remote')) { envs.push(env); heads.push(a.at(-1)); } return 'x'; },
    });
    const [, line] = await checkRepos(plain, board(), async () => 'git@gitlab.com:acme/app.git');
    // No base branch known: any branch on origin will do, as the board branches from HEAD.
    expect(line).toMatchObject({ status: 'ok', text: '/r/app: origin has branches' });
    expect(envs).toEqual([{ GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' }]);
    expect(heads).toEqual(['origin']);
  });

  // Value: protects=checkClis unknown-login and unused-logged-out branches; fails_when=an unknown login turns into ✗ or an unused logged-out CLI fails the run; why_new=only loggedIn true/false-and-used were covered; seam=none
  it('clis: login unknown is ✗ when used, – when not; logged out but unused is –', async () => {
    const scan = (loggedIn) => async () => ['claude', 'codex'].map(cli => ({ cli, path: `/bin/${cli}`, accounts: [{ isDefault: true, loggedIn }] }));
    const [unknown] = await checkClis(probes({ scanAgents: scan(null) }), board());
    expect(unknown).toMatchObject({ status: 'fail', text: expect.stringContaining('(version unknown)'), fix: 'claude auth status' });
    expect(unknown.text).toContain('could not tell whether it is logged in');
    const idle = await checkClis(probes({ scanAgents: scan(null), billionRuns: () => false }), board({ jobs: [] }));
    expect(idle[0]).toMatchObject({ status: 'na', text: expect.stringContaining('login not known') });
    const unused = await checkClis(probes({ scanAgents: scan(false), billionRuns: () => false }), board({ jobs: [] }));
    expect(statuses(unused)).toEqual(['na', 'na']);
  });

  // Value: protects=checkGh catch on ghAccountFor and checkPlugins unreadable-file path; fails_when=a rejecting gh lookup crashes the GitHub check or a missing plugins file becomes ✗; why_new=neither error path was exercised; seam=none
  it('gh: a lookup that rejects is a per-repo ✗; plugins: no registrations file is –', async () => {
    const lines = await checkGh(probes({ ghAccountFor: async () => { throw new Error('rate limited'); } }), board(), origin);
    expect(statuses(lines)).toEqual(['ok', 'fail']);
    expect(lines[1].text).toBe('acme/app: no signed-in gh account can see it');
    expect(checkPlugins(probes({ claudeDir: '/elsewhere' }))).toEqual([{ status: 'na', text: 'no Claude Code plugin registrations' }]);
  });
});

describe('doctor review follow-ups', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Value: protects=no gh credentials asked for when gh is absent; fails_when=the which('gh') guard goes; why_new=only gh-present was covered; seam=none
  it('repos: a GitHub remote without gh runs ls-remote with no gh env', async () => {
    const envs = [];
    const p = probes({
      which: (c) => (c === 'gh' ? null : `/bin/${c}`),
      repoEnv: () => { throw new Error('asked gh without gh'); },
      git: async (a, t, env) => { if (a.includes('ls-remote')) envs.push(env); return 'x'; },
    });
    expect((await checkRepos(p, board(), origin))[1].status).toBe('ok');
    expect(envs).toEqual([{ GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' }]);
  });

  // Value: protects=one account walk per repo shared by GitHub and Repos; fails_when=each check walks again; why_new=the walk asks GitHub per account; seam=none
  it('the account walk runs once per repo across checks', async () => {
    const walked = [];
    await runDoctor({ probes: probes({ ghAccountFor: async (r) => { walked.push(r); return { login: 'bob', token: 't' }; } }) });
    expect(walked).toEqual(['/r/app']);
  });

  // Value: protects=a port that cannot be listened on is named as such; fails_when=EACCES reads as "in use"; why_new=new state; seam=none
  it('port: a listen error other than in-use says so', async () => {
    const [line] = await checkPort(probes({ portState: async () => 'EACCES' }));
    expect(line).toMatchObject({ status: 'fail', text: 'cannot listen on 127.0.0.1 port 7007 (EACCES)' });
  });

  // Value: protects=the real port probe (free / ours by page title / other); fails_when=the title match or the in-use branch changes; why_new=every other test stubs it; seam=none
  it('portState tells free, Agent 007 and another program apart on loopback', async () => {
    const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
    const ours = createHttpServer((req, res) => res.end('<html><title>Agent 007</title></html>'));
    const sockets = [];
    const other = createServer((sock) => sockets.push(sock));
    const [a, b] = [await listen(ours), await listen(other)];
    try {
      expect(await portState(a, '127.0.0.1')).toBe('agent-007');
      expect(await portState(b, '127.0.0.1')).toBe('other');
    } finally {
      ours.closeAllConnections();
      sockets.forEach(sock => sock.destroy());
      await Promise.all([new Promise(r => ours.close(r)), new Promise(r => other.close(r))]);
    }
    expect(await portState(b, '127.0.0.1')).toBe('free');
  });

  // Value: protects=only 401/404 count as a rejected token; fails_when=a 429 or 5xx fails the doctor run; why_new=getMe was stubbed everywhere; seam=none
  it('telegramGetMe: answers, rejected on 401/404, unknown otherwise, never the token', async () => {
    const env = { TELEGRAM_BOT_TOKEN: '123:SECRET' };
    const reply = (status, body) => vi.stubGlobal('fetch', vi.fn(async () => ({ status, json: async () => body })));
    reply(200, { ok: true, result: { username: 'my_bot' } });
    expect(await telegramGetMe(env)).toEqual({ username: 'my_bot' });
    reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    expect(await telegramGetMe(env)).toEqual({ rejected: true });
    reply(429, { ok: false, error_code: 429, description: 'Too Many Requests' });
    expect(await telegramGetMe(env)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed for https://api.telegram.org/bot123:SECRET/getMe'); }));
    expect(await telegramGetMe(env)).toBeNull();
  });

  // Value: protects=gh not needed without a GitHub repo; fails_when=a GitLab-only board fails on a signed-out gh; why_new=reviewers found it; seam=none
  it('gh: signed out is – when no board repo is on GitHub', async () => {
    const lines = await checkGh(probes({ ghAccounts: async () => [] }), board(), async () => 'git@gitlab.com:acme/app.git');
    expect(lines).toEqual([{ status: 'na', text: 'gh installed (no GitHub repo on the board)' }]);
  });

  // Value: protects=local-only repos pass unless a PR card needs a remote; fails_when=every local repo fails doctor; why_new=reviewers found it; seam=none
  it('repos: no origin is – unless a card on it needs a pull request', async () => {
    const none = async () => null;
    expect((await checkRepos(probes(), board({ jobs: [{ state: 'todo', repoPath: '/r/app', requiresPr: false }] }), none))[1].status).toBe('na');
    expect((await checkRepos(probes(), board({ jobs: [{ state: 'todo', repoPath: '/r/app' }] }), none))[1]).toMatchObject({ status: 'fail', text: expect.stringContaining('needs a pull request') });
  });

  // Value: protects=fix lines that paste into a shell, and the right place to remove a repo; fails_when=a spaced path splits, or a card-only repo points at the Explorer; why_new=reviewers found it; seam=none
  it('repos: fix lines quote a path with spaces; a repo only cards name points at the cards', async () => {
    const spaced = '/r/My Project';
    const [, line] = await checkRepos(probes({ git: async (a) => { if (a.includes('rev-parse')) throw new Error('no'); return ''; } }), board({ repos: [spaced] }), origin);
    expect(line.fix).toBe(`git -C '${spaced}' status`);
    // Nothing in a pasted path expands: $, backticks and quotes stay literal.
    const odd = "/r/it's $HOME `x`";
    const [, oddLine] = await checkRepos(probes({ git: async (a) => { if (a.includes('rev-parse')) throw new Error('no'); return ''; } }), board({ repos: [odd] }), origin);
    expect(oddLine.fix).toBe("git -C '/r/it'\\''s $HOME `x`' status");
    const gone = probes({ exists: () => false });
    expect((await checkRepos(gone, board({ explorer: new Set(['/r/app']) }), origin))[1].fix).toMatch(/Explorer/);
    expect((await checkRepos(gone, board({ explorer: new Set() }), origin))[1].fix).toMatch(/board cards that name it/);
  });

  // Value: protects=no config.json text in the report; fails_when=V8's quoted snippet is printed; why_new=both adversarial reviews; seam=none
  it('a broken config.json is named by position only, never its text', async () => {
    const results = await runDoctor({ probes: probes({ files: { [CONFIG]: '{"token": ghp_SECRETSECRET' } }) });
    const report = formatReport(results);
    expect(report).toMatch(/config\.json does not parse: not valid JSON/);
    expect(report).not.toContain('SECRET');
  });

  // Value: protects=the worktree-folder test on Windows paths; fails_when=containment goes back to a case- and slash-sensitive prefix; why_new=Windows CI; seam=none
  it('insideDir: inside, the folder itself, a sibling, and Windows case and slashes', () => {
    expect(insideDir('/a/worktrees', '/a/worktrees/app-1', posix)).toBe(true);
    expect(insideDir('/a/worktrees', '/a/worktrees', posix)).toBe(true);
    expect(insideDir('/a/worktrees', '/a/worktrees-old/app', posix)).toBe(false);
    expect(insideDir('/a/worktrees', '/a', posix)).toBe(false);
    const wt = 'C:\\Users\\Me\\.agent-007\\worktrees';
    expect(insideDir(wt, 'c:\\users\\me\\.agent-007\\worktrees\\app-1', win32)).toBe(true);
    expect(insideDir(wt, 'C:/Users/Me/.agent-007/worktrees/app-1', win32)).toBe(true);
    expect(insideDir(wt, 'C:\\Users\\Me\\.agent-007\\worktrees-old\\app', win32)).toBe(false);
    expect(insideDir(wt, 'D:\\Users\\Me\\.agent-007\\worktrees\\app-1', win32)).toBe(false);
  });
});

describe('doctor skills', () => {
  const codexBoard = { jobs: [{ state: 'todo', agent: 'codex' }] };
  const idle = { billionRuns: () => false };

  it('a symlinked ship skill passes for each CLI, codex under its gstack-ship name', () => {
    const lines = checkSkills(probes(), codexBoard);
    expect(statuses(lines.slice(0, 2))).toEqual(['ok', 'ok']);
  });

  it('no gstack is ✗ only for a CLI that is used for a PR card', () => {
    const p = probes({ ...skillHome({ claude: false, codex: false }), ...idle });
    const used = checkSkills(p, codexBoard);
    expect(used[0].status).toBe('na');
    expect(used[1]).toMatchObject({ status: 'fail', fix: expect.stringContaining('setup --host codex') });
    expect(used[1].fix).toContain('https://github.com/garrytan/gstack');
    expect(checkSkills(p, { jobs: [{ state: 'todo', agent: 'codex', requiresPr: false }] })[1].status).toBe('na');
    expect(checkSkills(p, { jobs: [] })[1].status).toBe('na');
  });

  it('a dangling link is ✗ and is never deleted', () => {
    const h = skillHome();
    symlinkSync(join(h.home, 'gone'), join(h.codexDir, 'skills/gstack-qa'));
    const lines = checkSkills(probes({ ...h, ...idle }), { jobs: [] });
    const bad = lines.find(l => l.status === 'fail');
    expect(bad.text).toMatch(/^1 skill in .*skills is a broken link \(e\.g\. gstack-qa → /);
    expect(bad.fix).toContain('setup --host codex');
    expect(checkSkills(probes({ ...h, ...idle }), { jobs: [] }).filter(l => l.status === 'fail')).toHaveLength(1);
  });

  it('agent-browser is ✓ or –, never ✗', () => {
    const last = (which) => checkSkills(probes({ which }), { jobs: [] }).at(-1);
    expect(last((c) => `/bin/${c}`).status).toBe('ok');
    expect(last(() => null).status).toBe('na');
  });

  it('the fast run includes the skills check', async () => {
    const results = await runDoctor({ fast: true, probes: probes() });
    expect(results.map(r => r.title)).toContain('Skills');
  });
});
