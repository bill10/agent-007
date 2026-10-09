// One skill store (README, "One skill store"). Every skill lives once, in
// ~/.agents/skills/<name>: Codex reads that folder itself, and Claude Code gets
// a link ~/.claude/skills/<name> → ~/.agents/skills/<name>. A real skill folder
// found in ~/.claude/skills or ~/.codex/skills is moved into the store, so a
// skill installed later for either CLI shows up in both.
//
// These are the owner's files, so: off until turned on in Settings (the
// preview first); nothing is deleted, every folder it replaces is moved to
// ~/.agent-007/skill-backup/<time>/ first; one name with different contents in
// two places is left alone and Billion is told; anything already a link is
// left alone (gstack and its aliases, `npx skills` installs), and so are
// ~/.claude/skills/synced (claude.ai's), Codex's .system skills, gstack's own
// checkout and aliases and any folder with a .git or .gstack-owned (another
// tool updates it in place).
// ~/.agents/.skill-lock.json is never written: it lists skills by name, and
// `npx skills update` rewrites the store folder and finds the Claude link
// already pointing at it. A copy-mode reinstall that puts a real folder back
// in ~/.claude/skills is identical, so the next sync folds it in again.
//
// ~/.codex/skills gets no link back: Codex reads ~/.agents/skills already, and
// a second path would list the skill twice. So nothing there moves while a
// Codex session is running, which still has the old path in its prompt.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { CONFIG_DIR, sessions } from './state.js';
import { skillHomes } from './skills.js';
import { folderHash, ALIAS, ALIAS_PAIR } from './skill-duplicates.js';
import { readMap, frontMatter, folderNames, FAMILIES_FILE } from './skill-families.js';

export const STORE_FILE = join(CONFIG_DIR, 'skill-store.json');
export const BACKUP_DIR = join(CONFIG_DIR, 'skill-backup');

// Names never moved: claude.ai's synced skills, gstack's checkout and aliases.
const LEAVE = new Set(['synced', 'gstack', ALIAS, ...ALIAS_PAIR]);
const lstat = (p) => { try { return lstatSync(p); } catch { return null; } };
// The path as the disk spells it, so ~/.agents/Skills and ~/.agents/skills
// are one folder on a disk that ignores case.
const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const nameIn = (dir) => { try { return frontMatter(readFileSync(join(dir, 'SKILL.md'), 'utf8')).name || null; } catch { return null; } };
// The last real sync this server ran, for the conflict notice.
let lastResult = null;
// Whether a Codex agent is running: it read its skills from ~/.codex/skills
// when it started, so nothing there moves under it.
export const codexRunning = () => [...sessions.values()].some(s => s.agent === 'codex' && !s.exited);

// Whether a sync may move this entry: a real skill folder whose SKILL.md is
// not a link, with no .git or .gstack-owned (another tool updates it in place:
// gstack links its per-skill files, or on Windows copies them and marks them).
function movable(dir, entry) {
  if (entry.startsWith('.') || LEAVE.has(entry)) return false;
  const st = lstat(join(dir, entry));
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  const skill = lstat(join(dir, entry, 'SKILL.md'));
  if (!skill || skill.isSymbolicLink()) return false;
  return !existsSync(join(dir, entry, '.git')) && !existsSync(join(dir, entry, '.gstack-owned'));
}

// When a name's copies last changed, so a conflict or a failed move is not
// hashed or retried at every spawn until one of them changes.
const stamp = (dirs) => dirs.map(d => { try { return `${d}:${statSync(d).mtimeMs}:${statSync(join(d, 'SKILL.md')).mtimeMs}`; } catch { return d; } }).join('|');

