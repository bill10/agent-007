// Pure job-board logic — schema, dispatch selection, PR parsing, status derivation.
// Kept free of I/O and shared state so it is testable in isolation; the stateful
// dispatcher (timers, spawning, git) lives in server/jobs.js.

import { randomBytes } from 'crypto';
import { basename, dirname } from 'path';
import { nextCronIso, parseCron } from './cron.js';
import { parseCommand } from './helpers.js';

// Every state a job can be in. A job's *state* is workflow position only —
// "the agent is stuck waiting for you" is deliberately NOT a state here (see
// deriveJobStatus): it is a live property of the agent, not a place the card
// moves to.
//
// `done` is the one state with no column. A job whose PR has merged is finished
// work, and leaving its card on the board means the Review column slowly fills
// with things nobody has to look at again — the column stops meaning "needs
// your review". The job itself is kept, not deleted: it is the record of what
// an agent did and where the PR is, reachable through the Finished jobs view.
export const JOB_STATES = ['todo', 'in-progress', 'review', 'done'];

// What each state is called when it is written out rather than drawn. The
// board's own columns carry these labels in public/modules/jobs.js, which the
// browser cannot import from here (only public/ is served), so a test keeps
// the two in step. `done` has no column — it is the Finished jobs archive.
export const STATE_LABELS = {
  'todo': 'To do',
  'in-progress': 'In progress',
  'review': 'Review',
  'done': 'Finished',
};

// What kind of work a card is.
//
//   one-time   dispatched once; its agent reports back with finish_job (or the
//              board spots its PR), it waits in Review, and leaves at Done.
//   scheduled  a SCHEDULE, not a job: it stays in To do and is never
//              dispatched itself. Each time it comes due it posts a one-time
//              run card (scheduleId -> the schedule), and that run goes through
//              the one-time lifecycle like any other card. See canFire for
//              when a due schedule holds off instead.
//
// Cards written before this existed have no `type` at all, so every read goes
// through jobType() rather than touching job.type directly: a missing type is
// one-time, which is what those cards have always been.
export const JOB_TYPES = ['one-time', 'scheduled'];
export const DEFAULT_JOB_TYPE = 'one-time';

export function jobType(job) {
  return job && job.type === 'scheduled' ? 'scheduled' : DEFAULT_JOB_TYPE;
}

export function jobAgent(job) {
  return isValidJobAgent(job && job.agent) ? job.agent : DEFAULT_JOB_AGENT;
}

export function isScheduled(job) {
  return jobType(job) === 'scheduled';
}

// Whether a one-time card's work ends in a pull request. Not every task is a
// code change — research, an investigation, an ops chore — and a card that
// demanded a PR of those pushed its agent into inventing one. Cards written
// before this existed have no field, and they were all written to produce a
// PR, so a missing field reads as true.
//
// On a schedule it is what its runs get, and there the default is false: a
// recurring job was never expected to open a PR (a report, a check), so it has
// to be asked for.
export function jobRequiresPr(job) {
  return isScheduled(job) ? job?.requiresPr === true : job?.requiresPr !== false;
}

// What a card gets when nobody said: see jobRequiresPr.
export function defaultRequiresPr(type) {
  return type !== 'scheduled';
}

// Defaults for the dispatcher. Exported so the UI can show them and tests can
// override without touching module state.
export const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;  // scan cadence
export const MAX_AGENTS_PER_REPO = 2;               // concurrent board agents
export const STALLED_AFTER_MS = 3 * 60 * 1000;      // quiet WAITING -> "stalled"

// Board agents run in auto mode. The classifier that mode brings is the only
// thing that reviews a dispatched agent's actions before they run, and that
// matters more here than anywhere else in the app: a board agent's prompt is a
// job card's detail text plus whatever it reads out of the repo, none of which
// is necessarily trustworthy. Under `bypassPermissions` nothing reviews
// anything — the agent runs Bash and edits files unprompted, as the user (see
// the board-credential section of DESIGN.md).
//
// Auto mode is not available everywhere, which is why this is a default rather
// than the only setting. It needs a supported model and an organisation that
// has not turned it off, so on an Amazon Bedrock or Vertex account running an
// unsupported model, or behind `permissions.disableAutoMode`, it is missing —
// and Claude Code does NOT error or exit in that case: "When the flag, a
// settings file, or the built-in default selects auto but auto mode isn't
// available to the session, Claude Code starts the session in Manual instead"
// (docs/en/permission-modes). The agent spawns fine and works until it needs a
// permission, then waits for a human who is not there. Every job.
//
// That failure is a stall, not a crash: `deriveJobStatus` reports the card as
// `needs-input`, then `stalled` once the quiet window passes, so the board is
// not blind to it. Because it is visible AND there is now a lever — a board
// permission mode in the toolbar, and a per-card override on the form — `auto`
// is the right default again. A machine without the classifier sets the board
// setting once; a card that needs more says so on itself.
//
// Two caveats, so neither this comment nor the release notes oversell it.
// Choosing `bypassPermissions` does not make dispatch hands-off: Claude Code
// shows its workspace-trust dialog the first time it runs in any directory,
// every board agent gets a brand-new worktree, and no permission mode skips it
// (verified against 2.1.250 — see the trust pre-seed entry in TODOS.md). So a
// job still costs one human click to start; what the mode changes is what
// happens after that, not before. And on a machine where nobody has used the
// mode before, the docs say the first session started in it asks the user to
// accept responsibility once and remembers thereafter — until someone answers
// that by hand, a board agent waits there instead of working.
export const DEFAULT_PERMISSION_MODE = 'auto';

// A command-line argument in double quotes, as parseCommand() in lib/helpers.js
// reads it back: backslash escapes for quotes and backslashes.
export const quote = (text) => `"${String(text).replace(/([\\"])/g, '\\$1')}"`;

