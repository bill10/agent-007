// Skill families (README, "Skill families"). Every Claude Code agent's prompt
// lists every installed skill with its description, and Claude Code cuts that
// listing to about 1% of the context window: past ~150 skills most of them
// show as bare names and get missed. So for the Claude Code agents Agent 007
// starts (never the owner's own sessions, never ~/.claude/settings.json), the
// skills are grouped into families. Each family gets one generated skill whose
// description is a line about the family and whose body is its catalog; the
// members go "name-only" through skillOverrides in the spawn's --settings, so
// they stay invocable by name and lose only their listing description. A card
// names the families its job needs (`skills`), and those stay fully listed.
//
// Grouping, from a scan at every spawn (cheap, and never stale): the
// ~/.agents/.skill-lock.json source a skill was installed from (marketingskills
// → "marketing"), gstack's own folder (its skills are symlinks into
// ~/.claude/skills/gstack) → "gstack", then the purpose map below and the
// owner's skill-families.json in Agent 007's data dir, which win. A skill that
// fits no family stays fully listed, and Billion is told so it can file it.
//
// Plugin skills are left out: Claude Code applies no skillOverrides to them
// (claude 2.1.295's skill listing returns "on" for source "plugin").
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { CONFIG_DIR } from './state.js';
import { skillHomes } from './skills.js';
import { envSwitchOn } from '../lib/helpers.js';

export const FAMILIES_FILE = join(CONFIG_DIR, 'skill-families.json');
export const FAMILIES_PLUGIN_DIR = join(CONFIG_DIR, 'skill-families-plugin');
// The plugin the family skills come in, so they list as families:<family>.
export const FAMILIES_PLUGIN = 'families';

// Purpose families that cut across sources. Engineering is what a card that
// ends in a pull request needs, carved out of gstack and Claude Code's own.
const ENGINEERING = ['ship', 'review', 'investigate', 'qa', 'qa-only', 'code-review', 'simplify', 'security-review',
  'land-and-deploy', 'setup-deploy', 'canary', 'careful', 'guard', 'freeze', 'unfreeze', 'cso', 'benchmark',
  'health', 'retro', 'document-release', 'plan-eng-review', 'test-audit', 'deslop-shared-libs'];
export const DEFAULT_MAP = {
  skills: Object.fromEntries(ENGINEERING.map(name => [name, 'engineering'])),
  summaries: {
    engineering: 'Engineering: ship a PR, code review, debugging, QA, security audit, deploy and safety guards.',
    marketing: 'Marketing: copy, SEO, ads, email, launch, pricing, CRO, analytics and growth.',
    hyperframes: 'HyperFrames video: make, edit, animate or render video and motion graphics from HTML.',
    resume: 'Job search: resumes, cover letters, applications, interviews and salary negotiation.',
    gstack: 'gstack: design and plan reviews, browser automation, office hours and the gstack tools.',
  },
  // Billion's own work is marketing, and it reviews pull requests.
  billion: ['marketing', 'review', 'code-review', 'security-review', 'cso'],
};

// Claude Code's own skills, which are not on disk to scan. Only the ones the
// map files somewhere are listed, each with the line its catalog gives it.
const BUNDLED = {
  'code-review': 'Review the current diff or a PR for correctness bugs.',
  simplify: 'Review changed code for reuse and simplification, then apply the fixes.',
  'security-review': 'Security review of the pending changes on the branch.',
};

const readable = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

// name and description from a SKILL.md's front matter, a folded (>) or
// literal (|) description included.
export function frontMatter(text) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '')?.[1];
  if (!head) return {};
  const lines = head.split(/\r?\n/);
  const field = (key) => {
    const at = lines.findIndex(l => l.startsWith(`${key}:`));
    if (at < 0) return '';
    let value = lines[at].slice(key.length + 1).trim();
    if (/^[>|][-+]?$/.test(value) || value === '') {
      const rest = [];
      for (const l of lines.slice(at + 1)) { if (!/^\s/.test(l)) break; rest.push(l.trim()); }
      value = rest.join(' ');
    }
    return value.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  };
  return { name: field('name'), description: field('description') };
}

// "coreyhaines31/marketingskills" → "marketing", "heygen-com/hyperframes" → "hyperframes".
export const sourceFamily = (source) => {
  const repo = String(source).split('/').pop().toLowerCase();
  return repo.replace(/[-_]?skills?$/, '') || repo;
};

