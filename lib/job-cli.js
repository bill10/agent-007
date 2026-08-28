// Pure argument/environment parsing for the `agent-007-job` CLI — the command
// an agent runs to post a card to the job board.
//
// Kept free of I/O (no fetch, no process, no console) for the same reason
// lib/jobs.js is: the interesting behaviour is parsing, and parsing is only
// testable when it is separable from the network call. bin/agent-cli/agent-007-job
// is the thin shell around this.

export const CLI_NAME = 'agent-007-job';

export const USAGE = `${CLI_NAME} — post a job to the Agent 007 job board.

Usage:
  ${CLI_NAME} <title> [--detail <text>] [--repo <path-or-name>]

The card lands in the To do column. The board dispatches it to a fresh agent on
its own worktree and branch when it next scans (if the dispatcher is running).

Options:
  -d, --detail <text>   Everything the agent needs to do the work unattended.
                        Omit it and any piped stdin is used instead.
  -r, --repo <path>     Repository to run the job in, by path or folder name.
                        Defaults to the repo this terminal is working in.
      --json            Print the created job as JSON instead of a sentence.
  -h, --help            Show this help.

Examples:
  ${CLI_NAME} "Add rate limiting to /api/browse"
  ${CLI_NAME} "Fix the flaky worktree test" --detail "Fails on Windows only; see TODOS.md"
  git log -1 --format=%B | ${CLI_NAME} "Follow up on the last commit"`;

const FLAGS_WITH_VALUE = new Map([
  ['--detail', 'detail'], ['-d', 'detail'],
  ['--repo', 'repo'], ['-r', 'repo'],
]);

// Returns { help } | { error } | { title, detail, repo, json }.
export function parseArgs(argv = []) {
  const out = { title: '', detail: null, repo: null, json: false };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--json') { out.json = true; continue; }
    // `--detail=x` as well as `--detail x`: both spellings are common enough
    // that rejecting one is just a failed command the agent has to retry.
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 2) {
      const key = FLAGS_WITH_VALUE.get(arg.slice(0, eq));
      if (!key) return { error: `Unknown option "${arg.slice(0, eq)}"` };
      out[key] = arg.slice(eq + 1);
      continue;
    }
    if (FLAGS_WITH_VALUE.has(arg)) {
      const key = FLAGS_WITH_VALUE.get(arg);
      if (i + 1 >= argv.length) return { error: `Option "${arg}" needs a value` };
      out[key] = argv[++i];
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') return { error: `Unknown option "${arg}"` };
    words.push(arg);
  }
  // Unquoted titles are the single most likely mistake an agent makes here, and
  // the words are all still there in argv — join them rather than failing on
  // "unexpected argument" and making the agent guess what went wrong.
  out.title = words.join(' ').trim();
  if (!out.title) return { error: 'A job needs a title' };
  return out;
}

// Where to post, and as whom. Both values are injected into every agent
// terminal by the server (see server/pty.js), so a missing URL means the
// command is being run somewhere that is not an Agent 007 terminal.
export function endpointFromEnv(env = {}) {
  const base = String(env.AGENT007_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    return { error: `AGENT007_URL is not set — ${CLI_NAME} only works inside an Agent 007 agent terminal.` };
  }
  return { url: `${base}/api/jobs`, token: env.AGENT007_TOKEN || null };
}

// One line back to the agent, so the transcript records what was queued.
//
// The dispatcher note matters: with the board stopped, a posted card sits in To
// do doing nothing. An agent reporting "queued it" without that would leave the
// user believing work was under way.
export function successLine(job, { repoName, dispatcherRunning } = {}) {
  const where = repoName ? ` in ${repoName}` : '';
  const line = `Posted "${job.title}"${where} to the Agent 007 job board (To do).`;
  if (dispatcherRunning === false) {
    return `${line} The board dispatcher is stopped, so it waits there until the board is started.`;
  }
  return line;
}
