import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectSkills, findDuplicates, duplicateNotice, reportDuplicates, forgetReportedDuplicates } from '../server/skill-duplicates.js';
import { removeTempDir } from './temp-dir.js';

let root, claudeDir, agentsDir, repo;
const skill = (dir, name, description = 'Does a thing.', body = 'body') => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
};
const find = () => findDuplicates(collectSkills({ claudeDir, agentsDir }, [repo]));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a007-dups-'));
  claudeDir = join(root, '.claude');
  agentsDir = join(root, '.agents');
  repo = join(root, 'repo');
  mkdirSync(join(claudeDir, 'skills'), { recursive: true });
  forgetReportedDuplicates();
});
afterEach(() => removeTempDir(root));

describe('duplicate skills', () => {
  it('finds the same name in two places, and whether the copies match', () => {
    skill(join(claudeDir, 'skills', 'pdf'), 'pdf');
    skill(join(repo, '.claude', 'skills', 'pdf'), 'pdf');
    skill(join(claudeDir, 'skills', 'xlsx'), 'xlsx', 'one');
    skill(join(agentsDir, 'skills', 'xlsx'), 'xlsx', 'two');
    const f = find();
    expect(f.map(x => x.kind)).toEqual([
      'the same skill name "pdf", and the two copies are byte-identical',
      'the same skill name "xlsx", with different contents',
    ]);
    expect(f[0].remove.dir).toBe(join(repo, '.claude', 'skills', 'pdf'));
    expect(duplicateNotice(f[0]).lines.join('\n')).toMatch(/open a PR/);
    expect(duplicateNotice(f[1]).lines.join('\n')).toMatch(/npx skills remove xlsx/);
  });

  it('finds byte-identical folders under different names, but not one skill linked twice', () => {
    skill(join(agentsDir, 'skills', 'a'), 'alpha');
    symlinkSync(join(agentsDir, 'skills', 'a'), join(claudeDir, 'skills', 'linked'), 'dir');
    expect(find()).toEqual([]);
    // No name line, so each is named by its folder; the bytes match.
    for (const d of ['x1', 'x2']) {
      mkdirSync(join(claudeDir, 'skills', d));
      writeFileSync(join(claudeDir, 'skills', d, 'SKILL.md'), '---\ndescription: same\n---\nsame body\n');
    }
    expect(find().map(x => x.kind)).toEqual(['byte-identical folders under different names ("x1" and "x2")']);
  });

  it('finds a skill that says it replaces another installed one', () => {
    skill(join(claudeDir, 'skills', 'old-qa'), 'old-qa', 'Test things.');
    skill(join(claudeDir, 'skills', 'new-qa'), 'new-qa', 'Replaces old-qa with a faster run.');
    skill(join(claudeDir, 'skills', 'stale'), 'stale', 'Deprecated, use fresh instead.');
    skill(join(claudeDir, 'skills', 'fresh'), 'fresh', 'The current one.');
    skill(join(claudeDir, 'skills', 'solo'), 'solo', 'Replaces nothing-installed.');
    const f = find();
    expect(f.map(x => x.kind).sort()).toEqual(['"new-qa" says it replaces "old-qa"', '"stale" says it is replaced by "fresh"']);
    expect(f.map(x => x.remove.name).sort()).toEqual(['old-qa', 'stale']);
  });

  it('leaves gstack\'s intentional aliases alone', () => {
    skill(join(claudeDir, 'skills', 'gstack'), 'gstack');
    skill(join(claudeDir, 'skills', '_gstack-command'), 'gstack');
    skill(join(claudeDir, 'skills', 'connect-chrome'), 'connect-chrome', 'Launch.');
    skill(join(claudeDir, 'skills', 'gstack-connect-chrome'), 'gstack-connect-chrome', 'Launch.');
    expect(find()).toEqual([]);
  });

  it('tells Billion once per finding, and never deletes', () => {
    skill(join(claudeDir, 'skills', 'pdf'), 'pdf');
    skill(join(repo, '.claude', 'skills', 'pdf'), 'pdf');
    const sent = [];
    const send = (_s, headline, lines) => { sent.push(lines[0]); return true; };
    const skills = collectSkills({ claudeDir, agentsDir }, [repo]);
    expect(reportDuplicates(null, send, skills, {})).toBe(0);
    expect(reportDuplicates({ id: 'b' }, send, skills, {})).toBe(1);
    expect(reportDuplicates({ id: 'b' }, send, skills, {})).toBe(0);
    expect(reportDuplicates({ id: 'b' }, send, skills, { SKILL_FAMILIES: '0' })).toBe(0);
    expect(sent[0]).toContain(join(repo, '.claude', 'skills', 'pdf'));
    expect(collectSkills({ claudeDir, agentsDir }, [repo])).toHaveLength(2);
  });
});