// The catalog's line for a skill: its description's first sentence or so.
const ONE_LINE = 160;
export function oneLine(description) {
  const text = String(description || '').replace(/\s*\(gstack\)\s*$/, '').replace(/\s+/g, ' ').trim();
  const sentence = /^.{20,}?[.!?](?=\s|$)/.exec(text)?.[0] || text;
  return sentence.length > ONE_LINE ? `${sentence.slice(0, ONE_LINE - 1)}…` : sentence;
}

// The owner's map (or Billion's edits to it) over the defaults. A skill mapped
// to null stays fully listed and is not reported as unfiled.
export function readMap(file = FAMILIES_FILE) {
  let own = {};
  try { own = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { /* none yet, or unreadable: defaults */ }
  return {
    skills: { ...DEFAULT_MAP.skills, ...own.skills },
    sources: { ...own.sources },
    summaries: { ...DEFAULT_MAP.summaries, ...own.summaries },
    billion: Array.isArray(own.billion) ? own.billion : DEFAULT_MAP.billion,
  };
}

// Every skill in ~/.claude/skills grouped: { families: Map(family → [{ name,
// line }]), ungrouped: [name] }.
export function scanFamilies({ claudeDir = skillHomes().claudeDir, agentsDir = skillHomes().agentsDir, map = readMap() } = {}) {
  const skillsDir = join(claudeDir, 'skills');
  let gstackDir = join(skillsDir, 'gstack');
  try { gstackDir = realpathSync(gstackDir); } catch { /* no gstack */ }
  gstackDir += sep;
  let lock = {};
  try { lock = JSON.parse(readFileSync(join(agentsDir, '.skill-lock.json'), 'utf8')).skills || {}; } catch { /* no lock file */ }
  const found = [];
  let entries = [];
  try { entries = readdirSync(skillsDir); } catch { /* no skills folder */ }
  for (const entry of entries) {
    const file = join(skillsDir, entry, 'SKILL.md');
    const text = readable(file);
    if (text === null) continue;
    const { name = entry, description } = frontMatter(text);
    let real = file;
    try { real = realpathSync(file); } catch { /* keep the path */ }
    const source = lock[name]?.source || lock[entry]?.source || (real.startsWith(gstackDir) ? 'gstack' : null);
    found.push({ name: name || entry, line: oneLine(description), source });
  }
  // Not on their own: with no skills installed there is nothing to shorten.
  if (found.length) for (const [name, line] of Object.entries(BUNDLED)) if (map.skills[name]) found.push({ name, line, source: null });

  const families = new Map();
  const ungrouped = [];
  for (const skill of found) {
    const family = Object.hasOwn(map.skills, skill.name) ? map.skills[skill.name]
      : skill.source ? (Object.hasOwn(map.sources, skill.source) ? map.sources[skill.source] : sourceFamily(skill.source)) : undefined;
    if (family === undefined) { ungrouped.push(skill.name); continue; }
    if (!family) continue;   // filed as "keep it listed"
    if (!families.has(family)) families.set(family, []);
    families.get(family).push({ name: skill.name, line: skill.line });
  }
  for (const members of families.values()) members.sort((a, b) => a.name.localeCompare(b.name));
  return { families, ungrouped: ungrouped.sort(), summaries: map.summaries };
}

const FAMILY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// One family's generated skill.
export function familySkill(family, members, summary) {
  const about = summary || `${family}: ${members.slice(0, 6).map(m => m.name).join(', ')}${members.length > 6 ? ', …' : ''}.`;
  return [
    '---',
    `name: ${family}`,
    `description: ${JSON.stringify(`${about} A family of ${members.length} skills; read this for the catalog.`)}`,
    '---',
    `# The ${family} skills`,
    '',
    'These skills are installed and listed by name only, to keep your skill listing short.',
    'Each still runs by name with the Skill tool, and its full instructions load then.',
    '',
    ...members.map(m => `- \`${m.name}\`${m.line ? `: ${m.line}` : ''}`),
    '',
  ].join('\n');
}

// The plugin holding one skill per family, rewritten where it changed. Spawns
// read it at start, so a file is only ever replaced whole.
export function writeFamiliesPlugin(scan, dir = FAMILIES_PLUGIN_DIR) {
  const skillsDir = join(dir, 'skills');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  const manifest = JSON.stringify({ name: FAMILIES_PLUGIN, description: 'Skill families generated by Agent 007' }, null, 2);
  if (readable(join(dir, '.claude-plugin', 'plugin.json')) !== manifest) writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), manifest);
  const keep = new Set();
  for (const [family, members] of scan.families) {
    if (!FAMILY_NAME.test(family)) continue;
    keep.add(family);
    const text = familySkill(family, members, scan.summaries[family]);
    const file = join(skillsDir, family, 'SKILL.md');
    if (readable(file) === text) continue;
    mkdirSync(join(skillsDir, family), { recursive: true });
    writeFileSync(file, text);
  }
  for (const old of readdirSync(skillsDir)) if (!keep.has(old)) rmSync(join(skillsDir, old), { recursive: true, force: true });
  return dir;
}

