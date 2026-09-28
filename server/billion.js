// Billion — the one agent you talk to (docs/BILLION.md).
//
// A repo-less agent whose working directory is its own git repo, holding its
// charter and memory. The server starts it on boot (unless it is off, see
// billionRuns), resuming the last conversation when there is one. Everything here is pure or touches only
// Billion's own folder; spawning it is server.js's job, like every session.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { CONFIG_DIR, sessions } from './state.js';
import { authEnabled } from './auth.js';
import { HANDOVER_FILE, CLI_NAMES } from './billion-handover.js';

import { quote, isCodexSessionId } from '../lib/jobs.js';
import { envSwitchOn } from '../lib/helpers.js';
export { BILLION_NAME } from '../lib/jobs.js';

const TEMPLATE_DIR = fileURLToPath(new URL('../templates/billion/', import.meta.url));
// Two owners, two kinds of file. The charter is Agent 007's: rewritten on every
// start, so a new version reaches a Billion that already exists. The rest is
// the owner's and Billion's, copied once and never touched again. CLAUDE.md
// (from owner.md) imports the charter and holds the owner's rules. Neither
// template is named CLAUDE.md here, or an agent working on Agent 007 itself
// would load Billion's instructions as its own.
const CHARTER = { from: 'charter.md', to: 'CHARTER.md' };
const FIRST_RUN_ONLY = { 'owner.md': 'CLAUDE.md', 'STATE.md': 'STATE.md', 'COMPANY.md': 'COMPANY.md' };
// Written by the server, never committed: AGENTS.md is made from two committed
// files (writeAgentsMd), and HANDOVER.md is raw conversation
// (server/billion-handover.js). Kept out through .git/info/exclude, not the
// .gitignore, which is Billion's own committed file.
const AGENTS_MD = 'AGENTS.md';
const GENERATED = [AGENTS_MD, HANDOVER_FILE];
const OS_FILES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
// Written at setup: what makes a folder Billion's. A file name alone is not
// enough (macOS matches CHARTER.md to a project's charter.md).
const MARKER = { name: '.billion', text: 'This folder is Billion\'s, set up by Agent 007.\n' };
// Synchronous, on the server's own thread, so bounded: a global
// commit.gpgsign waiting on a pinentry, or a hook, must not freeze every
// terminal. These commits are Agent 007's own bookkeeping in Billion's folder,
// so the user's signing and hooks are left out of them.
const GIT_TIMEOUT_MS = 15_000;
const git = (dir, args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
const COMMIT = ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify'];

// The running Billion, if there is one.
export function liveBillion() {
  return [...sessions.values()].find(s => s.isBillion && !s.exited) || null;
}

// On unless turned off: BILLION=0 (or false/off/no) in the environment or .env.
export function billionEnabled(env = process.env) {
  return envSwitchOn(env.BILLION);
}

// Whether this server runs Billion. Not with user accounts: Billion belongs
// to no one, so every signed-in user could drive an agent that never asks
// before acting. That waits for a Billion per user.
export function billionRuns(env = process.env) {
  return billionEnabled(env) && !authEnabled();
}

export function billionDir(env = process.env) {
  return env.BILLION_DIR ? resolve(env.BILLION_DIR) : join(CONFIG_DIR, 'billion');
}

// First run: a git repo with the templates, committed. An existing repo is left
// exactly as it is — it is Billion's memory. A folder that exists but is not a
// repo yet (someone made BILLION_DIR by hand) gets the templates it lacks.
//
// A repo without Billion's charter is someone else's (BILLION_DIR pointed at a
// project, say): refused, rather than committing a charter into it and
// starting an agent there that never asks before acting.
export function ensureBillionRepo(dir) {
  if (existsSync(join(dir, '.git'))) {
    let marker = null;
    try { marker = readFileSync(join(dir, MARKER.name), 'utf8'); } catch {}
    // Line endings aside: restored with git on Windows it may come back CRLF.
    if (marker?.replace(/\r\n/g, '\n') !== MARKER.text) {
      throw new Error(`${dir} is a git repository without Billion's ${MARKER.name} marker. If it is Billion's folder, restore the file from its git history (git checkout -- ${MARKER.name}); otherwise point BILLION_DIR somewhere else`);
    }
    return { created: false };
  }
  // Nor a folder with anything in it (BILLION_DIR at a home or projects
  // folder): setting up there would put all of it in Billion's repo, and run
  // Billion in it. Only the template files may be there already.
  // The files an OS leaves in any folder it has shown don't count either;
  // they are ignored, so neither this commit nor any of Billion's takes them.
  const ours = new Set([CHARTER.to, ...Object.values(FIRST_RUN_ONLY), ...GENERATED, '.gitignore', MARKER.name, ...OS_FILES]);
  const theirs = existsSync(dir) ? readdirSync(dir).filter(name => !ours.has(name)) : [];
  if (theirs.length) {
    throw new Error(`${dir} already holds other files (${theirs.slice(0, 3).join(', ')}${theirs.length > 3 ? ', …' : ''}), so it can't be Billion's folder; point BILLION_DIR at a new or empty folder`);
  }
  mkdirSync(dir, { recursive: true });
  for (const [from, to] of [[CHARTER.from, CHARTER.to], ...Object.entries(FIRST_RUN_ONLY)]) {
    const target = join(dir, to);
    if (!existsSync(target)) copyFileSync(join(TEMPLATE_DIR, from), target);
  }
  writeFileSync(join(dir, MARKER.name), MARKER.text);
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, `${OS_FILES.join('\n')}\n`);
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, ['add', '-A']);
  // An identity of its own, so a machine with no git user.name still commits.
  git(dir, ['-c', 'user.name=Billion', '-c', 'user.email=billion@agent-007.local', ...COMMIT, '-m', 'Billion: first run']);
  return { created: true };
}