// Billion (server/billion.js). Here because a card it posted tells its worker
// whom to ask, and this module is where the worker's prompt is written.
export const BILLION_NAME = 'Billion';

// The modes `claude --permission-mode` accepts. buildJobCommand interpolates
// this value into a command string that parseCommand splits into argv, so an
// unvalidated value from the wire becomes extra FLAGS on the spawned agent
// (e.g. "auto --dangerously-skip-permissions"). No shell is involved, so this
// is not shell injection — but it is argv injection, and the allowlist closes
// it. Keep in sync with `claude --permission-mode` choices.
export const PERMISSION_MODES = [
  'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan',
];

export function isValidPermissionMode(mode) {
  return PERMISSION_MODES.includes(mode);
}

// A card's own permission mode, as it arrives from a form or an API call.
//
// `null` is a real third state and not a copy of the board's mode taken when
// the card was written: it means "whatever the board is set to at dispatch",
// so changing the board setting still moves every queued card that never asked
// for its own. An unrecognised mode is refused rather than quietly falling back
// to the default — the caller named a mode, and silently running something
// else is the wrong answer in both directions.
export function resolveJobPermissionMode(mode) {
  if (mode === undefined || mode === null || mode === '') return { permissionMode: null };
  if (!isValidPermissionMode(mode)) {
    return { error: `Unknown permission mode "${mode}" \u2014 expected one of: ${PERMISSION_MODES.join(', ')}` };
  }
  return { permissionMode: mode };
}

// Which CLI a card's agent is. The value is interpolated into the spawned
// command's argv, so it is an allowlist for the same reason PERMISSION_MODES
// is.
export const JOB_AGENTS = ['claude', 'codex'];
export const DEFAULT_JOB_AGENT = 'claude';

// Codex has no --permission-mode, so each Claude mode maps onto the nearest
// thing Codex's own two flags say. The form only offers a Codex card board
// default, auto and bypassPermissions; the rest are reached through a board
// set to one of them, and a strict board must bind a Codex card too — without
// this a read-only board dispatched a Codex that wrote files, and an agent
// that cannot pick a permission mode through the board's MCP tool could widen
// its successor's simply by posting the card with agent: codex.
//
// auto and acceptEdits are Codex's default (workspace-write sandbox, approval
// asked on request), so they add nothing. That default runs a command it
// judges safe inside the sandbox without asking, where Claude's acceptEdits
// would have prompted for it — the nearest flag, not an equivalent one.
// manual is the read-only sandbox with approvals on request: every write and
// every escape from the sandbox comes back as a question, which is as close
// as Codex gets to asking before each tool. (Its `untrusted` approval policy,
// used here before, is gone from codex-cli 0.153 — the flag was rejected at
// parse time and the agent died on the spot.)
// Keep in sync with `codex --help`; test/jobs-agent.test.js runs each entry
// through the installed CLI's parser when there is one.
export const CODEX_MODE_FLAGS = {
  auto: '',
  acceptEdits: '',
  plan: '--sandbox read-only',
  manual: '--ask-for-approval on-request --sandbox read-only',
  dontAsk: '--ask-for-approval never',
  bypassPermissions: '--dangerously-bypass-approvals-and-sandbox',
};

// The permission mode .env gives every agent of one CLI that nothing more
// specific decides: CLAUDE_PERMISSION_MODE / CODEX_PERMISSION_MODE, one of
// PERMISSION_MODES. Anything else (unset, a typo) is null: no default.
export const ENV_PERMISSION_MODE = { claude: 'CLAUDE_PERMISSION_MODE', codex: 'CODEX_PERMISSION_MODE' };
export function envPermissionMode(agent, env = process.env) {
  const key = Object.prototype.hasOwnProperty.call(ENV_PERMISSION_MODE, agent) ? ENV_PERMISSION_MODE[agent] : null;
  const mode = key ? String(env[key] ?? '').trim() : '';
  return isValidPermissionMode(mode) ? mode : null;
}

// The flags that mode is on that CLI's command line: Claude takes the mode by
// name; Codex its sandbox and approval flags (none for auto and acceptEdits).
export function permissionModeFlags(agent, mode) {
  if (!isValidPermissionMode(mode)) return [];
  if (agent === 'claude') return ['--permission-mode', mode];
  if (agent === 'codex') return CODEX_MODE_FLAGS[mode].split(' ').filter(Boolean);
  return [];
}

