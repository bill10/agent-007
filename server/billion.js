// Billion — the one agent you talk to (docs/BILLION.md).
//
// A repo-less agent whose working directory is its own git repo, holding its
// charter and memory. The server starts it on every boot, resuming the last
// conversation when there is one. Everything here is pure or touches only
// Billion's own folder; spawning it is server.js's job, like every session.

import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { CONFIG_DIR } from './state.js';

export const BILLION_NAME = 'Billion';

const TEMPLATE_DIR = fileURLToPath(new URL('../templates/billion/', import.meta.url));
// Named charter.md in this repo, so an agent working on Agent 007 itself does
// not load Billion's charter as its own instructions.
const TEMPLATE_TARGETS = { 'charter.md': 'CLAUDE.md' };

// On unless turned off: BILLION=0 (or false/off/no) in the environment or .env.
export function billionEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.BILLION ?? '').trim());
}

export function billionDir(env = process.env) {
  return env.BILLION_DIR ? resolve(env.BILLION_DIR) : join(CONFIG_DIR, 'billion');
}

// First run: a git repo with the templates, committed. An existing repo is left
// exactly as it is — it is Billion's memory. A folder that exists but is not a
// repo yet (someone made BILLION_DIR by hand) gets the templates it lacks.
export function ensureBillionRepo(dir) {
  if (existsSync(join(dir, '.git'))) return { created: false };
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(TEMPLATE_DIR)) {
    const target = join(dir, TEMPLATE_TARGETS[name] || name);
    if (!existsSync(target)) copyFileSync(join(TEMPLATE_DIR, name), target);
  }
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(['add', '-A']);
  // An identity of its own, so a machine with no git user.name still commits.
  git(['-c', 'user.name=Billion', '-c', 'user.email=billion@agent-007.local', 'commit', '-q', '-m', 'Billion: first run']);
  return { created: true };
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

// parseCommand() reads double quotes with backslash escapes (lib/jobs.js
// quotes job prompts the same way).
const quote = (text) => `"${String(text).replace(/([\\"])/g, '\\$1')}"`;

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
    ? `This is your first run. Introduce yourself as described in CLAUDE.md under "First run". ${where} ${hint}`
    : `You were restarted. If STATE.md still says "Status: not started", do or finish your introduction (CLAUDE.md, "First run"; ${hint}). Otherwise start your operating loop (CLAUDE.md, "Operating loop"). ${where}`;
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
