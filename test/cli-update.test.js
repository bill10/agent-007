// Settings' agent CLI versions and Update (server/cli-update.js), with a fake
// registry and a fake execFile: no network, no real `<cli> update`.
import { describe, it, expect, beforeEach } from 'vitest';
import { cliUpdates, startCliUpdate, versionOf, resetCliUpdates } from '../server/cli-update.js';

const agents = [
  { cli: 'claude', version: '2.1.295 (Claude Code)', path: '/bin/claude' },
  { cli: 'codex', version: 'codex-cli 0.157.0', path: '/bin/codex' },
  { cli: 'gemini', version: '0.1.0', path: '/bin/gemini' },
];
const fetchLatest = async (pkg) => ({ '@anthropic-ai/claude-code': '2.1.300', '@openai/codex': '0.157.0' })[pkg];

beforeEach(() => resetCliUpdates());

describe('agent CLI updates', () => {
  it('reads each CLI version off its --version line', () => {
    expect(versionOf('2.1.295 (Claude Code)')).toBe('2.1.295');
    expect(versionOf('codex-cli 0.157.0')).toBe('0.157.0');
    expect(versionOf(null)).toBeNull();
  });

  it('pairs the installed claude and codex with npm\'s latest, and nothing else', async () => {
    expect(await cliUpdates(agents, { fetchLatest })).toEqual({
      claude: { version: '2.1.295', latest: '2.1.300' },
      codex: { version: '0.157.0', latest: '0.157.0' },
    });
    expect(await cliUpdates([], { fetchLatest })).toEqual({});
  });

  it('runs the CLI\'s own `update`, one at a time, and reports how it ended', async () => {
    let done;
    const calls = [];
    const execFile = (file, args, opts, cb) => { calls.push([file, args]); done = cb; return { stdin: { end() {} } }; };
    expect(startCliUpdate('codex', agents, { execFile })).toEqual({ ok: true });
    expect(calls).toEqual([['/bin/codex', ['update']]]);
    expect(startCliUpdate('codex', agents, { execFile }).error).toMatch(/already updating/);
    expect((await cliUpdates(agents, { fetchLatest })).codex.updating).toBe(true);
    done(null, 'Updated to 0.158.0\n', '');
    expect((await cliUpdates(agents, { fetchLatest })).codex.finished).toEqual({ code: 0, log: 'Updated to 0.158.0' });
    // A failure keeps its last lines for the panel.
    startCliUpdate('claude', agents, { execFile });
    done(Object.assign(new Error('exit 1'), { code: 1 }), '', 'EACCES: permission denied');
    expect((await cliUpdates(agents, { fetchLatest })).claude.finished).toEqual({ code: 1, log: 'EACCES: permission denied' });
  });

  it('refuses a CLI it does not update or that is not installed', () => {
    const execFile = () => { throw new Error('must not run'); };
    expect(startCliUpdate('gemini', agents, { execFile }).error).toMatch(/Unknown CLI/);
    expect(startCliUpdate('__proto__', agents, { execFile }).error).toMatch(/Unknown CLI/);
    expect(startCliUpdate('codex', [], { execFile }).error).toMatch(/not installed/);
  });
});
