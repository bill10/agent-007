import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanFamilies, readMap, familyOverrides, jobSkillFamilies, withSkillFamilies, writeFamiliesPlugin,
  ungroupedNotice, reportUngrouped, frontMatter, sourceFamily, oneLine, DEFAULT_MAP,
} from '../server/skill-families.js';
import { resolveJobSkills, createJob } from '../lib/jobs.js';
import { removeTempDir } from './temp-dir.js';

let root, claudeDir, agentsDir, mapFile, pluginDir;
const skill = (dir, name, description) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
};
const homes = () => ({ claudeDir, agentsDir });
const scan = () => scanFamilies({ claudeDir, agentsDir, map: readMap(mapFile) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a007-families-'));
  claudeDir = join(root, '.claude');
  agentsDir = join(root, '.agents');
  mapFile = join(root, 'skill-families.json');
  pluginDir = join(root, 'plugin');
  const skills = join(claudeDir, 'skills');
  // Two from a lock-file source, one installed in ~/.agents and linked in.
  skill(join(skills, 'copywriting'), 'copywriting', 'Write marketing copy. Also headlines.');
  skill(join(skills, 'seo-audit'), 'seo-audit', 'Audit SEO.');
  skill(join(agentsDir, 'skills', 'hyperframes-cli'), 'hyperframes-cli', '>\n  Render HyperFrames\n  videos from the CLI.');
  symlinkSync(join(agentsDir, 'skills', 'hyperframes-cli'), join(skills, 'hyperframes-cli'), 'dir');
  // gstack: its skills' SKILL.md are links into its own folder.
  skill(join(skills, 'gstack'), 'gstack', 'Router. (gstack)');
  for (const [name, d] of [['ship', 'Ship workflow. (gstack)'], ['browse', 'Drive a browser. (gstack)']]) {
    skill(join(skills, 'gstack', name), name, d);
    mkdirSync(join(skills, name));
    symlinkSync(join(skills, 'gstack', name, 'SKILL.md'), join(skills, name, 'SKILL.md'));
  }
  skill(join(skills, 'csv-summarizer'), 'csv-summarizer', 'Summarise a CSV.');
  writeFileSync(join(agentsDir, '.skill-lock.json'), JSON.stringify({ version: 3, skills: {
    copywriting: { source: 'coreyhaines31/marketingskills' },
    'seo-audit': { source: 'coreyhaines31/marketingskills' },
    'hyperframes-cli': { source: 'heygen-com/hyperframes' },
  } }));
});
afterEach(() => removeTempDir(root));

describe('grouping', () => {
  it('groups by lock-file source and gstack folder, carves engineering out, and leaves the rest ungrouped', () => {
    const s = scan();
    const names = (f) => (s.families.get(f) || []).map(m => m.name);
    expect(names('marketing')).toEqual(['copywriting', 'seo-audit']);
    expect(names('hyperframes')).toEqual(['hyperframes-cli']);
    expect(names('gstack')).toEqual(['browse', 'gstack']);
    // ship from gstack, plus Claude Code's bundled engineering skills.
    expect(names('engineering')).toEqual(['code-review', 'security-review', 'ship', 'simplify']);
    expect(s.ungrouped).toEqual(['csv-summarizer']);
    expect(s.families.get('marketing')[0].line).toBe('Write marketing copy.');
    expect(s.families.get('hyperframes')[0].line).toBe('Render HyperFrames videos from the CLI.');
  });

  it("takes the owner's map over the defaults: a skill moved, a source renamed, null kept listed", () => {
    writeFileSync(mapFile, JSON.stringify({
      skills: { 'csv-summarizer': 'data', browse: null },
      sources: { 'heygen-com/hyperframes': 'video', 'coreyhaines31/marketingskills': null },
    }));
    const s = scan();
    expect(s.families.get('data').map(m => m.name)).toEqual(['csv-summarizer']);
    expect(s.families.get('video').map(m => m.name)).toEqual(['hyperframes-cli']);
    expect(s.families.get('gstack').map(m => m.name)).toEqual(['gstack']);
    expect(s.families.has('marketing')).toBe(false);
    expect(s.ungrouped).toEqual([]);
  });

  it('makes no families when no skills are installed', () => {
    expect(scanFamilies({ claudeDir: join(root, 'none'), agentsDir, map: readMap(mapFile) }).families.size).toBe(0);
  });

  it('reads names, folded descriptions and source names', () => {
    expect(frontMatter('---\nname: "x"\ndescription: |\n  a\n  b\n---\n')).toEqual({ name: 'x', description: 'a b' });
    expect(sourceFamily('Paramchoudhary/ResumeSkills')).toBe('resume');
    expect(sourceFamily('heygen-com/hyperframes')).toBe('hyperframes');
    expect(oneLine('Pre-landing PR review. (gstack)')).toBe('Pre-landing PR review.');
    expect(oneLine('x'.repeat(400)).length).toBe(160);
  });
});

