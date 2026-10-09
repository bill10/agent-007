// Duplicate and superseded skills (README, "Skill families"). Agent 007 only
// DETECTS them and tells Billion, once per finding per server run; it never
// deletes a skill. The owner's rule: duplicates go, skills a newer one replaces
// go, never-used ones stay.
import { createHash } from 'crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { join } from 'path';
import { skillHomes } from './skills.js';
import { config } from './state.js';
import { frontMatter } from './skill-families.js';
import { envSwitchOn } from '../lib/helpers.js';

// gstack writes these on purpose (gstack-relink's _link_root_skill_alias, and
// the connect-chrome pair), so they are never reported.
const ALIAS = '_gstack-command';
const ALIAS_PAIR = new Set(['connect-chrome', 'gstack-connect-chrome']);

const readable = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

// A hash of every file in a skill folder (paths and bytes, links followed).
function folderHash(dir, hash = createHash('sha256'), rel = '') {
  let names = [];
  try { names = readdirSync(dir).sort(); } catch { return hash; }
  for (const n of names) {
    if (n === '.git' || n === 'node_modules') continue;
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) folderHash(p, hash, `${rel}${n}/`);
    else { try { hash.update(`${rel}${n}\0`).update(readFileSync(p)).update('\0'); } catch { /* unreadable */ } }
  }
  return hash;
}

// Every skill folder in the places skills live: { name, dir, where, kind, hash, head }.
export function collectSkills({ claudeDir, agentsDir } = skillHomes(), repos = (config.repos || []).map(r => r?.path)) {
  const places = [
    { dir: join(claudeDir, 'skills'), where: '~/.claude/skills', kind: 'global' },
    { dir: join(agentsDir, 'skills'), where: '~/.agents/skills', kind: 'global' },
    ...repos.filter(p => typeof p === 'string').map(p => ({ dir: join(p, '.claude', 'skills'), where: `${p}/.claude/skills`, kind: 'repo' })),
  ];
  try {
    const installed = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
    for (const [key, installs] of Object.entries(installed)) {
      for (const i of Array.isArray(installs) ? installs : []) {
        if (i?.installPath) places.push({ dir: join(i.installPath, 'skills'), where: `plugin ${key}`, kind: 'plugin' });
      }
    }
  } catch { /* no plugins */ }
  const seen = new Set();   // one skill reached by two links is one skill
  const skills = [];
  for (const place of places) {
    let entries = [];
    try { entries = readdirSync(place.dir); } catch { continue; }
    for (const entry of entries) {
      const dir = join(place.dir, entry);
      const text = readable(join(dir, 'SKILL.md'));
      if (text === null || entry === ALIAS) continue;
      let real = dir;
      try { real = realpathSync(join(dir, 'SKILL.md')); } catch { /* keep */ }
      if (seen.has(real)) continue;
      seen.add(real);
      skills.push({
        name: frontMatter(text).name || entry, dir, where: place.where, kind: place.kind,
        hash: folderHash(dir).digest('hex'),
        head: /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '',
      });
    }
  }
  return skills;
}

