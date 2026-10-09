import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseListing, probeListing, refreshListing, currentListing } from '../server/skill-listing.js';
import { reportUngrouped } from '../server/skill-families.js';
import { removeTempDir } from './temp-dir.js';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'skill-probe-request.json'), 'utf8');
let root, file;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'a007-listing-')); file = join(root, 'skill-listing.json'); });
afterEach(() => removeTempDir(root));

describe('the captured request', () => {
  it('gives every listed skill with its description, a later line included and a bare name kept', () => {
    const skills = parseListing(FIXTURE);
    expect(skills.map(s => s.name)).toEqual(['copywriting', 'hyperframes-cli', 'ship', 'ponytail:ponytail', 'dataviz',
      'code-review', 'loop', 'claude-api', 'anthropic-skills:pdf', 'name-only-skill']);
    expect(skills.find(s => s.name === 'claude-api').description).toMatch(/model migration\. TRIGGER — read BEFORE .* SKIP only when/);
    expect(skills.at(-1).description).toBe('');
    expect(parseListing('{"messages":[{"role":"user","content":"hi"}]}')).toBeNull();
    expect(parseListing('not json')).toBeNull();
  });
});

// A stand-in `claude` that posts the fixture to ANTHROPIC_BASE_URL with a key header.
const fakeClaude = (body) => {
  const bin = join(root, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
};
const POST = `const s = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]);
fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST',
  headers: { 'x-api-key': 'sk-ant-REAL-SECRET', authorization: 'Bearer REAL-OAUTH' },
  body: require('fs').readFileSync(${JSON.stringify(join(import.meta.dirname, 'fixtures', 'skill-probe-request.json'))}) })
  .then(() => setTimeout(() => {}, 60000));
if (s.env.ANTHROPIC_BASE_URL !== process.env.ANTHROPIC_BASE_URL || !process.env.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:')) process.exit(3);
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) process.exit(4);`;

describe.skipIf(process.platform === 'win32')('the probe', () => {
  it('reads the listing from a loopback request and keeps nothing of its headers', async () => {
    const skills = await probeListing({ file: fakeClaude(POST), env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'REAL-OAUTH' } });
    expect(skills.map(s => s.name)).toContain('dataviz');
    const state = await refreshListing({ file, version: async () => '9.9.9 (Claude Code)', probe: async () => skills });
    expect(JSON.stringify(state)).not.toMatch(/SECRET|OAUTH|api-key|authorization/i);
    expect(readFileSync(file, 'utf8')).not.toMatch(/SECRET|OAUTH|api-key|authorization/i);
  });

  it('fails with why: claude missing, gone without a request, or too slow', async () => {
    await expect(probeListing({ file: join(root, 'no-claude') })).rejects.toThrow(/not installed/);
    await expect(probeListing({ file: fakeClaude('process.exit(2)') })).rejects.toThrow(/exited \(2\) without sending/);
    await expect(probeListing({ file: fakeClaude('setTimeout(() => {}, 60000)'), timeoutMs: 300 })).rejects.toThrow(/within 0 s/);
  });
});

describe('the version-keyed cache', () => {
  it('probes once per version, retries a failure only on a new version, and tells Billion once why', async () => {
    let version = '1.0.0 (Claude Code)';
    let probes = 0;
    let fail = false;
    const opts = () => ({ file, version: async () => version, probe: async () => { probes++; if (fail) throw new Error('timed out'); return [{ name: 'dataviz', description: 'Charts.' }]; } });
    expect((await refreshListing(opts())).skills).toHaveLength(1);
    await refreshListing(opts());
    expect(probes).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version, skills: [{ name: 'dataviz', description: 'Charts.' }] });

    version = '1.1.0 (Claude Code)';
    fail = true;
    expect(await refreshListing(opts())).toEqual({ version, error: 'timed out' });
    await refreshListing(opts());
    expect(probes).toBe(2);
    expect(currentListing(file).error).toBe('timed out');
    const sent = [];
    const send = (session, headline, lines) => { sent.push(headline, ...lines); return true; };
    reportUngrouped({ id: 'b' }, send);
    reportUngrouped({ id: 'b' }, send);
    expect(sent.filter(l => l.startsWith('No built-in skill family'))).toHaveLength(1);
    expect(sent).toContain('Why: timed out.');

    // Back to a version cached on disk: no probe.
    version = '1.0.0 (Claude Code)';
    expect((await refreshListing(opts())).skills).toHaveLength(1);
    expect(probes).toBe(2);
  });
});