export function readStoreState(file = STORE_FILE) {
  try { const s = JSON.parse(readFileSync(file, 'utf8')); return { enabled: s.enabled === true, last: s.last || null }; } catch { return { enabled: false, last: null }; }
}
export function writeStoreState(state, file = STORE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

// What a sync would do: { store, claude, moves: [{ name, copies: [{ cli, dir }],
// inStore, link, stamp }], links: [name], conflicts: [{ name, paths, why }] }.
// codexMoves: false leaves ~/.codex/skills alone (a live Codex session still
// reads its skills there). settled: name → { stamp, conflict } from earlier runs.
export function planSync({ homes = skillHomes(), map = readMap(FAMILIES_FILE), codexMoves = true, settled = new Map() } = {}) {
  const store = join(homes.agentsDir, 'skills');
  const claude = join(homes.claudeDir, 'skills');
  const codex = join(homes.codexDir, 'skills');
  const storeReal = real(store);
  // A skills folder that is itself a link to the store is the store: nothing
  // in it moves, and Claude Code then needs no links.
  const isStore = (dir) => !!storeReal && real(dir) === storeReal;
  const claudeLinks = existsSync(homes.claudeDir) && !isStore(claude);
  const claudeOnly = new Set(map.claudeOnly);
  const codexOnly = new Set(map.codexOnly);
  // Grouped without case: on macOS "Foo" and "foo" are one folder.
  const byKey = new Map();
  for (const [cli, dir] of [['claude', claude], ...(codexMoves ? [['codex', codex]] : [])]) {
    if (isStore(dir)) continue;
    for (const entry of folderNames(dir)) {
      if (claudeOnly.has(entry) || !movable(dir, entry)) continue;
      const key = entry.toLowerCase();
      byKey.set(key, [...(byKey.get(key) || []), { cli, name: entry, dir: join(dir, entry) }]);
    }
  }
  // Names a Claude folder already answers to, by folder or front-matter name.
  const served = new Set(folderNames(claude).flatMap(e => [e.toLowerCase(), nameIn(join(claude, e))?.toLowerCase()]));
  // Store folders whose SKILL.md answers to another name: front-matter name →
  // folder. Read once, for the two checks below.
  const storeClaims = new Map();
  for (const e of folderNames(store)) {
    const called = nameIn(join(store, e))?.toLowerCase();
    if (called && called !== e.toLowerCase()) storeClaims.set(called, e);
  }
  // A Codex folder waiting for its session to end still counts: a name it
  // also has is not moved now, or Codex would list it twice.
  const waiting = codexMoves ? new Set() : new Set(folderNames(codex).map(e => e.toLowerCase()));
  const notice = (called) => (/^[\w.:-]{1,64}$/.test(called) ? `its SKILL.md calls it "${called}", and another "${called}" is installed` : 'its SKILL.md gives it the name of another installed skill');
  const moves = [];
  const conflicts = [];
  for (const [key, copies] of byKey) {
    const name = copies[0].name;
    const conflict = (why, paths = copies.map(c => c.dir)) => conflicts.push({ name, paths, why });
    if (waiting.has(key)) continue;
    if (new Set(copies.map(c => c.name)).size > 1) { conflict('folder names that differ only in case'); continue; }
    if (storeClaims.has(key)) { conflict(notice(name), [join(store, storeClaims.get(key)), ...copies.map(c => c.dir)]); continue; }
    const inStore = lstat(join(store, name));
    // A link or a file where the store folder would go: not ours to judge.
    if (inStore && (inStore.isSymbolicLink() || !inStore.isDirectory())) {
      conflict('the store already has a link or a file under that name', [join(store, name), ...copies.map(c => c.dir)]);
      continue;
    }
    // Both CLIs list a skill by its front-matter name, so one installed under
    // another folder name would be listed twice.
    const called = nameIn(copies[0].dir);
    if (called && called.toLowerCase() !== name.toLowerCase()
      && (byKey.has(called.toLowerCase()) || [store, claude, codex].some(d => lstat(join(d, called))))) {
      // The name is the skill author's text: quoted only when it looks like one.
      conflict(notice(called));
      continue;
    }
    const all = inStore ? [join(store, name), ...copies.map(c => c.dir)] : copies.map(c => c.dir);
    const at = stamp(all);
    const before = settled.get(name);
    if (before?.stamp === at) { if (before.conflict) conflicts.push(before.conflict); continue; }
    if (new Set(all.map(d => folderHash(d).digest('hex'))).size > 1) {
      conflict('copies with different contents', all);
      settled.set(name, { stamp: at, conflict: conflicts.at(-1) });
      continue;
    }
    // Linked when Claude Code would have no copy of it after the move.
    const link = !codexOnly.has(name) && (copies.some(c => c.cli === 'claude') || (claudeLinks && !served.has(name.toLowerCase())));
    moves.push({ name, copies, inStore: !!inStore, link, stamp: at });
  }
  // Store skills Claude Code cannot see yet (installed for Codex only), unless
  // a Claude folder already answers to that name, or linking it failed and
  // nothing about it changed since.
  const links = claudeLinks
    ? folderNames(store).filter(name => !name.startsWith('.') && !byKey.has(name.toLowerCase()) && !codexOnly.has(name)
      && !claudeOnly.has(name) && !served.has(name.toLowerCase()) && lstat(join(store, name))?.isDirectory() && lstat(join(store, name, 'SKILL.md'))
      && settled.get(name)?.stamp !== stamp([join(store, name)]))
    : [];
  // A store skill that answers to a name Claude Code already has stays unlinked.
  for (const name of [...links]) {
    const called = nameIn(join(store, name));
    if (!called || called.toLowerCase() === name.toLowerCase() || !(served.has(called.toLowerCase()) || byKey.has(called.toLowerCase()))) continue;
    links.splice(links.indexOf(name), 1);
    conflicts.push({ name, paths: [join(store, name)], why: notice(called) });
  }
  return { store, claude, moves, links, conflicts };
}

const link = (target, at) => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
// Moved, or copied then removed when the backup is on another disk.
function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

// One sync at a time across processes (the server and `agent007 skills
// sync`); a lock left by a crash is taken over after ten minutes. The lock
// holds a token, so a holder only ever removes its own, and a stale one is
// renamed away first: of two takers, only the rename's winner goes on.
export const STALE_LOCK_MS = 10 * 60_000;
function takeLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  const token = randomUUID();
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(file, token, { flag: 'wx' });
      return () => { try { if (readFileSync(file, 'utf8') === token) rmSync(file, { force: true }); } catch { /* gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(file).mtimeMs < STALE_LOCK_MS) return null;
        renameSync(file, `${file}.${token}`);
        rmSync(`${file}.${token}`, { force: true });
      } catch { /* another taker won, or it is gone: try again */ }
    }
  }
  return null;
}