// The skillOverrides for an agent with `on` (family or skill names) switched
// on: every other family member name-only. A skill the owner already set in
// their own settings keeps the owner's setting, since flag settings outrank it.
export function familyOverrides(scan, on = [], ownerOverrides = {}) {
  const enabled = new Set(on);
  const overrides = {};
  for (const [family, members] of scan.families) {
    // A family with no catalog skill (a name the plugin cannot carry) hides nothing.
    if (enabled.has(family) || !FAMILY_NAME.test(family)) continue;
    for (const { name } of members) {
      if (!enabled.has(name) && !Object.hasOwn(ownerOverrides, name)) overrides[name] = 'name-only';
    }
  }
  return overrides;
}

// What a card's worker gets switched on: the families it names, and
// engineering for one that ends in a pull request.
export function jobSkillFamilies(job, requiresPr) {
  return [...new Set([...(Array.isArray(job?.skills) ? job.skills : []), ...(requiresPr ? ['engineering'] : [])])];
}

const ownerOverrides = (claudeDir) => {
  try { return JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).skillOverrides || {}; } catch { return {}; }
};

// A Claude Code spawn's argv with the families in: the generated plugin via
// --plugin-dir (which loads it for this session only and widens no file
// access, unlike --add-dir) and the overrides merged into its --settings JSON.
// A --settings given as a file path is the caller's own: no families then.
export function withSkillFamilies(args, on = [], { homes = skillHomes(), pluginDir = FAMILIES_PLUGIN_DIR, mapFile = FAMILIES_FILE, env = process.env } = {}) {
  if (!envSwitchOn(env.SKILL_FAMILIES)) return args;
  let scan;
  try {
    scan = scanFamilies({ claudeDir: homes.claudeDir, agentsDir: homes.agentsDir, map: readMap(mapFile) });
    lastScan = scan;
    if (!scan.families.size) return args;
    writeFamiliesPlugin(scan, pluginDir);
  } catch (err) {
    console.error('Skill families: left out of this spawn:', err.message);
    return args;
  }
  const skillOverrides = familyOverrides(scan, on, ownerOverrides(homes.claudeDir));
  const at = args.indexOf('--settings');
  let settings = {};
  if (at >= 0) {
    // A catalog with nothing hidden would only add to the listing.
    try { settings = JSON.parse(args[at + 1]); } catch { return args; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return args;
  }
  const merged = JSON.stringify({ ...settings, skillOverrides: { ...skillOverrides, ...settings.skillOverrides } });
  const rest = at >= 0 ? [...args.slice(0, at), '--settings', merged, ...args.slice(at + 2)] : ['--settings', merged, ...args];
  return ['--plugin-dir', pluginDir, ...rest];
}

// The board notice for skills no family takes, or null.
export function ungroupedNotice(names, file = FAMILIES_FILE) {
  if (!names.length) return null;
  return {
    headline: `${names.length} installed skill${names.length === 1 ? '' : 's'} fit no skill family, so every agent still lists ${names.length === 1 ? 'it' : 'them'} in full.`,
    lines: [
      `Unfiled: ${names.join(', ')}`,
      `To file one, add it under "skills" in ${file}: {"skills": {"<skill>": "<family>"}}. A new family name makes a new family; null keeps a skill fully listed and stops this notice for it.`,
    ],
  };
}

// Names already reported this run, so a notice says only what is new. Taken
// from the last spawn's scan, and only once a notice reached a live Billion.
const reported = new Set();
let lastScan = null;
export function reportUngrouped(billion, send) {
  if (!billion || !lastScan) return false;
  const fresh = lastScan.ungrouped.filter(name => !reported.has(name));
  const notice = ungroupedNotice(fresh);
  if (!notice || !send(billion, notice.headline, notice.lines)) return false;
  for (const name of fresh) reported.add(name);
  return true;
}

// The family names as the last spawn's scan found them, for the card form.
// Scanned here when no spawn has yet.
export function knownFamilies(env = process.env) {
  if (!envSwitchOn(env.SKILL_FAMILIES)) return [];
  if (!lastScan) try { lastScan = scanFamilies(); } catch { return []; }
  return [...lastScan.families.keys()].filter(f => FAMILY_NAME.test(f)).sort();
}