// A command someone typed, or a preset, with the .env default for its CLI
// added — unless it already says how it asks for permission, which then
// stands. Only claude and codex; any other command comes back unchanged. The
// flags go into the command itself, right after the executable, so everything
// that reads a session's mode off its command (who may message it, what it
// re-spawns with) sees the mode it really runs in.
//
// "Already says" is judged by the flag's name, not its value: a value the
// allowlist doesn't know (`--permission-mode default`, `-a untrusted`) is
// still the person's choice, and a default put in front of it would be what
// the session records — so a re-spawn would come back in the default instead.
export function withDefaultPermission(command, env = process.env) {
  const text = String(command || '');
  const agent = sessionAgentFromCommand(text);
  if (!agent || namesPermissionFlag(agent, parseCommand(text).args)) return text;
  const flags = permissionModeFlags(agent, envPermissionMode(agent, env));
  if (!flags.length) return text;
  const { file, args } = parseCommand(text);
  // A plain first word keeps the rest exactly as typed; a quoted executable
  // path is rebuilt, quoting every argument the way parseCommand reads it back.
  const plain = text.match(/^\s*[^\s"'\\]+(?=\s|$)/);
  return plain
    ? `${plain[0]} ${flags.join(' ')}${text.slice(plain[0].length)}`
    : [quote(file), ...flags, ...args.map(quote)].join(' ');
}

// Codex also takes config overrides and profiles, which can set any
// permission the allowlist cannot see. Shared with server/messages.js
// isUnguarded, which reads them as never asking.
export const isCodexConfigFlag = (arg) => /^(-c|--config|-p|--profile|--full-auto)(=|$)/.test(arg) || /^-[cp]\S/.test(arg);

// Whether `args` (before any `--`) name one of the CLI's permission flags, in
// any spelling normalizePermissionFlags reads, whatever the value (or, for
// Codex, a config override or profile).
function namesPermissionFlag(agent, args) {
  const table = PERMISSION_FLAGS[agent];
  const aliases = PERMISSION_FLAG_ALIASES[agent];
  for (const raw of args) {
    if (raw === '--') return false;
    if (agent === 'codex' && isCodexConfigFlag(raw)) return true;
    const name = raw.startsWith('--') ? raw.split('=')[0] : raw.slice(0, 2);
    if (Object.prototype.hasOwnProperty.call(table, aliases[name] || name)) return true;
  }
  return false;
}

export function isValidJobAgent(agent) {
  return JOB_AGENTS.includes(agent);
}

// The agent a session's command line runs — so a card an agent posts can
// default to the same CLI as its poster. Anything not recognised (gemini, a
// plain shell) is claude, the board's own default. Judged the way
// takesMcpConfig in server/agent-mcp.js judges it — the executable's basename,
// Windows extension stripped — so a session spawned as /opt/homebrew/bin/codex
// gets the board tool AND posts codex cards, rather than one without the other.
export function jobAgentFromCommand(command) {
  const file = basename(parseCommand(String(command || '')).file).replace(/\.(cmd|exe|bat|ps1)$/i, '');
  return file === 'codex' ? 'codex' : DEFAULT_JOB_AGENT;
}

// What a session's own record should say it ran, for the orphan it may
// become: 'claude' or 'codex' when the command is that CLI, else null. Unlike
// jobAgentFromCommand this does NOT default to claude — the note outranks
// every other witness at re-adopt time, so a shell tab, a `bash -lc codex`,
// or a gemini must leave it blank and let the job card and the transcripts
// on disk say what actually ran there.
export function sessionAgentFromCommand(command) {
  const file = basename(parseCommand(String(command || '')).file).replace(/\.(cmd|exe|bat|ps1)$/i, '');
  return JOB_AGENTS.includes(file) ? file : null;
}

// The permission flags each CLI takes on its command line, as a hand-spawned
// agent might carry them: an allowlist of flag → accepted values (null for a
// bare switch). Anything else on the command is not a permission and is not
// kept. Keep the Codex entries in sync with `codex --help`; the Claude ones
// with `claude --help`. test/jobs-agent.test.js runs the Codex forms through
// the installed CLI's parser when there is one.
export const PERMISSION_FLAGS = {
  codex: {
    '--sandbox': ['read-only', 'workspace-write', 'danger-full-access'],
    '--ask-for-approval': ['on-request', 'never'],
    '--dangerously-bypass-approvals-and-sandbox': null,
    '--approve-for-me': null,
  },
  claude: {
    '--permission-mode': PERMISSION_MODES,
    '--dangerously-skip-permissions': null,
  },
};
// Other spellings each CLI accepts for the same permission, mapped onto the
// long form above. Codex also takes a short option's value attached
// (`-sread-only`, `-a=never`); those are unpacked below.
const PERMISSION_FLAG_ALIASES = {
  codex: { '-s': '--sandbox', '-a': '--ask-for-approval', '--yolo': '--dangerously-bypass-approvals-and-sandbox' },
  claude: {},
};

// The permission flags among `tokens` for `agent`, normalised to their long
// form, one per flag, or [] when the agent is unknown. Anything not in the
// allowlist — an unknown flag, a value the CLI would reject, a bare switch
// given a value, a non-string — is dropped, so what comes back can be put on
// a command line verbatim. Scanning stops at `--`: what follows is the prompt,
// however flag-shaped, and must never come back as a permission. A flag
// given twice keeps its last value: Codex refuses a repeat outright, and
// Claude Code takes the last one anyway.
// Used both on a fresh command (to record what the agent ran with) and on a
// stored record (config.json is hand-editable), so the two can never disagree
// about what is a permission.
export function normalizePermissionFlags(agent, tokens) {
  // Own-property lookup: `agent` can come from a hand-edited record, and a
  // prototype key ('constructor') must find no table, not a function.
  const table = Object.prototype.hasOwnProperty.call(PERMISSION_FLAGS, agent) ? PERMISSION_FLAGS[agent] : null;
  if (!table || !Array.isArray(tokens)) return [];
  const aliases = PERMISSION_FLAG_ALIASES[agent];
  const seen = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const raw = typeof tokens[i] === 'string' ? tokens[i] : '';
    if (raw === '--') break;
    let flag = raw;
    let inline;
    if (raw.startsWith('--') && raw.includes('=')) {
      [flag, inline] = [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)];
    } else if (/^-[^-]/.test(raw) && raw.length > 2 && aliases[raw.slice(0, 2)]) {
      // A short option with its value attached: -sread-only, -a=never.
      [flag, inline] = [raw.slice(0, 2), raw.slice(2).replace(/^=/, '')];
    }
    flag = aliases[flag] || flag;
    if (!Object.prototype.hasOwnProperty.call(table, flag)) continue;
    const values = table[flag];
    if (values === null) { if (inline === undefined) seen.set(flag, null); continue; }
    // The next token is the value only if it is not itself an option (or the
    // `--` terminator): both CLIs refuse `--sandbox --` at parse time, and a
    // guard that consumed it would read what follows as flags again.
    const next = tokens[i + 1];
    const value = inline !== undefined ? inline : (typeof next === 'string' && !next.startsWith('-') ? tokens[++i] : undefined);
    if (values.includes(value)) seen.set(flag, value);
  }
  const out = [];
  for (const [flag, value] of seen) { out.push(flag); if (value !== null) out.push(value); }
  return out;
}

