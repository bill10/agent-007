// Only process metadata is inspected; command lines stay in memory and are
// never returned to the browser or logged. An external CLI may refresh the
// shared credential, so refuse a swap until it has been stopped by its owner.
// For Codex, its shared background server (`codex app-server --managed-daemon`
// and the `app-server daemon` loop beside it) is not counted: the switch stops
// it itself (server/codex-login.js stopCodexDaemon).
import { execFile } from 'child_process';
import { parseCommand } from '../lib/helpers.js';
const PACKAGES = { claude: /@anthropic-ai[\\/]claude-code[\\/]/, codex: /@openai[\\/]codex[\\/]/ };
const NAMES = { claude: 'Claude', codex: 'Codex' };
const looksLike = (agent, text) => {
  const { file, args } = parseCommand(text || '');
  const name = file.split(/[\\/]/).pop();
  if (new RegExp(`^${agent}(?:\\.exe|\\.cmd|\\.js)?$`, 'i').test(name)) return true;
  return /^(?:node|bun)(?:\.exe)?$/i.test(name) && args.some(arg => PACKAGES[agent].test(arg));
};
// `app-server` must be the subcommand: right after the binary, or after the
// package script a node/bun wrapper runs, never a word inside a prompt.
export const isCodexDaemon = text => {
  if (!looksLike('codex', text)) return false;
  const { file, args } = parseCommand(text);
  const at = /^(?:node|bun)(?:\.exe)?$/i.test(file.split(/[\\/]/).pop()) ? 1 : 0;
  return args[at] === 'app-server' && (args[at + 1] === 'daemon' || args.includes('--managed-daemon'));
};
export function externalClaudePids(rows, managed, agent = 'claude') {
  const children = new Map(rows.map(r => [r.pid, r.ppid]));
  const belongs = pid => {
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (managed.has(pid)) return true;
      seen.add(pid); pid = children.get(pid);
    }
    return false;
  };
  return rows.filter(r => (looksLike(agent, r.name) || looksLike(agent, r.command)) && !belongs(r.pid)
    && !(agent === 'codex' && isCodexDaemon(r.command))).map(r => r.pid);
}
// Serves both CLIs (the name predates Codex rotation). Resolves { daemon }
// (a Codex background server is running) or throws.
export async function assertClaudeProcessesManaged(sessions, { agent = 'claude', platform = process.platform, run = execFile, getuid = process.getuid } = {}) {
  const cancelled = `Could not check for other ${NAMES[agent]} processes. Account switching was cancelled.`;
  const win = platform === 'win32';
  const file = win ? 'powershell.exe' : '/bin/ps';
  const args = win ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress']
    : ['-U', String(getuid()), '-o', 'pid=,ppid=,args='];
  const output = await new Promise((resolve, reject) => run(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => err ? reject(new Error(cancelled)) : resolve(stdout)));
  let rows;
  try {
    rows = win ? [].concat(JSON.parse(output)).map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, command: r.CommandLine }))
      : output.trim().split('\n').flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : []; });
  } catch { throw new Error(cancelled); }
  if (externalClaudePids(rows, new Set(sessions.filter(s => !s.exited && s.agent === agent).map(s => s.pty.pid)), agent).length) {
    const error = new Error(`Another ${NAMES[agent]} process is running outside this app. Stop it before switching accounts so it cannot overwrite the login.`);
    error.busy = true; // Includes short-lived auth checks; retry without a quota cooldown.
    throw error;
  }
  return { daemon: agent === 'codex' && rows.some(r => isCodexDaemon(r.command)) };
}