const pairIgnored = (...names) => names.length === 2 && names.every(n => ALIAS_PAIR.has(n));
const SUPERSEDES = /\b(?:replaces|supersedes|deprecates)\s+(?:the\s+)?(?:old\s+)?[`"']?\/?([a-z0-9][a-z0-9_-]*)/gi;
const SUPERSEDED_BY = /\b(?:replaced by|superseded by|deprecated(?:,| in favou?r of| for)?\s+(?:use\s+)?)\s*(?:the\s+)?[`"']?\/?([a-z0-9][a-z0-9_-]*)/gi;

// The findings: [{ key, kind, paths: [a, b], remove: skill, name }].
export function findDuplicates(skills = collectSkills(), agentsDir = skillHomes().agentsDir) {
  const out = [];
  // `npx skills` installs one skill into both ~/.agents/skills and ~/.claude/skills on purpose.
  let locked = {};
  try { locked = JSON.parse(readFileSync(join(agentsDir, '.skill-lock.json'), 'utf8')).skills || {}; } catch { /* no lock */ }
  const mirrored = (a, b) => a.hash === b.hash && Object.hasOwn(locked, a.name)
    && a.kind === 'global' && b.kind === 'global' && new Set([a.where, b.where]).size === 2
    && [a, b].every(s => s.where === '~/.claude/skills' || s.where === '~/.agents/skills');
  const add = (key, kind, a, b, remove) => out.push({ key, kind, paths: [a.dir, b.dir], remove });
  const group = (by) => {
    const m = new Map();
    for (const s of skills) m.set(by(s), [...(m.get(by(s)) || []), s]);
    return [...m.values()].filter(g => g.length > 1);
  };
  // Of two copies, the repo's or the plugin's goes before a global one.
  const removable = (a, b) => (b.kind === 'repo' || (b.kind === 'plugin' && a.kind !== 'repo') ? b : a.kind === 'global' && b.kind === 'global' ? b : a);
  for (const g of group(s => s.name)) {
    const [a, ...rest] = g;
    for (const b of rest) {
      if (mirrored(a, b)) continue;
      const same = a.hash === b.hash;
      add(`name:${a.name}:${a.dir}:${b.dir}`, same ? `the same skill name "${a.name}", and the two copies are byte-identical` : `the same skill name "${a.name}", with different contents`, a, b, removable(a, b));
    }
  }
  for (const g of group(s => s.hash)) {
    const [a, ...rest] = g;
    for (const b of rest) {
      if (a.name === b.name || pairIgnored(a.name, b.name)) continue;   // the first loop has it
      add(`hash:${a.dir}:${b.dir}`, `byte-identical folders under different names ("${a.name}" and "${b.name}")`, a, b, removable(a, b));
    }
  }
  const byName = new Map(skills.map(s => [s.name, s]));
  const claimed = (s, re) => [...s.head.matchAll(re)].map(m => byName.get(m[1])).filter(o => o && o !== s && !pairIgnored(s.name, o.name));
  for (const s of skills) {
    for (const old of claimed(s, SUPERSEDES)) add(`supersedes:${s.name}:${old.dir}`, `"${s.name}" says it replaces "${old.name}"`, s, old, old);
    for (const next of claimed(s, SUPERSEDED_BY)) add(`supersedes:${next.name}:${s.dir}`, `"${s.name}" says it is replaced by "${next.name}"`, next, s, s);
  }
  const keys = new Set();
  return out.filter(f => !keys.has(f.key) && keys.add(f.key));
}

export const duplicateNotice = (f) => ({
  headline: `Two installed skills are duplicates: ${f.kind}.`,
  lines: [
    `Paths: ${f.paths[0]} and ${f.paths[1]}`,
    f.remove.kind === 'repo'
      ? `Suggest removing ${f.remove.dir}: open a PR in that repo that deletes the folder.`
      : f.remove.kind === 'plugin'
        ? `Suggest removing ${f.remove.dir} by uninstalling or disabling its plugin (${f.remove.where}).`
        : `Suggest removing ${f.remove.dir} by uninstalling "${f.remove.name}" with the skills installer (npx skills remove ${f.remove.name}), not by deleting the folder. Agent 007 deletes nothing; never-used skills stay.`,
  ],
});

// Findings already reported this run, one notice each, only to a live Billion.
const reported = new Set();
export function reportDuplicates(billion, send, skills, env = process.env) {
  if (!billion || !envSwitchOn(env.SKILL_FAMILIES)) return 0;
  let sent = 0;
  for (const f of findDuplicates(skills ?? collectSkills())) {
    if (reported.has(f.key)) continue;
    const n = duplicateNotice(f);
    if (!send(billion, n.headline, n.lines)) break;
    reported.add(f.key);
    sent++;
  }
  return sent;
}
export const forgetReportedDuplicates = () => reported.clear();