// Bring CHARTER.md up to this version of Agent 007, before Billion starts.
// Committed on its own — the pathspec leaves anything else Billion had not
// committed exactly as it was — so the upgrade shows in Billion's history as
// what it is. Returns whether it changed.
export function refreshCharter(dir) {
  const target = join(dir, CHARTER.to);
  const text = readFileSync(join(TEMPLATE_DIR, CHARTER.from), 'utf8');
  if (existsSync(target) && readFileSync(target, 'utf8') === text) return false;
  writeFileSync(target, text);
  git(dir, ['add', '--', CHARTER.to]);
  git(dir, ['-c', 'user.name=Agent 007', '-c', 'user.email=agent-007@agent-007.local',
    ...COMMIT, '-m', 'Agent 007: update the charter', '--', CHARTER.to]);
  return true;
}

// Codex reads AGENTS.md, not CLAUDE.md, and follows no @-import. So on every
// start, like the charter, the server writes out what Claude Code would load:
// CLAUDE.md with its @CHARTER.md line replaced by the charter, which keeps the
// owner's rules after it, where they say they take precedence. The owner's
// file is only read. A CLAUDE.md that lost its import gets the charter first.
// ponytail: only @CHARTER.md is expanded; another @-import the owner adds
// reaches Claude Code but not Codex.
const CHARTER_IMPORT = /^@CHARTER\.md[ \t]*$/m;
export function agentsMdText(charter, owner) {
  const head = '<!-- Written by Agent 007 on every start, for Codex, which reads AGENTS.md\n'
    + '     instead of CLAUDE.md: CHARTER.md, then CLAUDE.md, the owner\'s rules. Never\n'
    + '     edit it: it is overwritten. The owner\'s rules go in CLAUDE.md. -->\n\n';
  const body = CHARTER_IMPORT.test(owner)
    ? owner.replace(CHARTER_IMPORT, () => charter.trimEnd())
    : `${charter.trimEnd()}\n\n# From CLAUDE.md: the owner's rules, which take precedence over the charter above\n\n${owner}`;
  return head + body;
}

