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

import { quote } from '../lib/jobs.js';
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
  return !/^(0|false|off|no)$/i.test(String(env.BILLION ?? '').trim());
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
    if (marker !== MARKER.text) {
      throw new Error(`${dir} is a git repository without Billion's ${MARKER.name} marker. If it is Billion's folder, restore the file from its git history (git checkout -- ${MARKER.name}); otherwise point BILLION_DIR somewhere else`);
    }
    return { created: false };
  }
  // Nor a folder with anything in it (BILLION_DIR at a home or projects
  // folder): setting up there would put all of it in Billion's repo, and run
  // Billion in it. Only the template files may be there already.
  // The files an OS leaves in any folder it has shown don't count either;
  // they are ignored, so neither this commit nor any of Billion's takes them.
  const ours = new Set([CHARTER.to, ...Object.values(FIRST_RUN_ONLY), '.gitignore', MARKER.name, ...OS_FILES]);
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


// Everything Billion must do lives in its charter; the prompt only says which
// part applies. A fresh repo gets the introduction. Any later start says both,
// because a restart can land mid-introduction: the charter tells it to finish
// the introduction while STATE.md still says "not started". --continue only
// when a conversation exists, so a lost transcript still starts cleanly.
export function billionCommand({ created, hasConversation, dir, projectsHint }) {
  const where = `Your folder is ${dir}.`;
  const hint = projectsHint
    ? `Suggest ${projectsHint} as the projects folder: most of the owner's repos are there.`
    : 'The owner has no repos yet, so ask for a projects folder without suggesting one.';
  const prompt = created
    ? `This is your first run. Introduce yourself as described in CHARTER.md under "First run". ${where} ${hint}`
    : `You were restarted. If STATE.md still says "Status: not started", do or finish your introduction (CHARTER.md, "First run"). ${hint} Otherwise start your operating loop (CHARTER.md, "Operating loop"). ${where}`;
  return `claude --dangerously-skip-permissions${!created && hasConversation ? ' --continue' : ''} ${quote(prompt)}`;
}

// Claude Code asks whether to trust a folder the first time it runs there, and
// highlights "No, exit". Billion's folder is Agent 007's own, holding only
// what the server put there, so the server answers for it. It acts on what the
// screen shows rather than a fixed key sequence, so a version that highlights
// "Yes" first still gets the right answer: arrow off "No", Enter on "Yes",
// nothing on anything else. The text is everything drawn since the dialog
// settled, which can hold an older drawing too, so the LAST cursor is the one
// on screen now. Claude Code draws with cursor moves, so the stripped text may
// have lost its spaces.
export function trustDialogKey(screenText) {
  if (!/trust\s*this\s*folder/i.test(screenText)) return null;
  const at = screenText.lastIndexOf('❯');
  if (at === -1) return null;
  const selected = screenText.slice(at + 1);
  if (/^\s*Yes,\s*I\s*trust\s*this\s*folder/i.test(selected)) return '\r';
  if (/^\s*No,\s*exit/.test(selected)) return '\x1b[B';
  return null;
}
