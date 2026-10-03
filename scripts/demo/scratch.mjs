// The scratch server the demo recorders run against: a temp HOME with its own
// AGENT007_CONFIG_DIR, a `shop` repo with a remote, the stubs in
// scripts/demo/bin on PATH and an allowlisted env, so nothing real is spent,
// nothing of the host's own setup is read, and every run plays the same.
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function startScratchServer({ port, env: extra = {} }) {
  // Real path: macOS's tmpdir is a symlink, and the board would list the repo twice.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'a007-demo-')));
  const url = `http://127.0.0.1:${port}`;

  // A repo with a remote, as a real project would have. The remote's path says
  // github, so cards don't warn that they can't open a pull request.
  const repo = join(home, 'code', 'shop');
  const remote = join(home, 'github.com', 'acme', 'shop.git');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  writeFileSync(join(repo, 'README.md'), '# shop\n');
  git('add', '-A');
  git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'first');
  mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');

  const configDir = join(home, '.agent-007');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(home, '.claude.json'), '{}');   // what the board pre-trusts worktrees in
  // A ship skill for the stub claude, or every card warns it has none.
  mkdirSync(join(home, '.claude', 'skills', 'ship'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'ship', 'SKILL.md'), '---\nname: ship\ndescription: Stand-in for the demo.\n---\n');
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    version: 1, repos: [{ path: repo, addedAt: new Date().toISOString() }], orphans: [], activeSessions: [], jobs: [],
    // A fast scan, so a merged PR's card files away in seconds rather than minutes.
    jobBoard: { running: true, intervalMs: 2000 },
  }));

  // Nothing of the host's own setup: no tokens, no Telegram, no config dirs,
  // no .env (the server runs from the scratch HOME), only what a shell needs.
  const keep = ['PATH', 'TERM', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'];
  const env = Object.fromEntries(keep.filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, {
    HOME: home, AGENT007_CONFIG_DIR: configDir, PORT: String(port), HOST: '127.0.0.1',
    PATH: `${join(root, 'scripts/demo/bin')}:${env.PATH}`,
    GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com',
    ...extra,
  });
  // Something else on the port would be what gets recorded.
  if (await fetch(url).then(() => true, () => false)) throw new Error(`${url} is already taken`);
  const server = spawn(process.execPath, [join(root, 'bin/agent-007.js')], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(process.stdout);
  server.stderr.pipe(process.stderr);
  process.on('exit', () => server.kill());
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw new Error('server exited');
    try { await fetch(url); break; } catch { if (i > 100) throw new Error('server did not start'); await sleep(100); }
  }
  if (process.env.DEMO_SERVE) { console.log(`Serving ${url} from ${home}`); await new Promise(() => {}); }
  return { home, url, server };
}
