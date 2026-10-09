import { describe, it, expect, vi } from 'vitest';
import { resumeClaudeCommand, withClaudeSessionsStopped } from '../server/claude-rotation-sessions.js';
import { externalClaudePids, assertClaudeProcessesManaged } from '../server/claude-processes.js';
import { parseCommand } from '../lib/helpers.js';
const id = '019a0000-0000-7000-8000-00000000c0de';

describe('Claude conversation continuity', () => {
  it('pins the exact conversation, preserves options and replaces the original prompt', () => {
    const cmd = resumeClaudeCommand('claude --continue --model opus --permission-mode auto --settings "/a b/settings.json" "Ship task 9" --add-dir "/repo two"', id);
    const { args } = parseCommand(cmd);
    expect(args).toEqual(['--model', 'opus', '--permission-mode', 'auto', '--settings', '/a b/settings.json', '--add-dir', '/repo two', '--resume', id, expect.stringContaining('interrupted conversation')]);
    expect(cmd).not.toContain('Ship task 9');
    expect(parseCommand(resumeClaudeCommand(`claude --resume=${id} --model=sonnet`, id)).args.filter(a => a.startsWith('--resume'))).toEqual(['--resume']);
  });
  it('refuses an unknown conversation or unsupported startup flags before stopping anything', async () => {
    const stop = vi.fn(), start = vi.fn(), fn = vi.fn();
    const deps = { list: () => [{ agent: 'claude', command: 'claude --unknown value' }], idFor: () => id, stop, start };
    await expect(withClaudeSessionsStopped(fn, deps)).rejects.toThrow(/does not support/);
    expect(stop).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
    expect(() => resumeClaudeCommand('claude', null)).toThrow(/exact Claude conversation/);
  });
  it('stops all Claude sessions before swapping, resumes their exact ids and carries mail after a failed swap', async () => {
    const events = [];
    const sessions = [{ id: 'a', agent: 'claude', command: 'claude --model opus' }, { id: 'b', agent: 'claude', command: 'claude' }, { id: 'c', agent: 'codex' }];
    const deps = {
      list: () => sessions, idFor: () => id,
      stop: async s => { events.push(`stop-${s.id}`); return [`mail-${s.id}`]; },
      start: async r => { events.push(`start-${r.session.id}`); expect(r.carried).toEqual([`mail-${r.session.id}`]); expect(parseCommand(r.command).args).toContain(id); },
    };
    await expect(withClaudeSessionsStopped(async () => { events.push('swap'); throw Error('write failed'); }, deps)).rejects.toThrow('write failed');
    expect(events).toEqual(['stop-a', 'stop-b', 'swap', 'start-a', 'start-b']);
  });
  it('does not swap after an unconfirmed stop, and restarts sessions already stopped', async () => {
    const fn = vi.fn(), start = vi.fn();
    await expect(withClaudeSessionsStopped(fn, {
      list: () => [{ id: 1, agent: 'claude', command: 'claude' }, { id: 2, agent: 'claude', command: 'claude' }], idFor: () => id,
      stop: async s => { if (s.id === 2) throw Error('still running'); }, start,
    })).rejects.toThrow('still running');
    expect(fn).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('detects external Claude processes but permits descendants of managed sessions', async () => {
    const rows = [{ pid: 10, ppid: 1, command: '/bin/claude' }, { pid: 11, ppid: 10, command: '/bin/claude' }, { pid: 12, ppid: 1, command: '/Users/a/.local/bin/claude' }, { pid: 13, ppid: 1, command: 'node server.js' }];
    expect(externalClaudePids(rows, new Set([10]))).toEqual([12]);
    expect(externalClaudePids([{ pid: 1, ppid: 0, command: 'node /x/@anthropic-ai/claude-code/cli.js' }], new Set())).toEqual([1]);
    // Emulate the complete POSIX boundary even when this test runs on Windows.
    const getuid = () => 1234;
    await expect(assertClaudeProcessesManaged([], { platform: 'darwin', getuid, run: (_f, args, _o, cb) => {
      expect(args).toEqual(['-U', '1234', '-o', 'pid=,ppid=,args=']);
      cb(null, '12 1 /bin/claude\n');
    } })).rejects.toThrow(/outside this app/);
    await expect(assertClaudeProcessesManaged([], { platform: 'darwin', getuid, run: (_f, _a, _o, cb) => cb(Error('raw sensitive output')) })).rejects.toThrow(/Could not check/);
  });
});


describe('rotation lifecycle failures', () => {
  it('reports failed and throwing restarts and continues resuming other sessions', async () => {
    const failed = vi.fn(), resumed = [];
    const sessions = [1, 2, 3].map(id => ({ id, agent: 'claude', command: 'claude' }));
    const result = await withClaudeSessionsStopped(async () => ({ ok: true }), {
      list: () => sessions, idFor: () => id, stop: async () => [], failed,
      start: async record => { resumed.push(record.session.id); if (record.session.id === 1) return { error: 'spawn refused' }; if (record.session.id === 2) throw Error('private details'); },
    });
    expect(result).toMatchObject({ blocked: true, error: expect.any(String), resumeFailed: [1, 2] });
    expect(result.ok).not.toBe(true);
    expect(resumed).toEqual([1, 2, 3]);
    expect(failed.mock.calls).toEqual([[sessions[0], 'spawn refused'], [sessions[1], 'Claude could not be restarted.']]);
  });

  it('parses Windows process records, rejects unowned Claude and rejects malformed inventory', async () => {
    const run = output => (_file, _args, _options, cb) => cb(null, output);
    await expect(assertClaudeProcessesManaged([{ agent: 'claude', pty: { pid: 9 } }], {
      platform: 'win32', run: run(JSON.stringify({ ProcessId: 10, ParentProcessId: 9, Name: 'claude.exe' })),
    })).resolves.toEqual({ daemon: false });
    await expect(assertClaudeProcessesManaged([], {
      platform: 'win32', run: run(JSON.stringify([{ ProcessId: 10, ParentProcessId: 9, Name: 'claude.exe' }])),
    })).rejects.toThrow(/outside this app/);
    await expect(assertClaudeProcessesManaged([], { platform: 'win32', run: run('not JSON') })).rejects.toThrow(/Could not check/);
  });
});
