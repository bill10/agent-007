import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanAgents } from '../server/agent-accounts.js';

// Synthetic files in a temp HOME and an injected exec: nothing here reads the
// real ~/.claude, ~/.codex or ~/.gemini, or runs a real CLI.
let home;
const put = (rel, text = '{}') => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), text); };
const fakeJwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'a007-accounts-')); });

const scan = (opts = {}) => scanAgents({
  env: {}, home, platform: 'linux', timeoutMs: 200,
  which: (c) => (['claude', 'codex', 'gemini', 'aider'].includes(c) ? `/bin/${c}` : null),
  run: async (file, args) => (args[0] === '--version' ? { code: 0, stdout: `${file} 1.0\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }),
  ...opts,
});

describe('scanAgents', () => {
  it('lists only the CLIs that were found, each with version and path', async () => {
    const agents = await scan();
    expect(agents.map(a => a.cli)).toEqual(['claude', 'codex', 'gemini', 'aider']);
    expect(agents.find(a => a.cli === 'aider')).toEqual({ cli: 'aider', version: '/bin/aider 1.0', path: '/bin/aider', accounts: [] });
  });

  it('reads each Claude config folder with CLAUDE_CONFIG_DIR, unset for the default', async () => {
    put('.claude/settings.json');
    put('.claude-work/.claude.json');
    put('.claude_junk/notes.txt');   // not a config dir
    put('.claude-file');             // not a dir
    const seen = [];
    const agents = await scan({
      run: async (file, args, { env }) => {
        if (args[0] !== 'auth') return { code: 0, stdout: '2.0 (Claude Code)', stderr: '' };
        seen.push(env.CLAUDE_CONFIG_DIR);
        const work = env.CLAUDE_CONFIG_DIR?.endsWith('.claude-work');
        return { code: 0, stdout: JSON.stringify({ loggedIn: !work, email: work ? null : 'a@example.com', subscriptionType: 'max', orgName: 'Org', accessToken: 'SECRET' }), stderr: 'Warning: {not json}' };
      },
    });
    const claude = agents.find(a => a.cli === 'claude');
    expect(seen.sort()).toEqual([join(home, '.claude-work'), undefined].sort());
    expect(claude.accounts).toEqual([
      { folder: join(home, '.claude'), isDefault: true, email: 'a@example.com', plan: 'max', org: 'Org', loggedIn: true },
      { folder: join(home, '.claude-work'), isDefault: false, email: null, plan: 'max', org: 'Org', loggedIn: false },
    ]);
    expect(JSON.stringify(agents)).not.toContain('SECRET');
  });

  it('marks CLAUDE_CONFIG_DIR as the default when it is set', async () => {
    put('.claude/settings.json');
    put('elsewhere/.claude.json');
    const agents = await scan({ env: { CLAUDE_CONFIG_DIR: join(home, 'elsewhere') + '/' } });
    expect(agents[0].accounts.map(a => [a.folder, a.isDefault])).toEqual([[join(home, 'elsewhere'), true], [join(home, '.claude'), false]]);
  });

  it('takes the Codex email from the id_token payload and nothing else from auth.json', async () => {
    put('.codex/auth.json', JSON.stringify({ OPENAI_API_KEY: 'sk-SECRET', tokens: { id_token: fakeJwt({ email: 'c@example.com', sub: 'SECRET' }), access_token: 'SECRET', refresh_token: 'SECRET' } }));
    put('.codex-two/auth.json', '{"tokens":{"id_token":"not-a-jwt"}}');
    put('.codex-empty/config.toml');   // no auth.json: not an account
    const agents = await scan({
      env: { CODEX_HOME: undefined },
      run: async (file, args, { env }) => (args[0] === 'login'
        ? (env.CODEX_HOME.endsWith('.codex') ? { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' } : { code: 1, stdout: 'Not logged in', stderr: '' })
        : { code: 0, stdout: 'codex-cli 0.1', stderr: '' }),
    });
    const codex = agents.find(a => a.cli === 'codex');
    expect(codex.accounts).toEqual([
      { folder: join(home, '.codex'), isDefault: true, email: 'c@example.com', plan: 'ChatGPT', org: null, loggedIn: true },
      { folder: join(home, '.codex-two'), isDefault: false, email: null, plan: null, org: null, loggedIn: false },
    ]);
    expect(JSON.stringify(agents)).not.toContain('SECRET');
  });

  it('reads the active Gemini account email only', async () => {
    put('.gemini/google_accounts.json', JSON.stringify({ active: 'g@example.com', old: ['x@example.com'] }));
    const gemini = (await scan()).find(a => a.cli === 'gemini');
    expect(gemini.accounts).toEqual([{ folder: join(home, '.gemini'), isDefault: true, email: 'g@example.com', plan: null, org: null, loggedIn: true }]);
  });

  it('still lists a CLI whose --version fails or cannot start', async () => {
    const agents = await scan({ run: async (file, args) => (file.endsWith('claude') ? { code: 2, stdout: 'boom', stderr: '' } : null) });
    expect(agents.find(a => a.cli === 'claude').version).toBeNull();
    expect(agents.find(a => a.cli === 'codex').version).toBeNull();
  });

  it('does not let a hanging CLI hold up the others', async () => {
    put('.claude/settings.json');
    const t = Date.now();
    const agents = await scan({
      run: (file, args) => (file.endsWith('claude') ? new Promise(() => {}) : Promise.resolve({ code: 0, stdout: 'ok 1', stderr: '' })),
    });
    expect(Date.now() - t).toBeLessThan(2000);
    const claude = agents.find(a => a.cli === 'claude');
    expect(claude.version).toBeNull();
    expect(claude.accounts[0].loggedIn).toBeNull();
    expect(agents.find(a => a.cli === 'codex').version).toBe('ok 1');
  });
});

describe('renderAgents (Settings panel)', () => {
  it('escapes what it shows, marks the default and skips an unknown login state', async () => {
    const { renderAgents } = await import('../public/modules/settings.js');
    const html = renderAgents([{ cli: 'claude', version: '1.0', path: '/h/.local/bin/claude', accounts: [
      { folder: '/h/.claude', isDefault: true, email: '<b>x</b>@example.com', plan: 'max', org: null, loggedIn: true },
      { folder: '/h/.claude-2', isDefault: false, email: null, plan: null, org: null, loggedIn: null },
    ] }]);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;@example.com');
    expect(html).toContain('~/.claude</span> <span class="settings-tag">default</span>');
    expect(html).toContain('~/.local/bin/claude');
    expect(renderAgents([{ cli: 'x', version: null, path: '/hx/bin/x', accounts: [{ folder: '/h/.codex', isDefault: true, email: null, plan: null, org: null, loggedIn: null }] }])).toContain('>/hx/bin/x<');
    expect(html.match(/logged in/g)).toHaveLength(1);
    expect(html).not.toContain('logged out');
  });

  it('names claude and codex when missing, with where to get them, and an installed one with no login', async () => {
    const { renderAgents } = await import('../public/modules/settings.js');
    const none = renderAgents([]);
    expect(none).toContain('No agent CLIs found on the PATH.');
    expect(none).toMatch(/claude<\/span> <span class="settings-status out">not installed/);
    expect(none).toContain('Install Codex: npm install -g @openai/codex, then restart Agent 007');
    const some = renderAgents([{ cli: 'claude', version: '1.0', path: '/h/bin/claude', accounts: [] }]);
    expect(some).toContain('no login found');
    expect(some).not.toMatch(/claude<\/span> <span class="settings-status out">not installed/);
    expect(some).toMatch(/codex<\/span> <span class="settings-status out">not installed/);
  });
});