// The permission flags a stored record (an active session, an orphan) says
// its session ran with, through the allowlist again on the way back — the
// record is hand-editable — and only for a record whose CLI is known, since
// the flags are that CLI's. Both readers of config.json go through here.
export function recordedPermissionFlags(record) {
  return record && isValidJobAgent(record.agent) ? normalizePermissionFlags(record.agent, record.permissionFlags) : [];
}

// The permission flags a session was spawned with, read off its command —
// what its re-spawn should run with when no job card says otherwise.
export function permissionFlagsFromCommand(command) {
  const agent = sessionAgentFromCommand(command);
  if (!agent) return [];
  return normalizePermissionFlags(agent, parseCommand(String(command || '')).args);
}

// A Codex session id as it appears in a rollout's session_meta: a UUID. The
// one gate for what may be named on a resume argv, and for which rollout
// field is the id.
const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isCodexSessionId(value) {
  return typeof value === 'string' && CODEX_SESSION_ID.test(value);
}

// The command that picks an interrupted session back up in its worktree —
// what re-adopting an orphan runs. Each CLI keeps its own transcripts, so a
// Codex agent revived with `claude --continue` finds nothing to continue and
// dies on the spot. A Codex agent resumes by `sessionId`, the newest session
// recorded in exactly its worktree: `codex resume --last` scopes by repo, not
// worktree, so sibling worktrees of one repo would resume each other's
// sessions. With no id to go on it opens Codex's picker rather than guess.
//
// `mode` is the permission mode the session was dispatched with, when its job
// card is known. Neither CLI remembers it: without the flag a Codex card sent
// out read-only comes back with Codex's default workspace-write sandbox, and
// an unattended dontAsk card comes back prompting and stalls. `flags` are the
// permission flags the session was spawned with, for an agent with no card
// (one spawned by hand): they come back as given, so a bypass agent does not
// return asking, nor a read-only one writing. The card wins when both are
// known — it is the board's current word. With neither, the CLI's own
// default applies. Both go through their allowlists here, so this is the one
// place that guarantees nothing but a permission reaches the argv.
export function resumeCommand(agent, mode, flags, sessionId) {
  const validMode = isValidPermissionMode(mode) ? mode : null;
  const own = validMode ? '' : normalizePermissionFlags(agent === 'codex' ? 'codex' : 'claude', flags).join(' ');
  if (agent === 'codex') {
    const flag = validMode ? CODEX_MODE_FLAGS[validMode] : own;
    // The id reaches the argv, so only a real session id passes.
    const target = isCodexSessionId(sessionId) ? ` ${sessionId}` : '';
    return `codex resume${target}${flag ? ` ${flag}` : ''}`;
  }
  const flag = validMode ? `--permission-mode ${validMode}` : own;
  return `claude --continue${flag ? ` ${flag}` : ''}`;
}

export function resolveJobAgent(agent) {
  if (agent === undefined || agent === null || agent === '') return { agent: DEFAULT_JOB_AGENT };
  if (!isValidJobAgent(agent)) {
    // Echoed bounded and only when it is text: this reaches a ws notification
    // and a 400 body, and the ws door does not type-check it first.
    const shown = typeof agent === 'string' ? `"${agent.slice(0, 40)}"` : `a ${typeof agent}`;
    return { error: `Unknown agent ${shown} \u2014 expected one of: ${JOB_AGENTS.join(', ')}` };
  }
  return { agent };
}

// Branch name derived from the job title, so a glance at `git branch` says what
// each branch is for. The `<gituser>/` prefix is added by createWorktree.
//
// Kept to [a-z0-9-] and length-bounded: that side-steps every git ref rule at
// once (no `..`, no leading `-`, no `~^:?*[`, no trailing `.lock`) rather than
// trying to enumerate them, and keeps the name readable in a branch listing.
export const MAX_BRANCH_SLUG_LEN = 40;

export function branchSlugFromTitle(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BRANCH_SLUG_LEN)
    .replace(/-+$/, '');           // a trim mid-word can leave a trailing dash
  // A title of only punctuation or non-Latin script slugs to nothing; a job
  // still needs a branch, so fall back rather than failing the dispatch.
  return slug || 'job';
}

// Shared by createJob and updateJob: both have to answer "is this a valid
// (type, schedule) pair?", and a second copy of the rules would drift.
//
// A one-time job silently drops any schedule rather than refusing it. That is
// the edit path: switching a scheduled card back to one-time leaves the cron
// text sitting in the form field, and failing that save would be baffling.
export function resolveJobType({ type, schedule }) {
  const raw = typeof type === 'string' && type ? type : (schedule ? 'scheduled' : DEFAULT_JOB_TYPE);
  if (!JOB_TYPES.includes(raw)) {
    return { error: `Unknown job type "${raw}" — expected one of: ${JOB_TYPES.join(', ')}` };
  }
  if (raw !== 'scheduled') return { type: raw, schedule: null };
  // Trimmed but NOT truncated: parseCron owns the length rule, and slicing an
  // over-long string first would either hide that error or, worse, silently
  // store a valid-looking prefix of something the user did not write.
  const text = String(schedule || '').trim();
  const parsed = parseCron(text);
  if (parsed.error) return { error: parsed.error };
  return { type: 'scheduled', schedule: text };
}

