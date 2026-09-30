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

// Preflight every session before stopping any; resume even if activation fails.
export async function withClaudeSessionsStopped(fn, { list, stop, start, idFor, failed = () => {} }) {
  const records = list().filter(s => (!s.exited || s.rotationResume) && s.agent === 'claude').map(session => ({
    session, command: resumeClaudeCommand(session.command, idFor(session)),
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
      } catch { if (!resumeFailed.includes(record.session.id)) resumeFailed.push(record.session.id); await failed(record.session, 'Claude could not be restarted.'); }
    }
  }
  return resumeFailed.length
    ? { ...outcome, ok: false, blocked: true, error: 'Some Claude conversations could not resume. Their queued messages have been retained.', resumeFailed }
    : outcome;
}
