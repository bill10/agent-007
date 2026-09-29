// Only process metadata is inspected; command lines stay in memory and are
// never returned to the browser or logged. An external CLI may refresh the
// shared credential, so refuse a swap until it has been stopped by its owner.
import { execFile } from 'child_process';
import { parseCommand } from '../lib/helpers.js';
const looksClaude = text => {
  const { file, args } = parseCommand(text || '');
  const name = file.split(/[\\/]/).pop();
  if (/^claude(?:\.exe|\.cmd|\.js)?$/i.test(name)) return true;
  return /^(?:node|bun)(?:\.exe)?$/i.test(name) && args.some(arg => /@anthropic-ai[\\/]claude-code[\\/]/.test(arg));
};
export function externalClaudePids(rows, managed) {
  const children = new Map(rows.map(r => [r.pid, r.ppid]));
  const belongs = pid => {
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (managed.has(pid)) return true;
      seen.add(pid); pid = children.get(pid);
    }
    return false;
  };
  return rows.filter(r => (looksClaude(r.name) || looksClaude(r.command)) && !belongs(r.pid)).map(r => r.pid);
}
export async function assertClaudeProcessesManaged(sessions, { platform = process.platform, run = execFile } = {}) {
  const win = platform === 'win32';
  const file = win ? 'powershell.exe' : '/bin/ps';
  const args = win ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress']
    : ['-U', String(process.getuid()), '-o', 'pid=,ppid=,args='];
  const output = await new Promise((resolve, reject) => run(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => err ? reject(new Error('Could not check for other Claude processes. Account switching was cancelled.')) : resolve(stdout)));
  let rows;
  try {
    rows = win ? [].concat(JSON.parse(output)).map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, command: r.CommandLine }))
      : output.trim().split('\n').flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : []; });
  } catch { throw new Error('Could not check for other Claude processes. Account switching was cancelled.'); }
  if (externalClaudePids(rows, new Set(sessions.filter(s => !s.exited && s.agent === 'claude').map(s => s.pty.pid))).length) {
    throw new Error('Another Claude process is running outside this app. Stop it before switching accounts so it cannot overwrite the login.');
  }
}