export function newJobId() {
  return `job-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

// Bound the stored text so a paste of a whole log file can't bloat config.json.
export const MAX_TITLE_LEN = 200;
export const MAX_DETAIL_LEN = 20000;

export function createJob({ title, detail, repoPath, type, schedule, permissionMode, agent, requiresPr, postedBy, postedByName, postedByAgent, postedByBillion }) {
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  if (!cleanTitle) return { error: 'Title is required' };
  if (!repoPath) return { error: 'Repository is required' };
  // A caller that names no type but passes a schedule means a scheduled job:
  // the MCP tool and POST /api/jobs both take just `schedule`, so the rule that
  // turns one into the other lives here, once, rather than at each door.
  const resolved = resolveJobType({ type, schedule });
  if (resolved.error) return { error: resolved.error };
  const mode = resolveJobPermissionMode(permissionMode);
  if (mode.error) return { error: mode.error };
  const cli = resolveJobAgent(agent);
  if (cli.error) return { error: cli.error };
  return {
    job: {
      id: newJobId(),
      title: cleanTitle,
      type: resolved.type,
      // Cron text as typed, null on a one-time job. Validated above, so
      // nextCronIso can never be handed something it will refuse.
      schedule: resolved.schedule,
      // When this schedule is next due. Recomputed from the moment of each
      // firing (see fireSchedules), so a skipped firing is never replayed.
      nextRunAt: resolved.schedule ? nextCronIso(resolved.schedule) : null,
      lastRunAt: null,
      runCount: 0,
      // Held out of dispatch until resumed. Cards written before this existed
      // have no field at all, which reads as not paused — same as `type`.
      paused: false,
      // What this card's agent is spawned with. null inherits the board's
      // setting at dispatch — see resolveJobPermissionMode. Only read from To
      // do, which is the one state editableInPlace still lets anyone change.
      permissionMode: mode.permissionMode,
      // Which CLI is spawned for it. Cards written before this existed have no
      // field, which jobAgent reads as claude.
      agent: cli.agent,
      // See jobRequiresPr. Only false when the poster said so.
      // See jobRequiresPr. Unset takes the type's default.
      requiresPr: typeof requiresPr === 'boolean' ? requiresPr : defaultRequiresPr(resolved.type),
      detail: String(detail || '').trim().slice(0, MAX_DETAIL_LEN),
      // Files posted with the card ({ name, path }), written to disk by the
      // server once the id exists. The prompt hands the agent their paths.
      attachments: [],
      repoPath,
      state: 'todo',
      // Who posted it and when (requirement 3).
      postedBy: postedBy || null,
      postedByName: postedByName || null,
      // Set when an agent typed the card on a person's behalf, via the board's
      // MCP tool. Kept separate from postedByName rather than folded into it:
      // postedBy* is the human the work belongs to, and the board still needs
      // to show that a machine, not they, put it there.
      postedByAgent: postedByAgent || null,
      // Billion's trust rides on this, never on the name: set only by the
      // server, from the posting session (server/jobs.js postJobForAgent).
      postedByBillion: postedByBillion === true,
      postedAt: new Date().toISOString(),
      // Who is working on it and when they started (requirement 3). Null until
      // dispatched; kept after the PR lands so Review cards still show credit.
      agentSessionId: null,
      agentName: null,
      startedAt: null,
      branchName: null,
      worktreePath: null,
      prUrl: null,
      prNumber: null,
      reviewAt: null,
      // What the agent reported when it called finish_job — the result of a
      // card that opens no PR, and an optional note on one that does.
      resultSummary: null,
      // Why the board cannot check for this job's PR, when that is the case.
      // Separate from lastError: both can be true at once, and one must not
      // silence the other.
      prCheckError: null,
      prCheckErrorAt: null,
      // When the PR merged, and when the card left the board. Separate because
      // they answer different questions: prMergedAt is a fact about GitHub, and
      // a card filed away by hand has a doneAt without one — which is how the
      // archive knows to say "finished" rather than "merged". doneAt is when
      // this board stopped showing it.
      prMergedAt: null,
      doneAt: null,
    },
  };
}

// --- Dispatch selection ---

// How many jobs a repo currently has in flight. Only In progress counts: an
// agent kept alive with its card in Review has finished its work and sits idle
// at its prompt, so it is not what the cap limits — agents working at once. It
// holds a PTY and a worktree until the card reaches Done. Counting jobs is
// enough, and there is no second source of truth to keep
// in sync.
//
// One exclusion: a job whose agent has died. A session that no longer exists
// cannot be occupying a slot, and cards are deliberately never auto-reverted to
// To do, so without this a single crashed agent would block its repo forever.
//
// A schedule's runs are ordinary cards and count like any other.
export function countInFlightByRepo(jobs, liveSessionIds = null) {
  const counts = new Map();
  for (const job of jobs) {
    if (job.state !== 'in-progress') continue;
    if (liveSessionIds && !liveSessionIds.has(job.agentSessionId)) continue;
    counts.set(job.repoPath, (counts.get(job.repoPath) || 0) + 1);
  }
  return counts;
}

// Is this card allowed to go out right now? One-time cards always are — being
// in To do is the whole condition. A schedule fires when it is due.
export function isJobDue(job, now = Date.now()) {
  // Paused: held in To do until someone resumes it. Checked before everything
  // else and for every card, not just scheduled ones, because this is the one
  // place every dispatch route passes through — a guard anywhere else would
  // have to be repeated at each door. Firings missed while paused are not
  // replayed: resuming re-arms nextRunAt from that moment (setJobPaused), the
  // same rule a skipped firing follows.
  if (job.paused) return false;
  if (!isScheduled(job)) return true;
  if (!job.nextRunAt) {
    // No due time recorded — a card whose schedule was just edited, or one
    // hand-edited in config.json. Fire it and let the firing re-arm it,
    // rather than leaving it permanently stuck.
    //
    // EXCEPT when the schedule has no future occurrence at all. "0 0 30 2 *"
    // parses fine and never matches, so it has no due time and never will:
    // treating that as due would dispatch it on every single scan, for ever.
    return job.schedule ? nextCronIso(job.schedule, now) !== null : true;
  }
  const at = Date.parse(job.nextRunAt);
  return Number.isNaN(at) || at <= now;
}

export function selectDispatchableJobs(jobs, { maxPerRepo = MAX_AGENTS_PER_REPO, availableRepos = null, liveSessionIds = null, now = Date.now() } = {}) {
  const counts = countInFlightByRepo(jobs, liveSessionIds);
  const selected = [];
  // Schedules are fired (see canFire), never dispatched themselves.
  const todo = jobs
    .filter(j => j.state === 'todo' && !isScheduled(j))
    .sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
  for (const job of todo) {
    // Paused. `continue`, not a break: one held card must not hold up the
    // queue behind it.
    if (!isJobDue(job, now)) continue;
    // A repo that has been removed (or whose path vanished) can't be spawned
    // into; leave the job queued rather than failing it.
    if (availableRepos && !availableRepos.has(job.repoPath)) continue;
    // The cap bounds how many agents the board piles onto one repo. A run
    // waiting behind it waits in To do; its schedule holds off meanwhile (a
    // run not yet started is still unfinished), so nothing queues up.
    const inFlight = counts.get(job.repoPath) || 0;
    if (inFlight >= maxPerRepo) continue;
    counts.set(job.repoPath, inFlight + 1);
    selected.push(job);
  }
  return selected;
}

// --- Prompt ---

// Delivered as a single argv to `claude`, never as simulated keystrokes, so it
// cannot race whatever the TUI happens to be showing. The preamble nudges the
// agent toward assumptions over questions (each question is a stall the user
// has to come clear by hand), points it at /ship as the single finishing step —
// /ship already merges, tests, reviews and fix-loops internally, so anything
// run ahead of it pays for that work twice — and tells it how the job gets
// marked done. It deliberately does not name the skills /ship subsumes: a
// dispatched agent arrives with no memory of them, and naming one to forbid it
// is what puts it on the table.
export function buildJobPrompt(job) {
  const parts = [job.title];
  if (job.detail) parts.push('', job.detail);
  // Absolute paths outside the worktree, so nothing lands in the branch by
  // accident. Claude Code's Read tool renders images, so a screenshot is
  // enough on its own.
  const files = Array.isArray(job.attachments) ? job.attachments.filter(a => a && a.path) : [];
  if (files.length) parts.push('', 'Attached files (read them with your file tools):', ...files.map(a => `  ${a.path}`));
  parts.push('', '---', ...oneTimePromptSuffix(jobAgent(job), jobRequiresPr(job), job.postedByBillion === true));
  return parts.join('\n');
}

// A one-time job ends when its agent calls finish_job, which moves the card to
// Review. A card that requires a PR gets the /ship path first and hands the PR
// link over; one that does not gets no /ship at all — telling an agent doing
// research to run it would push it into inventing a change to ship.
//
// The same skill under each CLI's spelling: /ship in Claude Code, $ship in Codex.
// A card Billion posted has someone to ask who is not a person: Billion
// answers from its terminal, so a question to it does not stall the job.
function oneTimePromptSuffix(agent = DEFAULT_JOB_AGENT, requiresPr = true, fromBillion = false) {
  const ship = agent === 'codex' ? '$ship' : '/ship';
  const finish = requiresPr
    ? [
      `When the work is finished, run ${ship}. It is the whole path from there to the`,
      'pull request, so nothing else needs running first. Wait for it to finish.',
      '',
      'Then call the finish_job tool (agent-007-board MCP server) with the pull',
      'request URL as pr_url. That moves this job to Review.',
    ]
    : [
      'This job does not need a pull request. When the work is finished, call the',
      'finish_job tool (agent-007-board MCP server) with a summary of what you did',
      'or found. That moves this job to Review, where the summary is what gets read.',
      'Put everything that matters in it: this worktree is removed once the job is',
      'done, and only committed, pushed work survives that.',
    ];
  const done = requiresPr ? `${ship} has opened the pull request and you have called finish_job`
    : 'you have called finish_job';
  return [
    'This task was dispatched from the Agent 007 job board. You are in a dedicated',
    'git worktree on your own branch, so work directly here.',
    '',
    'Prefer making a reasonable assumption over asking a question — every question',
    'stalls the job until a human notices. Record any assumptions you made in',
    requiresPr ? 'the pull request description.' : 'your summary.',
    ...(fromBillion ? [
      '',
      `${BILLION_NAME} posted this card. If you are blocked on a decision only it can`,
      `make, ask it with the send_message tool (to: "${BILLION_NAME}") rather than waiting`,
      'for a person; its answer arrives in this terminal.',
    ] : []),
    '',
    ...finish,
    '',
    `Do not end your turn until ${done}. There is no`,
    'one waiting to read a progress report and tell you to continue — if you stop',
    'to describe what you would do next, the job simply stalls there. If you find',
    'yourself about to write a summary ending in what comes next, do that thing',
    'instead. The only reasons to stop early are a question you genuinely cannot',
    'answer yourself, or a failure you cannot get past.',
  ];
}

// The mode a card actually dispatches with. The card's own wins; a card
// without one inherits whatever the board is set to at that moment, which is
// the whole point of storing null rather than a snapshot of the board value.
//
// Each level is re-checked against the allowlist rather than trusted, and an
// invalid card mode falls through to the BOARD setting rather than skipping
// past it to the default. That distinction matters: a card can hold a mode
// that was valid when it was queued and is not any more (dropped from the
// allowlist by a later release, or hand-edited into config.json), and a board
// deliberately set to something strict is exactly the safety net that case
// should land in. Only when neither level survives does the default apply.
//
// Exported because dispatchOnce needs the same answer twice — once to build
// the argv, once to confirm nothing retuned the card while the agent spawned.
export function dispatchPermissionMode(job, boardMode = DEFAULT_PERMISSION_MODE) {
  if (job && isValidPermissionMode(job.permissionMode)) return job.permissionMode;
  if (isValidPermissionMode(boardMode)) return boardMode;
  return DEFAULT_PERMISSION_MODE;
}

export function buildJobCommand(job, { permissionMode = DEFAULT_PERMISSION_MODE } = {}) {
  // Resolved here rather than at the call site so every door into the
  // dispatcher gets the same rule — and validated here as well as at the
  // settings boundary, because this is the function that builds the argv and
  // so the last place that can guarantee the mode is a single token and not a
  // smuggled second flag.
  const mode = dispatchPermissionMode(job, permissionMode);
  // Attachments live outside the worktree, and Claude Code asks before it
  // reads outside its working directory; --add-dir grants that up front so
  // an unattended job does not stop at a permission prompt on its first
  // screenshot. After the prompt, so the argv positions tests rely on hold.
  const dirs = [...new Set((Array.isArray(job.attachments) ? job.attachments : []).filter(a => a && a.path).map(a => dirname(a.path)))];
  if (jobAgent(job) === 'codex') {
    // No --add-dir: every Codex sandbox, read-only included, reads anywhere
    // on disk and gates only writes, and attachments are only ever read.
    const flags = permissionModeFlags('codex', mode).join(' ');
    return `codex ${flags ? `${flags} ` : ''}${quote(buildJobPrompt(job))}`;
  }
  return `claude ${permissionModeFlags('claude', mode).join(' ')} ${quote(buildJobPrompt(job))}${dirs.map(d => ` --add-dir ${quote(d)}`).join('')}`;
}

// --- Live status (derived, never stored) ---

// Why derived: the card's workflow state is durable, but "needs you" is a fact
// about a live PTY that changes second to second and is meaningless once the
// server restarts. Storing it would guarantee a stale badge.
export function deriveJobStatus(job, session, { now = Date.now(), stalledAfterMs = STALLED_AFTER_MS } = {}) {
  if (job.state !== 'in-progress') return null;
  if (!session || session.exited) return 'gone';
  // MESSAGE is already exactly "agent is asking the user something" — the same
  // signal that turns the tab dot orange and gives the office character a
  // thought bubble (see MESSAGE_PATTERNS in lib/helpers.js).
  if (session.state === 'MESSAGE') return 'needs-input';
  // A TUI agent parked at its prompt reads as WAITING whether it asked a prose
  // question or quietly finished without opening a PR. Both need a human, so
  // both surface once the quiet window passes.
  if (session.state === 'WAITING' && (now - (session.lastOutputAt || 0)) > stalledAfterMs) return 'stalled';
  return 'running';
}

// --- Schedules ---

// May a due schedule post its next run? At most one run of a schedule is
// unfinished at a time, so an hourly job nobody reads cannot fill the board:
//
//   - a run still in To do or In progress: skip this firing. Two runs at once
//     would race each other, and a stuck run shows on its own card.
//   - a run in Review that opened a PR: skip until that PR is merged or
//     closed (either files the run to Done), or the card is done. A second
//     dependency-bump PR on an unmerged one is noise.
//   - a run in Review with no PR: fire. The new run supersedes it once it
//     reaches Review itself (see supersededRuns), so the newest result is the
//     one waiting to be read.
//
// Returns null to fire, or the reason it held off.
export function scheduleHold(schedule, jobs) {
  const open = jobs.filter(j => j.scheduleId === schedule.id && j.state !== 'done');
  if (open.some(j => j.state === 'in-progress')) return 'the previous run is still going';
  const queued = open.find(j => j.state === 'todo');
  if (queued) return queued.lastError ? `the previous run could not start: ${queued.lastError}` : 'the previous run has not started yet';
  const prRun = open.find(j => j.state === 'review' && jobRequiresPr(j));
  if (prRun) return prRun.prNumber ? `waiting on PR #${prRun.prNumber}` : 'waiting on the previous run\'s pull request';
  return null;
}

