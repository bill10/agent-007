// Preserve CLI options while replacing only the conversation selector/prompt.
import { parseCommand } from '../lib/helpers.js';
import { quote, isCodexSessionId } from '../lib/jobs.js';

const VALUES = new Set(['--model', '--permission-mode', '--settings', '--setting-sources', '--agent', '--agents', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file', '--effort', '--max-budget-usd', '--output-format', '--input-format', '--debug-file', '--name']);
const MANY = new Set(['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--mcp-config', '--plugin-dir', '--betas']);
const FLAGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--strict-mcp-config', '--verbose', '--chrome', '--no-chrome', '--disable-slash-commands', '--ide']);
export function resumeClaudeCommand(command, id) {
  if (!isCodexSessionId(id)) throw new Error('The exact Claude conversation could not be identified yet.');
  const { file, args } = parseCommand(command);
  const keep = [];
  let prompt = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], flag = arg.split('=')[0];
    if (arg === '--continue' || arg === '-c' || arg === '--fork-session') continue;
    if (['--resume', '-r', '--session-id'].includes(flag)) { if (!arg.includes('=')) i++; continue; }
    if (arg === '--') break;
    if (VALUES.has(flag)) {
      keep.push(arg);
      if (!arg.includes('=')) { if (args[i + 1] === undefined) throw new Error(`Missing ${flag} value.`); keep.push(args[++i]); }
    } else if (MANY.has(flag)) {
      keep.push(arg);
      if (!arg.includes('=')) while (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) keep.push(args[++i]);
    } else if (FLAGS.has(arg)) keep.push(arg);
    else if (arg.startsWith('-')) throw new Error(`Automatic restart does not support ${flag}; stop this Claude session before rotating.`);
    else if (!prompt) prompt = true;
    else throw new Error('Could not separate the Claude prompt from its startup options. Stop this session before rotating.');
  }
  return [file, ...keep, '--resume', id, 'Continue the interrupted conversation after an account switch. Check any interrupted tool operation before retrying it.'].map(quote).join(' ');
}

// Codex: `codex resume <id>` with the session's own options (codex 0.157's
// `codex resume --help`). A `resume` already on the command, its id, --last
// and the old prompt are replaced; an option this does not know refuses.
const CODEX_VALUES = new Set(['-c', '--config', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '-p', '--profile', '-C', '--cd', '--add-dir', '--enable', '--disable', '--local-provider', '--remote', '--remote-auth-token-env']);
const CODEX_FLAGS = new Set(['--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--approve-for-me', '--search', '--oss', '--no-alt-screen', '--strict-config', '--no-daemon', '--dangerously-bypass-hook-trust']);
export function resumeCodexCommand(command, id) {
  if (!isCodexSessionId(id)) throw new Error('The exact Codex conversation could not be identified yet.');
  const { file, args } = parseCommand(command);
  const keep = [];
  let prompt = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], flag = arg.split('=')[0];
    if (arg === '--') break;
    if (arg === '--last') continue;
    if (arg === 'resume' && !keep.length && !prompt) { if (args[i + 1] && !args[i + 1].startsWith('-')) i++; continue; }
    if (CODEX_VALUES.has(flag)) {
      keep.push(arg);
      if (!arg.includes('=')) { if (args[i + 1] === undefined) throw new Error(`Missing ${flag} value.`); keep.push(args[++i]); }
    } else if (CODEX_FLAGS.has(arg)) keep.push(arg);
    else if (arg.startsWith('-')) throw new Error(`Automatic restart does not support ${flag}; stop this Codex session before rotating.`);
    else if (!prompt) prompt = true;
    else throw new Error('Could not separate the Codex prompt from its startup options. Stop this session before rotating.');
  }
  return [file, 'resume', id, ...keep, 'Continue the interrupted conversation after an account switch. Check any interrupted tool operation before retrying it.'].map(quote).join(' ');
}

// Preflight every session before stopping any; resume even if activation fails.
// Serves both CLIs (`agent`); the name predates Codex rotation.
export async function withClaudeSessionsStopped(fn, { agent = 'claude', list, stop, start, idFor, failed = () => {} }) {
  const resume = agent === 'codex' ? resumeCodexCommand : resumeClaudeCommand;
  const name = agent === 'codex' ? 'Codex' : 'Claude';
  const records = list().filter(s => (!s.exited || s.rotationResume) && s.agent === agent).map(session => ({
    session, command: resume(session.command, idFor(session)),
  }));
  const stopped = [];
  const resumeFailed = [];
  let outcome;
  try {
    for (const record of records) { record.carried = await stop(record.session); stopped.push(record); }
    outcome = await fn();
  } finally {
    for (const record of stopped) {
      try {
        const result = await start(record);
        if (result?.error) { resumeFailed.push(record.session.id); await failed(record.session, result.error); }
      } catch { if (!resumeFailed.includes(record.session.id)) resumeFailed.push(record.session.id); await failed(record.session, `${name} could not be restarted.`); }
    }
  }
  return resumeFailed.length
    ? { ...outcome, ok: false, blocked: true, error: `Some ${name} conversations could not resume. Their queued messages have been retained.`, resumeFailed }
    : outcome;
}