describe('the family skills', () => {
  it('writes one catalog skill per family and removes a family that is gone', () => {
    writeFamiliesPlugin(scan(), pluginDir);
    expect(JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('families');
    const text = readFileSync(join(pluginDir, 'skills', 'marketing', 'SKILL.md'), 'utf8');
    expect(frontMatter(text)).toEqual({ name: 'marketing', description: `${DEFAULT_MAP.summaries.marketing} A family of 2 skills; read this for the catalog.` });
    expect(text).toContain('- `copywriting`: Write marketing copy.');
    writeFileSync(mapFile, JSON.stringify({ skills: { 'hyperframes-cli': null } }));
    writeFamiliesPlugin(scan(), pluginDir);
    expect(existsSync(join(pluginDir, 'skills', 'hyperframes'))).toBe(false);
    expect(readdirSync(join(pluginDir, 'skills')).sort()).toEqual(['engineering', 'gstack', 'marketing']);
  });
});

describe('settings per agent', () => {
  it('sets every member name-only except the families and skills switched on, and leaves the owner\'s own overrides', () => {
    const s = scan();
    const plain = familyOverrides(s, []);
    expect(plain).toMatchObject({ copywriting: 'name-only', ship: 'name-only', 'code-review': 'name-only' });
    expect(plain).not.toHaveProperty('csv-summarizer');
    const card = familyOverrides(s, ['hyperframes', 'engineering']);
    expect(card).not.toHaveProperty('hyperframes-cli');
    expect(card).not.toHaveProperty('ship');
    expect(card).toHaveProperty('copywriting', 'name-only');
    expect(familyOverrides(s, ['review', 'ship'])).not.toHaveProperty('ship');
    expect(familyOverrides(s, [], { copywriting: 'off' })).not.toHaveProperty('copywriting');
    writeFileSync(mapFile, JSON.stringify({ skills: { 'csv-summarizer': 'Bad Name' } }));
    expect(familyOverrides(scan(), [])).not.toHaveProperty('csv-summarizer');
  });

  it('adds the plugin and merges into the spawn\'s --settings JSON', () => {
    const args = withSkillFamilies(['--settings', JSON.stringify({ permissions: { deny: ['x'] } }), 'task'], ['marketing'], { homes: homes(), pluginDir, mapFile, env: {} });
    expect(args.slice(0, 3)).toEqual(['--plugin-dir', pluginDir, '--settings']);
    const settings = JSON.parse(args[3]);
    expect(settings.permissions).toEqual({ deny: ['x'] });
    expect(settings.skillOverrides.copywriting).toBeUndefined();
    expect(settings.skillOverrides.ship).toBe('name-only');
    expect(args.at(-1)).toBe('task');
    expect(args.filter(a => a === '--settings')).toHaveLength(1);
  });

  it('adds --settings when there is none, stays out beside a settings file and when switched off', () => {
    const fresh = withSkillFamilies(['task'], [], { homes: homes(), pluginDir, mapFile, env: {} });
    expect(fresh[2]).toBe('--settings');
    expect(JSON.parse(fresh[3]).skillOverrides['hyperframes-cli']).toBe('name-only');
    expect(withSkillFamilies(['--settings', '/my/settings.json'], [], { homes: homes(), pluginDir, mapFile, env: {} }))
      .toEqual(['--settings', '/my/settings.json']);
    expect(withSkillFamilies(['task'], [], { homes: homes(), pluginDir, mapFile, env: { SKILL_FAMILIES: 'off' } })).toEqual(['task']);
  });
});

describe('defaults', () => {
  it('gives a pull-request card engineering, a no-PR card nothing, and adds the card\'s own', () => {
    expect(jobSkillFamilies({}, true)).toEqual(['engineering']);
    expect(jobSkillFamilies({}, false)).toEqual([]);
    expect(jobSkillFamilies({ skills: ['hyperframes'] }, true)).toEqual(['hyperframes', 'engineering']);
    expect(jobSkillFamilies({ skills: ['engineering'] }, true)).toEqual(['engineering']);
  });

  it('gives Billion marketing and the review skills unless the map says otherwise', () => {
    expect(readMap(mapFile).billion).toEqual(['marketing', 'review', 'code-review', 'security-review', 'cso']);
    writeFileSync(mapFile, JSON.stringify({ billion: ['marketing'] }));
    expect(readMap(mapFile).billion).toEqual(['marketing']);
  });

  it('checks a card\'s skills field', () => {
    expect(resolveJobSkills(undefined)).toEqual({ skills: null });
    expect(resolveJobSkills([])).toEqual({ skills: null });
    expect(resolveJobSkills(' Marketing, hyperframes,marketing')).toEqual({ skills: ['marketing', 'hyperframes'] });
    expect(resolveJobSkills([1]).error).toMatch(/list of skill family names/);
    expect(resolveJobSkills(['../x']).error).toMatch(/not a skill family name/);
    expect(createJob({ title: 't', repoPath: '/r', skills: ['hyperframes'] }).job.skills).toEqual(['hyperframes']);
  });
});

describe('the ungrouped notice', () => {
  it('names the unfiled skills and how to file them, once each', () => {
    const notice = ungroupedNotice(['csv-summarizer'], mapFile);
    expect(notice.headline).toMatch(/1 installed skill fit no skill family/);
    expect(notice.lines.join('\n')).toContain(mapFile);
    expect(ungroupedNotice([])).toBeNull();

    withSkillFamilies([], [], { homes: homes(), pluginDir, mapFile, env: {} });
    const sent = [];
    const send = (session, headline, lines) => { sent.push(lines[0]); return true; };
    expect(reportUngrouped(null, send)).toBe(false);
    expect(reportUngrouped({ id: 'b' }, send)).toBe(true);
    expect(sent).toEqual(['Unfiled: csv-summarizer']);
    expect(reportUngrouped({ id: 'b' }, send)).toBe(false);
  });
});

describe('a card\'s skills on the board', () => {
  it('is taken by every door, edited, carried to its runs and handed to the worker\'s spawn', async () => {
    const { config, sessions } = await import('../server/state.js');
    const { addJob, updateJob, postJobForAgent, editJobForAgent, allJobs, boardSettings, dispatchOnce } = await import('../server/jobs.js');
    const { createRunJob } = await import('../lib/jobs.js');
    const repo = mkdtempSync(join(tmpdir(), 'a007-families-repo-'));
    config.repos = [{ path: repo }];
    config.jobs = [];
    config.jobBoard = null;
    boardSettings();
    sessions.clear();
    const noop = () => {};
    try {
      expect(postJobForAgent({ title: 't', repo, skills: 'nope!' }, noop).error).toMatch(/not a skill family name/);
      const { job } = postJobForAgent({ title: 'video', repo, skills: ['hyperframes'] }, noop);
      expect(job.skills).toEqual(['hyperframes']);
      expect(editJobForAgent({ id: job.id, skills: ['hyperframes', 'marketing'] }, noop).changed).toEqual(['skills']);
      expect(updateJob(job.id, { skills: [] }).job.skills).toBeNull();
      updateJob(job.id, { skills: ['hyperframes'] });
      expect(createRunJob({ ...job, schedule: '@daily' }).job.skills).toEqual(['hyperframes']);
      addJob({ title: 'research', repoPath: repo, requiresPr: false }, noop);
      const metas = [];
      await dispatchOnce(async (command, name, repoPath, branch, owner, meta) => {
        metas.push(meta.skills);
        const session = { id: `s${metas.length}`, name: `A${metas.length}`, command, repoPath, branchName: branch, exited: false };
        sessions.set(session.id, session);
        return { session };
      }, noop);
      expect(metas).toEqual([['hyperframes', 'engineering'], []]);
      expect(allJobs()).toHaveLength(2);
    } finally {
      sessions.clear();
      config.jobs = [];
      removeTempDir(repo);
    }
  });
});