// The Review runs of each schedule that a newer Review run has replaced: every
// no-PR run of a schedule except the one that reached Review last. Ranked by
// reviewAt, not postedAt: an older run sent back for a follow-up and returned
// is the newest result, and must not be filed away the moment it lands. PR runs are never superseded —
// scheduleHold keeps a schedule from firing past one.
export function supersededRuns(jobs) {
  const newest = new Map();
  // The newest is taken over every Review run, PR runs included, so a schedule
  // switched to PR runs still replaces the no-PR run it left in Review.
  const reviewRuns = jobs.filter(j => j.scheduleId && j.state === 'review');
  for (const j of reviewRuns) {
    const cur = newest.get(j.scheduleId);
    // >= so a tie goes to the later card in the list, which was pushed later.
    const at = (x) => String(x.reviewAt || x.postedAt);
    if (!cur || at(j).localeCompare(at(cur)) >= 0) newest.set(j.scheduleId, j);
  }
  return reviewRuns
    .filter(j => !jobRequiresPr(j) && newest.get(j.scheduleId) !== j)
    .map(j => ({ old: j, by: newest.get(j.scheduleId) }));
}

// How many finished runs of each schedule the archive keeps. An hourly
// schedule posts ~8,760 runs a year, every one of them a card in config.json
// and in each board broadcast; past this many, the oldest go. The schedule's
// runCount keeps counting regardless.
export const MAX_FINISHED_RUNS = 50;