export function writeAgentsMd(dir) {
  let owner = '';
  try { owner = readFileSync(join(dir, 'CLAUDE.md'), 'utf8'); } catch {}
  writeFileSync(join(dir, AGENTS_MD), agentsMdText(readFileSync(join(dir, CHARTER.to), 'utf8'), owner));
  // Local to this clone and needs no commit, unlike .gitignore.
  const exclude = join(dir, '.git', 'info', 'exclude');
  let text = '';
  try { text = readFileSync(exclude, 'utf8'); } catch {}
  const have = new Set(text.split(/\r?\n/));
  const missing = GENERATED.map(n => `/${n}`).filter(n => !have.has(n));
  if (!missing.length) return;
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

// Which CLI Billion runs on. BILLION_AGENT in .env is the owner's default; a
// switch (the Billion row's button now, a usage limit later) is saved in the
// config dir with the BILLION_AGENT it was made under, and holds until that
// setting changes: an edited .env is the newer word, so it wins again.
export const BILLION_AGENTS = ['claude', 'codex'];
export const billionAgentFile = () => join(CONFIG_DIR, 'billion-agent.json');
const envAgent = (env) => String(env.BILLION_AGENT ?? '').trim().toLowerCase();

export function billionAgent(env = process.env, file = billionAgentFile()) {
  const fromEnv = BILLION_AGENTS.includes(envAgent(env)) ? envAgent(env) : 'claude';
  let saved = null;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  return saved && BILLION_AGENTS.includes(saved.agent) && saved.env === envAgent(env) ? saved.agent : fromEnv;
}

// `reason`: why the server switched it by itself (server/billion-limit.js).
export function saveBillionAgent(agent, env = process.env, file = billionAgentFile(), reason) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ agent, env: envAgent(env), at: new Date().toISOString(), ...(reason ? { reason } : {}) }, null, 2)}\n`);
}

// A misspelt BILLION_AGENT would otherwise be ignored without a word.
export function billionAgentWarning(env = process.env) {
  const raw = envAgent(env);
  return raw && !BILLION_AGENTS.includes(raw) ? `BILLION_AGENT=${env.BILLION_AGENT} is not ${BILLION_AGENTS.join(' or ')}; Billion runs on claude` : null;
}

// The folder holding most of the owner's repos, offered as the place for new
// ones. The most common parent rather than a common prefix: one repo living
// elsewhere must not widen the suggestion to the home directory. Repos inside
// Agent 007's own folder (a worktree added as a repo) are not the owner's
// projects folder and don't count.
export function suggestProjectsDir(repoPaths, { ignoreUnder = CONFIG_DIR } = {}) {
  const inside = (p) => { const r = relative(resolve(ignoreUnder), p); return r && !r.startsWith('..') && !isAbsolute(r); };
  const counts = new Map();
  for (const p of repoPaths) {
    if (inside(resolve(p))) continue;
    const parent = dirname(resolve(p));
    counts.set(parent, (counts.get(parent) || 0) + 1);
  }
  let best = null;
  for (const [dir, n] of counts) if (!best || n > counts.get(best)) best = dir;
  return best;
}


// Claude Code keeps each deferred tool's definition from the moment a
// conversation first loads it (a deferred_tools_record in the transcript), and
// a resumed conversation goes on using that copy, as it does the MCP server's
// instructions. A fresh tools/list, notifications/tools/list_changed and
// loading the tool again with ToolSearch all leave it (Claude Code 2.1.283). So an
// upgrade that changes a board tool leaves a resumed Billion reading the old
// one. Its calls still reach this server, which takes the new fields, so
// Billion only needs telling. This saves the current definitions to file and
// returns the names that differ from the last saved copy: all of them when
// there is none, since the conversation may predate any of them.
export function changedBoardTools(file, tools) {
  let saved = [];
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const before = new Map((Array.isArray(saved) ? saved : []).map(t => [t?.name, JSON.stringify(t)]));
  writeFileSync(file, `${JSON.stringify(tools, null, 2)}\n`);
  return tools.filter(t => before.get(t.name) !== JSON.stringify(t)).map(t => t.name);
}

// A resumed conversation also carries its old habits: hundreds of turns of
// doing it the last charter's way outweigh a re-read CHARTER.md. So the
// restart prompt quotes what changed. This saves the charter to file and
// returns the notice: the paragraphs not in the last saved copy, or, past
// CHARTER_NOTICE_LINES, only their sections' headings. Empty when nothing
// changed. With no saved copy (the first start on this code) it quotes the
// paragraphs on answering the owner outside the terminal, the change a
// resumed Billion is likeliest to have missed.
const CHARTER_NOTICE_LINES = 40;
const paragraphs = (text) => {
  let section = '';
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).flatMap(p => {
    const heading = p.match(/^#+\s+(.*)/);
    if (heading) section = heading[1];
    const body = heading ? p.split('\n').slice(1).join('\n').trim() : p;
    return body ? [{ section, text: body }] : [];
  });
};
export function charterChanges(file, charter) {
  let saved = null;
  try { saved = readFileSync(file, 'utf8'); } catch {}
  writeFileSync(file, charter);
  if (saved === charter) return '';
  const now = paragraphs(charter);
  let changed;
  if (saved === null) {
    changed = now.filter(p => p.section === 'Escalate' && /only in your terminal/.test(p.text));
  } else {
    const before = new Set(paragraphs(saved).map(p => p.text));
    changed = now.filter(p => !before.has(p.text));
  }
  if (!changed.length) return '';
  const lead = 'Your charter changed; these rules replace what you did before.';
  const lines = changed.reduce((n, p) => n + p.text.split('\n').length + 1, 0);
  if (lines > CHARTER_NOTICE_LINES) {
    const sections = [...new Set(changed.map(p => p.section || 'the top'))];
    return `${lead} Read CHARTER.md sections ${sections.map(s => `"${s}"`).join(', ')} now, and follow them over your habits in this conversation.`;
  }
  let section = null;
  const body = changed.map(p => {
    const head = p.section !== section ? `From "${p.section || 'the top'}":\n` : '';
    section = p.section;
    return head + p.text;
  }).join('\n\n');
  return `${lead}\n\n${body}`;
}

// Everything Billion must do lives in its charter; the prompt only says which
// part applies. A fresh repo gets the introduction. Any later start says both,
// because a restart can land mid-introduction: the charter tells it to finish
// the introduction while STATE.md still says "not started". A switch between
// CLIs (`handover`) starts the new one fresh, pointed at STATE.md and
// HANDOVER.md first. Otherwise its own last conversation resumes when there is
// one: Claude Code's --continue, Codex's session in this folder by id
// (`codexSessionId`, never --last, which could reach another folder's).
export function billionCommand({ agent = 'claude', created, hasConversation, codexSessionId, handover, dir, projectsHint, changedTools = [], toolsFile, charterNotice = '' }) {
  const where = `Your folder is ${dir}.`;
  const hint = projectsHint
    ? `Suggest ${projectsHint} as the projects folder: most of the owner's repos are there.`
    : 'The owner has no repos yet, so ask for a projects folder without suggesting one.';
  const cycle = 'Otherwise run one operating cycle (CHARTER.md, "Operating loop"); the server wakes you for the next.';
  const prompt = created
    ? `This is your first run. Introduce yourself as described in CHARTER.md under "First run". ${where} ${hint}`
    : handover
      ? `You now run on ${CLI_NAMES[agent]}, moved over from your previous CLI, and this is a new conversation. Read STATE.md and then ${HANDOVER_FILE} (the end of your last conversation) first. If STATE.md still says "Status: not started", do or finish your introduction (CHARTER.md, "First run"). ${hint} ${cycle} ${where}`
      : `You were restarted. If STATE.md still says "Status: not started", do or finish your introduction (CHARTER.md, "First run"). ${hint} ${cycle} ${where}`;
  const changes = charterNotice ? `\n\n${charterNotice}` : '';
  if (agent === 'codex') {
    const resume = !created && !handover && isCodexSessionId(codexSessionId) ? `resume ${codexSessionId} ` : '';
    return `codex ${resume}--dangerously-bypass-approvals-and-sandbox ${quote(prompt + (resume ? changes : ''))}`;
  }
  const resumed = !created && !handover && hasConversation;
  const stale = resumed && changedTools.length && toolsFile
    ? ` Agent 007 changed these board tools since you last started: ${changedTools.join(', ')}. This conversation keeps the definitions it first loaded, so yours are out of date, and loading them again does not help. Read the current ones in ${toolsFile} and call those tools by it: the board accepts the new fields even where your copy does not list them.`
    : '';
  return `claude --dangerously-skip-permissions${resumed ? ' --continue' : ''} ${quote(prompt + stale + (resumed ? changes : ''))}`;
}

