import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { configDir, settingsLine } from '../server/settings.js';

function run(args) {
  try {
    return { code: 0, out: execFileSync('node', ['bin/agent-007.js', ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

const VERSION = readFileSync('VERSION', 'utf8').trim();

describe('agent-007 CLI', () => {
  it('--help prints usage and exits 0', () => {
    const { code, out } = run(['--help']);
    expect(code).toBe(0);
    expect(out).toMatch(/Usage: agent-007/);
  });

  it('--version prints VERSION', () => {
    expect(run(['--version'])).toEqual({ code: 0, out: `${VERSION}\n` });
  });

  it('rejects a bad port, an unknown flag and an unknown command without starting', () => {
    for (const args of [['--port', 'abc'], ['--port', '70000'], ['--nope'], ['serve']]) {
      expect(run(args).code).toBe(2);
    }
  });
});

// CONTRIBUTING.md "Versions": package.json carries VERSION's first three
// parts (npm needs semver). .github/workflows/release.yml checks the same.
describe('package.json version', () => {
  it('is VERSION without its MICRO part', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.version).toBe(VERSION.split('.').slice(0, 3).join('.'));
  });
});

// Settings files (server/settings.js). Every test gets its own HOME, config
// dir and working directory, never the real ~/.agent-007.
describe('settings', () => {
  const ROOT = process.cwd();
  let home, cfg, cwd;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'a007-home-'));
    cfg = join(home, '.agent-007');
    cwd = mkdtempSync(join(tmpdir(), 'a007-cwd-'));
    mkdirSync(cfg);
  });
  const env = (extra = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, AGENT007_CONFIG_DIR: cfg, ...extra });
  const cli = (args, extra) => {
    try {
      return { code: 0, out: execFileSync('node', [join(ROOT, 'bin/agent-007.js'), ...args], { cwd, env: env(extra), encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { code: err.status, out: err.stdout + err.stderr };
    }
  };

  it('--help lists init and every setting .env.example documents', () => {
    const { out } = run(['--help']);
    expect(out).toMatch(/agent-007 init/);
    const keys = [...readFileSync('.env.example', 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(out).toContain(key);
  });

  it('init writes .env.example, all commented out, and never overwrites', () => {
    const file = join(cfg, '.env');
    const first = cli(['init']);
    expect(first.code).toBe(0);
    expect(first.out).toContain(file);
    const template = readFileSync('.env.example', 'utf8');
    expect(readFileSync(file, 'utf8')).toBe(template);
    expect(template.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'))).toEqual([]);

    writeFileSync(file, 'BILLION=0\n');
    const second = cli(['init']);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/already exists/);
    expect(second.out).toContain(file);
    expect(readFileSync(file, 'utf8')).toBe('BILLION=0\n');
  });

  it('environment > ./.env > config-dir .env', () => {
    writeFileSync(join(cwd, '.env'), 'A=cwd\nB=cwd\n');
    writeFileSync(join(cfg, '.env'), 'A=cfg\nB=cfg\nC=cfg\n');
    const script = `import { loadSettings } from ${JSON.stringify(pathToFileURL(join(ROOT, 'server/settings.js')).href)};
      const files = loadSettings(); const { A, B, C } = process.env; console.log(JSON.stringify({ files, A, B, C }));`;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { cwd, env: env({ A: 'env' }), encoding: 'utf8' });
    const { files, ...vars } = JSON.parse(out);
    expect(vars).toEqual({ A: 'env', B: 'cwd', C: 'cfg' });
    // cwd as the child saw it (a macOS /private/var or a Windows 8.3 path).
    expect(files).toEqual([expect.stringMatching(/[\\/]a007-cwd-[^\\/]+[\\/]\.env$/), join(cfg, '.env')]);
  });

  it('the startup line names the loaded files, or says how to create one', () => {
    expect(settingsLine([], 'npx @bill10/agent-007 init'))
      .toBe(`Settings: defaults (run \`npx @bill10/agent-007 init\` to create ${join(configDir(), '.env').replace(homedir(), '~')})`);
    expect(settingsLine([join(homedir(), '.agent-007', '.env'), '/w/.env'], 'x'))
      .toBe(`Settings: ${join('~', '.agent-007', '.env')}, /w/.env`);
  });

  it('--port beats the environment and both files; the server says which files it loaded', async () => {
    const port = await new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
    writeFileSync(join(cwd, '.env'), 'PORT=1\n');
    writeFileSync(join(cfg, '.env'), 'PORT=2\n');
    const child = spawn('node', [join(ROOT, 'bin/agent-007.js'), '--port', String(port)], { cwd, env: env({ PORT: '3', BILLION: '0' }) });
    let out = '';
    try {
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`no startup line:\n${out}`)), 20000);
        const onData = (d) => { out += d; if (out.includes('is running at')) { clearTimeout(timer); res(); } };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', () => { clearTimeout(timer); rej(new Error(`exited:\n${out}`)); });
      });
    } finally {
      child.kill();
    }
    expect(out).toMatch(new RegExp(`Settings: \\S*a007-cwd-\\S+\\.env, ~[\\\\/]\\.agent-007[\\\\/]\\.env\\n`));
    expect(out).toContain(`http://127.0.0.1:${port}`);
  }, 30000);
});
