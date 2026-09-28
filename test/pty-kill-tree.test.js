// Closing a session takes what its agent left running in the background
// (server/pty.js, killSessionProcesses): a plain `&` job in the shell's group,
// a detached child in a session of its own (how Claude Code runs Bash), and
// one that ignores SIGTERM. Real PTYs, so not on Windows.

import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node-pty';
import { killSessionProcesses } from '../server/pty.js';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function gone(pids, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until && pids.some(alive)) await new Promise((r) => setTimeout(r, 100));
  return pids.filter(alive);
}

// A shell that prints `PIDS a b c` once its children are up.
function startSession(script) {
  const pty = spawn('/bin/sh', ['-c', script], { cols: 80, rows: 24, env: process.env });
  const exited = new Promise((r) => pty.onExit(r));
  const pids = new Promise((resolve) => {
    let out = '';
    pty.onData((d) => {
      out += d;
      const m = out.match(/PIDS([\d ]+)\r?\n/);
      if (m) resolve(m[1].trim().split(/\s+/).map(Number));
    });
  });
  return { session: { name: 'Test', pty }, exited, pids };
}

describe.skipIf(process.platform === 'win32')('killSessionProcesses', () => {
  it('kills background, detached and TERM-ignoring grandchildren', async () => {
    const detached = `node -e "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1e3)"`;
    const { session, exited, pids } = startSession(
      `sleep 60 & a=$!; (trap '' TERM; exec sleep 61) & b=$!; ${detached} > /tmp/.pty-kill-$$ & sleep 1; echo PIDS $a $b $(cat /tmp/.pty-kill-$$); rm -f /tmp/.pty-kill-$$; wait`,
    );
    const kids = await pids;
    expect(kids).toHaveLength(3);
    expect(kids.every(alive)).toBe(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    killSessionProcesses(session, { graceMs: 300 });
    await exited;
    expect(await gone(kids)).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/Test: stopping [3-9] process\(es\) it started/);
    log.mockRestore();
  }, 15000);

  it('closes a plain session as before', async () => {
    const { session, exited, pids } = startSession('echo PIDS $$; exec sleep 60');
    const [pid] = await pids;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    killSessionProcesses(session);
    await exited;
    expect(alive(pid)).toBe(false);
    expect(log).toHaveBeenCalledWith('Test: no processes of its own left to stop');
    log.mockRestore();
  }, 10000);
});
