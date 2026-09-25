import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

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