// Without its CLI, Billion's tab runs this instead: one line saying what to
// do, then an exit. Nothing restarts it, so there is no loop; the Start button
// checks for the CLI again. It stays up a moment after printing, since a
// console host can drop the output of a process that exits at once.
export const NO_CLAUDE_NOTICE = 'Billion runs on Claude Code, which is not installed (no "claude" on the PATH Agent 007 was started with). Install it from https://docs.anthropic.com/en/docs/claude-code/setup and press Start next to Billion, or restart Agent 007 with BILLION=0 to turn Billion off.';
export const NO_CODEX_NOTICE = 'Billion runs on Codex, which is not installed (no "codex" on the PATH Agent 007 was started with). Install it (npm install -g @openai/codex) and press Start next to Billion, switch Billion to Claude Code with the button next to its name, or restart Agent 007 with BILLION=0 to turn Billion off.';
export function noClaudeCommand(node = process.execPath, notice = NO_CLAUDE_NOTICE) {
  return `${quote(node)} -e ${quote(`console.log(${JSON.stringify(notice)}); setTimeout(() => {}, 1000)`)}`;
}
export const noAgentCommand = (agent, node = process.execPath) => noClaudeCommand(node, agent === 'codex' ? NO_CODEX_NOTICE : NO_CLAUDE_NOTICE);