// The finished runs to delete: every schedule's done runs beyond the newest
// `keep`, oldest first by when they finished.
export function runsToPrune(jobs, keep = MAX_FINISHED_RUNS) {
  const bySchedule = new Map();
  for (const j of jobs) {
    if (!j.scheduleId || j.state !== 'done') continue;
    if (!bySchedule.has(j.scheduleId)) bySchedule.set(j.scheduleId, []);
    bySchedule.get(j.scheduleId).push(j);
  }
  const prune = [];
  for (const runs of bySchedule.values()) {
    if (runs.length <= keep) continue;
    runs.sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || '')));
    prune.push(...runs.slice(keep));
  }
  return prune;
}

// The run card a schedule posts. An ordinary one-time card, carrying what the
// schedule says its runs should be, and who the schedule belongs to. Pure:
// the server copies the schedule's attachment files into the run's own
// directory when it posts it (copyRunAttachments).
export function createRunJob(schedule) {
  const result = createJob({
    title: schedule.title,
    detail: schedule.detail,
    repoPath: schedule.repoPath,
    type: 'one-time',
    permissionMode: schedule.permissionMode,
    agent: schedule.agent,
    requiresPr: jobRequiresPr(schedule),
    postedBy: schedule.postedBy,
    postedByName: schedule.postedByName,
    // Kept on every run: an agent-posted schedule runs unattended, again and
    // again, and each run must still say a machine queued it.
    postedByAgent: schedule.postedByAgent,
    postedByBillion: schedule.postedByBillion === true,
  });
  if (result.error) return result;
  result.job.scheduleId = schedule.id;
  // An agent's rewrite of the schedule is what each run carries out.
  result.job.editedByAgent = schedule.editedByAgent || null;
  result.job.editedAt = schedule.editedAt || null;
  return result;
}