// Runs the plan (or only reports it, dryRun). The result is what Settings and
// `agent007 skills sync` show, and what the conflict notice reads.
export function syncSkillStore({ homes = skillHomes(), map, dryRun = false, backupRoot = BACKUP_DIR, now = new Date(), codexMoves = true, settled = new Map() } = {}) {
  const result = { at: now.toISOString(), dryRun, store: join(homes.agentsDir, 'skills'), moved: [], linked: [], folded: [], conflicts: [], errors: [], backup: null };
  const unlock = dryRun ? () => {} : takeLock(join(dirname(backupRoot), 'skill-store.lock'));
  // Busy is not a failure: nothing is recorded for it.
  if (!unlock) return { ...result, busy: true };
  try {
    const plan = planSync({ homes, ...(map ? { map } : {}), codexMoves, settled });
    result.conflicts = plan.conflicts;
    const backup = join(backupRoot, now.toISOString().replace(/[:.]/g, '-'));
    for (const m of plan.moves) {
      // Copies past the first are byte-identical: kept once, in the backup.
      if (m.copies.length > 1 || m.inStore) result.folded.push(m.name);
      if (!m.inStore) result.moved.push(m.name);
      if (m.link) result.linked.push(m.name);
      if (dryRun) continue;
      const saved = [];
      let created = false;
      const into = join(plan.store, m.name);
      try {
        for (const c of m.copies) {
          const to = join(backup, c.cli, m.name);
          move(c.dir, to);
          saved.push({ ...c, to });
        }
        if (!m.inStore) {
          // Before the copy: one that stops part way is this move's to drop.
          created = true;
          cpSync(saved[0].to, into, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        }
        if (m.link) {
          mkdirSync(plan.claude, { recursive: true });
          link(into, join(plan.claude, m.name));
        }
        settled.delete(m.name);
        result.backup = backup;
      } catch (err) {
        // Put back what was moved, so the CLI that had it still has it, and
        // drop the store copy this move made (the backup has one too); never
        // one it did not make.
        if (created) { try { rmSync(into, { recursive: true, force: true }); } catch { /* left */ } }
        for (const s of saved) { if (!lstat(s.dir)) { try { move(s.to, s.dir); } catch { /* still in the backup */ } } }
        for (const list of [result.moved, result.linked, result.folded]) if (list.at(-1) === m.name) list.pop();
        result.errors.push({ name: m.name, error: process.platform === 'win32' ? `${err.message} (Windows: the link is a junction; check the folder is on a local NTFS drive)` : err.message });
        // Not retried at every spawn until one of its copies changes.
        settled.set(m.name, { stamp: m.stamp, conflict: null });
      }
    }
    for (const name of plan.links) {
      result.linked.push(name);
      if (dryRun) continue;
      try {
        mkdirSync(plan.claude, { recursive: true });
        link(join(plan.store, name), join(plan.claude, name));
      } catch (err) {
        result.linked.pop();
        result.errors.push({ name, error: err.message });
        settled.set(name, { stamp: stamp([join(plan.store, name)]), conflict: null });
      }
    }
  } finally { unlock(); }
  if (!dryRun) lastResult = result;
  return result;
}

const n = (k, one) => `${k} skill${k === 1 ? '' : 's'}${one ? ` ${one}` : ''}`;
// One line for Settings, the CLI and the server log.
export function summarize(r) {
  if (!r) return 'Not run yet.';
  const parts = [];
  if (r.moved.length) parts.push(`${r.dryRun ? 'would move' : 'moved'} ${n(r.moved.length)} into the store`);
  if (r.linked.length) parts.push(`${r.dryRun ? 'would link' : 'linked'} ${n(r.linked.length)} for Claude Code`);
  if (r.folded.length) parts.push(`${r.dryRun ? 'would keep' : 'kept'} one of ${n(r.folded.length, 'with identical copies')}`);
  if (r.conflicts.length) parts.push(`left ${n(r.conflicts.length)} alone (${r.conflicts.map(c => `${c.name}: ${c.why}`).join('; ')})`);
  if (r.errors.length) parts.push(`${r.errors.length} failed (${r.errors.map(e => `${e.name}: ${e.error}`).join('; ')})`);
  const text = parts.length ? parts.join('; ') : 'nothing to do, every skill is in the store';
  return text[0].toUpperCase() + text.slice(1) + '.';
}

// The server's sync: only when the owner turned it on. Never throws.
// Conflicts and failed moves and links wait here until their folders change.
const settled = new Map();
export function autoSync({ file = STORE_FILE, ...opts } = {}) {
  const state = readStoreState(file);
  if (!state.enabled) return null;
  try {
    const r = syncSkillStore({ settled, codexMoves: !codexRunning(), ...opts });
    if (r.busy) return r;
    const changed = r.moved.length || r.linked.length || r.folded.length || r.errors.length;
    // A quiet run keeps the last one that did something on show.
    if (changed || !state.last) writeStoreState({ ...state, last: r }, file);
    if (changed) console.log(`  Skill store: ${summarize(r)}${r.backup ? ` Backup: ${r.backup}` : ''}`);
    return r;
  } catch (err) {
    console.error('Skill store: sync failed:', err.message);
    return null;
  }
}

// Billion is told once per conflict per server run, like a duplicate.
const reported = new Set();
export function reportStoreConflicts(billion, send) {
  if (!billion || !lastResult) return 0;
  let sent = 0;
  for (const c of lastResult.conflicts) {
    const key = c.paths.join('\0');
    if (reported.has(key)) continue;
    if (!send(billion, `Skill store: left "${c.name}" where it is: ${c.why}.`, [
      `Paths: ${c.paths.join(' and ')}`,
      `Suggest keeping one: compare them, then remove the other with the tool that installed it (npx skills remove ${c.name} for a store copy). The next sync moves the one left into ~/.agents/skills. Agent 007 deletes nothing.`,
    ])) break;
    reported.add(key);
    sent++;
  }
  return sent;
}
export const forgetStoreConflicts = () => { reported.clear(); settled.clear(); lastResult = null; };