// Moving Billion to the other CLI (or `to`): the handover first, then the
// choice saved, then the running one stopped, then the new one started fresh.
// Each step is passed in, so the order is what is tested here; server.js
// supplies the real ones. Mail waiting for the old Billion goes with it
// (`stop` hands it over), and everything else Billion uses (the board, the
// Waiting tab, Telegram) finds whichever Billion is running.
export async function switchBillion({ to, current, currentAgent, dir, writeHandover, saveAgent, stop, start }) {
  const from = current?.agent || currentAgent;
  const target = to ?? BILLION_AGENTS.find(a => a !== from);
  if (!BILLION_AGENTS.includes(target)) return { error: `Billion runs on ${BILLION_AGENTS.join(' or ')}, not ${to}` };
  if (target === from && current && !current.exited) return { error: `Billion already runs on ${CLI_NAMES[target]}` };
  try { writeHandover(dir, { from, to: target }); } catch (err) {
    console.error(`Billion: could not write the handover in ${dir}:`, err.message);
  }
  saveAgent(target);
  const carried = current && !current.exited ? await stop(current) : null;
  return start({ handover: true, carried });
}

// Billion out of the way while the owner's Claude account is swapped
// (server/account-migration.js): its running claude would keep the old
// account's session and could write that account's token back. Stopped
// before, started again after whatever `fn` did, with the mail it had waiting
// carried over, even when fn throws; a restart that fails is reported through
// `failed(error)`, since fn's own result says nothing about it. `live()`,
// `stop(session)` and `start({ carried })` are passed in, so the order is what
// is tested.
export async function withBillionStopped(fn, { live, stop, start, announce = () => {}, failed = () => {} }) {
  const billion = live();
  const carried = billion ? await stop(billion) : null;
  try { return await fn(); } finally {
    if (billion) {
      const started = start({ carried });
      if (started.error) failed(started.error);
      else if (!started.existing) announce(started.session);
    }
  }
}

// Claude Code asks whether to trust a folder the first time it runs there, and
// highlights "No, exit". Billion's folder is Agent 007's own, holding only
// what the server put there, so the server answers for it. Board workers get
// the same answer for a different reason: queueing a job on a repo already
// trusts it (server/claude-trust.js has the trade-off and the opt-out). It acts on what the
// screen shows rather than a fixed key sequence, so a version that highlights
// "Yes" first still gets the right answer: Ctrl-N off "No", Enter on "Yes",
// nothing on anything else. The text is everything drawn since the dialog
// settled, which can hold an older drawing too, so the LAST cursor is the one
// on screen now. Claude Code draws with cursor moves, so the stripped text may
// have lost its spaces.
export function trustDialogKey(screenText) {
  // Both options, not just the phrase: a board worker's screen also shows its
  // job text, which anyone who can post a card chooses.
  if (!/Yes,\s*I\s*trust\s*this\s*folder/i.test(screenText) || !/No,\s*exit/.test(screenText)) return null;
  const at = screenText.lastIndexOf('❯');
  if (at === -1) return null;
  const selected = screenText.slice(at + 1);
  if (/^\s*Yes,\s*I\s*trust\s*this\s*folder/i.test(selected)) return '\r';
  // Ctrl-N, not the down arrow: an arrow starts with ESC, and a lone ESC here
  // is "Esc to cancel", which exits claude. Verified on 2.1.282.
  if (/^\s*No,\s*exit/.test(selected)) return '\x0e';
  return null;
}