// --- PR detection ---

// The two `gh pr list` queries the board runs, each kept beside the parser that
// reads its output so the requested --json fields and the fields the parser
// reads cannot drift apart. `--state` is the load-bearing part of each: it is
// the difference between "is there a PR to review" and "did that PR land", and
// getting the merged one wrong (--state closed) would take cards off the board
// for work that never shipped. Pure, so both are pinned by a test.
export function openPrListArgs(branchName) {
  return ['pr', 'list', '--head', branchName, '--state', 'open', '--json', 'number,url,state,isDraft,isCrossRepository'];
}

export function mergedPrListArgs(branchName) {
  return ['pr', 'list', '--head', branchName, '--state', 'merged', '--json', 'number,url,state,mergedAt'];
}

// A card whose PR was closed without merging is filed to Done (see
// checkMergedPullRequests). Asked about the card's own PR by number, not by
// listing the branch: a number is one answer, where a branch listing is
// capped (30 by default) and shared by every card that reused the name.
export function closedPrViewArgs(number) {
  return ['pr', 'view', String(number), '--json', 'number,url,state,mergedAt'];
}

// The card's own PR, if it was closed WITHOUT merging, or null. A merged PR is
// never "closed" here: that is the merge path's to file away. Takes the one
// object `gh pr view` prints (or a list, for older callers).
export function parseClosedPr(stdout, number) {
  if (number == null) return null;
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : null);
  if (!list) return null;
  const pr = list.find(p => p && p.number === number);
  if (!pr || pr.mergedAt || String(pr.state || '').toUpperCase() !== 'CLOSED') return null;
  return { url: pr.url || null, number: pr.number };
}

// Parses `gh pr list --head <branch> --json number,url,state,isDraft`. Returns
// the first OPEN pr, or null. Drafts count: opening a draft PR is still the
// author saying "this is ready to look at".
export function parsePrList(stdout) {
  let list;
  try { list = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(list)) return null;
  // Never a PR from someone else's fork that happens to share the head ref
  // name: the board would adopt it, and its author closing it would close the
  // card and its agent.
  const open = list.find(pr => (!pr.state || String(pr.state).toUpperCase() === 'OPEN') && !pr.isCrossRepository);
  if (!open) return null;
  return { url: open.url || null, number: open.number ?? null, isDraft: !!open.isDraft };
}

// Parses `gh pr list --head <branch> --state merged --json number,url,state,mergedAt`.
// Returns the merged PR that belongs to THIS job, or null.
//
// The identity check is the whole point, because `--head` matches the head ref
// NAME and that name outlives the branch. A merged PR stays in the listing
// forever, and board branch names are reused: the branch is deleted when its
// agent is retired, which frees the name both locally and (with GitHub's
// delete-on-merge) on the remote, so the next job with the same title gets it
// back. "Some PR on this branch merged" is therefore NOT "this card's PR
// merged", and treating them as the same files a card away for work that is
// still open — taking its PR number with it.
//
//  - `number`: the card's PR of record. When it has one, only that PR can
//    finish it. Nothing else on the branch is this card's PR.
//  - `mergedAfter`: for a card with no PR of record, the earliest merge that
//    could plausibly be its work (when its agent started, or when it reached
//    Review). An older merge belongs to whatever used this branch name before.
//    A PR with no mergedAt cannot be placed in time, so it is rejected — the
//    cost of that is a card staying on the board, which is the safe direction.
//
// `--state merged` already filters server-side; the merged check here is
// belt-and-braces, because a PR CLOSED without merging must never read as
// merged: nothing landed. That case has its own path (parseClosedPr).
export function parseMergedPr(stdout, { number = null, mergedAfter = null } = {}) {
  let list;
  try { list = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(list)) return null;

  const isMerged = pr => !!pr && (pr.mergedAt || String(pr.state || '').toUpperCase() === 'MERGED');
  const shape = pr => ({ url: pr.url || null, number: pr.number ?? null, mergedAt: pr.mergedAt || null });

  if (number != null) {
    const exact = list.find(pr => isMerged(pr) && pr.number === number);
    return exact ? shape(exact) : null;
  }

  const floor = mergedAfter ? Date.parse(mergedAfter) : NaN;
  const candidate = list.find((pr) => {
    if (!isMerged(pr)) return false;
    if (Number.isNaN(floor)) return true;      // nothing to compare against
    const at = Date.parse(pr.mergedAt || '');
    return !Number.isNaN(at) && at >= floor;
  });
  return candidate ? shape(candidate) : null;
}
