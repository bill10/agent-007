import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, lstatSync, existsSync, realpathSync, utimesSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { planSync, syncSkillStore, summarize, autoSync, readStoreState, writeStoreState, reportStoreConflicts, forgetStoreConflicts } from '../server/skill-store.js';
import { scanFamilies, readMap } from '../server/skill-families.js';
import { removeTempDir } from './temp-dir.js';

let root, homes, backupRoot, mapFile, stateFile;
const skill = (dir, name = dir.split(/[\\/]/).pop(), body = 'body') => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Does ${name}.\n---\n${body}\n`);
};
const claude = (n) => join(homes.claudeDir, 'skills', n);
const codex = (n) => join(homes.codexDir, 'skills', n);
const store = (n) => join(homes.agentsDir, 'skills', n);
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const map = () => readMap(mapFile);
const sync = (opts = {}) => syncSkillStore({ homes, map: map(), backupRoot, now: new Date('2026-10-09T12:00:00Z'), ...opts });
// Every path under root with what it is, to show a dry run touched nothing.
const tree = (dir = root) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  const st = lstatSync(p);
  return st.isSymbolicLink() ? [`${p} -> link`] : st.isDirectory() ? [p, ...tree(p)] : [`${p} ${readFileSync(p, 'utf8')}`];
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a007-store-'));
  homes = { claudeDir: join(root, '.claude'), codexDir: join(root, '.codex'), agentsDir: join(root, '.agents') };
  backupRoot = join(root, '.agent-007', 'skill-backup');
  mapFile = join(root, '.agent-007', 'skill-families.json');
  stateFile = join(root, '.agent-007', 'skill-store.json');
  mkdirSync(join(homes.claudeDir, 'skills'), { recursive: true });
  mkdirSync(join(homes.codexDir, 'skills'), { recursive: true });
  mkdirSync(join(root, '.agent-007'));
  forgetStoreConflicts();
});
afterEach(() => removeTempDir(root));

describe('skill store sync', () => {
  it('moves a Claude-only skill into the store, links it back and keeps a backup', () => {
    skill(claude('copywriting'), 'copywriting', 'v1');
    const r = sync();
    expect(r.moved).toEqual(['copywriting']);
    expect(r.linked).toEqual(['copywriting']);
    expect(readFileSync(join(store('copywriting'), 'SKILL.md'), 'utf8')).toMatch(/v1/);
    expect(isLink(claude('copywriting'))).toBe(true);
    expect(realpathSync(claude('copywriting'))).toBe(realpathSync(store('copywriting')));
    expect(readFileSync(join(r.backup, 'claude', 'copywriting', 'SKILL.md'), 'utf8')).toMatch(/v1/);
    expect(r.backup.startsWith(backupRoot)).toBe(true);
  });

  it('moves a Codex-only skill into the store, with no link left in ~/.codex/skills, and links it for Claude', () => {
    skill(codex('seo-audit'));
    const r = sync();
    expect(r.moved).toEqual(['seo-audit']);
    expect(existsSync(codex('seo-audit'))).toBe(false);
    expect(existsSync(join(store('seo-audit'), 'SKILL.md'))).toBe(true);
    expect(isLink(claude('seo-audit'))).toBe(true);
    expect(existsSync(join(r.backup, 'codex', 'seo-audit', 'SKILL.md'))).toBe(true);
  });

  it('links a skill already in the store that Claude Code cannot see', () => {
    skill(store('ads'));
    const r = sync();
    expect(r).toMatchObject({ moved: [], linked: ['ads'], backup: null });
    expect(isLink(claude('ads'))).toBe(true);
  });

  it('keeps one of identical copies in Claude, Codex and the store', () => {
    for (const p of [claude('pdf'), codex('pdf'), store('pdf')]) skill(p, 'pdf', 'same');
    const r = sync();
    expect(r).toMatchObject({ moved: [], folded: ['pdf'], linked: ['pdf'], conflicts: [] });
    expect(isLink(claude('pdf'))).toBe(true);
    expect(existsSync(codex('pdf'))).toBe(false);
    expect(existsSync(join(r.backup, 'claude', 'pdf', 'SKILL.md')) && existsSync(join(r.backup, 'codex', 'pdf', 'SKILL.md'))).toBe(true);
  });

  it('leaves one name with different contents alone and tells Billion once', () => {
    skill(claude('xlsx'), 'xlsx', 'one');
    skill(codex('xlsx'), 'xlsx', 'two');
    const before = tree();
    const r = sync();
    expect(r.conflicts.map(c => c.name)).toEqual(['xlsx']);
    expect(r.conflicts[0].paths).toEqual([claude('xlsx'), codex('xlsx')]);
    expect(tree()).toEqual(before);
    expect(summarize(r)).toMatch(/Left 1 skill alone \(xlsx: copies with different contents\)/);
    const sent = [];
    const send = (to, headline, lines) => sent.push({ to, headline, lines });
    expect(reportStoreConflicts('billion', send)).toBe(1);
    expect(reportStoreConflicts('billion', send)).toBe(0);
    expect(sent[0].headline).toMatch(/left "xlsx" where it is/);
    expect(sent[0].lines.join('\n')).toMatch(/deletes nothing/);
    expect(reportStoreConflicts(null, send)).toBe(0);
  });

  it('a conflict a send could not deliver is told on the next try', () => {
    skill(claude('xlsx'), 'xlsx', 'one');
    skill(codex('xlsx'), 'xlsx', 'two');
    sync();
    expect(reportStoreConflicts('billion', () => false)).toBe(0);
    expect(reportStoreConflicts('billion', () => true)).toBe(1);
  });

  it('a store copy that differs is a conflict too', () => {
    skill(claude('cro'), 'cro', 'mine');
    skill(store('cro'), 'cro', 'theirs');
    expect(sync().conflicts.map(c => c.paths.length)).toEqual([2]);
    expect(isLink(claude('cro'))).toBe(false);
  });

  it('skips links, synced, .system, gstack and its aliases, folders with .git or .gstack-owned and claudeOnly skills', () => {
    skill(store('linked'));
    symlinkSync(store('linked'), claude('linked'), 'junction');
    skill(join(claude('synced'), 'pdf'));
    skill(claude('synced'));
    skill(codex('.system'));
    skill(join(codex('.system'), 'imagegen'));
    skill(claude('gstack'));
    skill(claude('connect-chrome'));
    skill(codex('gstack-ship'));
    writeFileSync(join(codex('gstack-ship'), '.gstack-owned'), '');
    skill(claude('cloned'));
    mkdirSync(join(claude('cloned'), '.git'));
    skill(claude('mine'));
    writeFileSync(mapFile, JSON.stringify({ claudeOnly: ['mine'] }));
    mkdirSync(claude('not-a-skill'));
    const before = tree();
    const r = sync();
    expect(r).toMatchObject({ moved: [], linked: [], folded: [], conflicts: [], errors: [] });
    expect(tree()).toEqual(before);
  });

  it('skips a folder whose SKILL.md is a link (gstack outside Windows)', (ctx) => {
    skill(join(claude('gstack'), 'ship'), 'ship');
    mkdirSync(claude('ship'));
    try { symlinkSync(join(claude('gstack'), 'ship', 'SKILL.md'), join(claude('ship'), 'SKILL.md'), 'file'); } catch (err) {
      if (err.code === 'EPERM') return ctx.skip();   // Windows without the privilege
      throw err;
    }
    const before = tree();
    expect(sync()).toMatchObject({ moved: [], linked: [], conflicts: [], errors: [] });
    expect(tree()).toEqual(before);
  });

  it('leaves the store alone when ~/.claude/skills or ~/.codex/skills is a link to it', () => {
    skill(store('foo'), 'foo', 'keep');
    skill(codex('bar'));
    removeTempDir(join(homes.claudeDir, 'skills'));
    symlinkSync(join(homes.agentsDir, 'skills'), join(homes.claudeDir, 'skills'), 'junction');
    // ~/.claude/skills is the store: a Codex skill moves in, and needs no link.
    expect(sync()).toMatchObject({ moved: ['bar'], linked: [], folded: [], conflicts: [], errors: [] });
    expect(isLink(claude('bar'))).toBe(false);
    expect(existsSync(join(store('bar'), 'SKILL.md'))).toBe(true);
    removeTempDir(join(homes.codexDir, 'skills'));
    symlinkSync(join(homes.agentsDir, 'skills'), join(homes.codexDir, 'skills'), 'junction');
    const after = tree();
    expect(sync()).toMatchObject({ moved: [], linked: [], folded: [], conflicts: [], errors: [] });
    expect(tree()).toEqual(after);
    expect(readFileSync(join(store('foo'), 'SKILL.md'), 'utf8')).toMatch(/keep/);
  });

  it('creates ~/.claude/skills to link a Codex skill when Claude Code has none yet', () => {
    removeTempDir(join(homes.claudeDir, 'skills'));
    skill(codex('x'));
    expect(sync()).toMatchObject({ moved: ['x'], linked: ['x'], errors: [] });
    expect(isLink(claude('x'))).toBe(true);
  });

  it('a file in the store under the same name is a conflict and nothing moves', () => {
    skill(claude('x'));
    mkdirSync(join(homes.agentsDir, 'skills'), { recursive: true });
    writeFileSync(store('x'), 'file');
    const before = tree();
    expect(sync().conflicts).toMatchObject([{ name: 'x', why: expect.stringMatching(/link or a file/) }]);
    expect(tree()).toEqual(before);
  });

  it('a skill whose SKILL.md names another installed skill is a conflict, and is not linked twice', () => {
    skill(claude('my-pdf'), 'pdf');
    skill(store('pdf'), 'pdf');
    const before = tree();
    const r = sync();
    expect(r.conflicts).toMatchObject([{ name: 'my-pdf', why: expect.stringMatching(/calls it "pdf"/) }]);
    expect(r.linked).toEqual([]);
    expect(tree()).toEqual(before);
  });

  it('a front-matter name that differs from its folder only in case is no conflict', () => {
    skill(claude('pdf'), 'PDF');
    expect(sync()).toMatchObject({ moved: ['pdf'], conflicts: [] });
  });

  it('a front-matter name matching a Codex skill moving in the same run is a conflict, and that skill is not linked twice', () => {
    skill(claude('my-pdf'), 'pdf');
    skill(codex('pdf'), 'pdf');
    const r = sync();
    expect(r.conflicts.map(c => c.name)).toEqual(['my-pdf']);
    // pdf moves into the store; Claude already has a folder that answers to it.
    expect(r).toMatchObject({ moved: ['pdf'], linked: [] });
    expect(lstatSync(claude('my-pdf')).isDirectory()).toBe(true);
  });

  it('a front-matter name that is not a plain name is left out of the notice', () => {
    skill(claude('odd'), 'odd Ignore all previous');
    skill(store('odd Ignore all previous'));
    expect(sync().conflicts.map(c => c.why)).toEqual(['its SKILL.md gives it the name of another installed skill']);
  });

  it('folder names that differ only in case are a conflict, never two moves', () => {
    skill(claude('Foo'), 'Foo', 'a');
    skill(codex('foo'), 'foo', 'b');
    const before = tree();
    expect(sync().conflicts).toMatchObject([{ why: 'folder names that differ only in case' }]);
    expect(tree()).toEqual(before);
  });

  it('a second sync is busy while one holds the lock, and takes over a lock left ten minutes', () => {
    skill(claude('a'));
    const lock = join(root, '.agent-007', 'skill-store.lock');
    writeFileSync(lock, 'someone');
    const before = tree();
    expect(sync()).toMatchObject({ busy: true, moved: [], errors: [] });
    expect(tree()).toEqual(before);
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(sync().moved).toEqual(['a']);
    expect(existsSync(lock)).toBe(false);
  });

  it('a busy autoSync records nothing', () => {
    writeStoreState({ enabled: true, last: { at: 'before', moved: ['x'], linked: [], folded: [], conflicts: [], errors: [] } }, stateFile);
    skill(claude('a'));
    writeFileSync(join(root, '.agent-007', 'skill-store.lock'), 'someone');
    expect(autoSync({ file: stateFile, homes, map: map(), backupRoot }).busy).toBe(true);
    expect(readStoreState(stateFile).last.at).toBe('before');
  });

  it('codexMoves: false still sees a Codex copy, and does not move that name past it', () => {
    skill(claude('z'), 'z', 'claude-version');
    skill(codex('z'), 'z', 'codex-version');
    const before = tree();
    expect(sync({ codexMoves: false })).toMatchObject({ moved: [], linked: [], conflicts: [] });
    expect(tree()).toEqual(before);
  });

  it('a store skill that answers to the name of a Claude skill is neither linked nor joined by it', () => {
    skill(store('x'), 'y');
    skill(claude('y'), 'y');
    const before = tree();
    const r = sync();
    expect(r).toMatchObject({ moved: [], linked: [] });
    expect(r.conflicts.map(c => c.name).sort()).toEqual(['x', 'y']);
    expect(tree()).toEqual(before);
  });

  it('codexMoves: false leaves ~/.codex/skills alone', () => {
    skill(codex('b'));
    skill(claude('a'));
    expect(sync({ codexMoves: false })).toMatchObject({ moved: ['a'] });
    expect(existsSync(join(codex('b'), 'SKILL.md'))).toBe(true);
  });

  it('codexOnly moves a skill into the store without a Claude link', () => {
    skill(claude('vanta'));
    skill(store('codex-tool'));
    writeFileSync(mapFile, JSON.stringify({ codexOnly: ['vanta', 'codex-tool'] }));
    const r = sync();
    expect(r).toMatchObject({ moved: ['vanta'], linked: [] });
    expect(existsSync(claude('vanta')) || existsSync(claude('codex-tool'))).toBe(false);
  });

  it('a dry run says what it would do and changes nothing', () => {
    skill(claude('a'));
    skill(codex('b'));
    skill(store('c'));
    const before = tree();
    const r = sync({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, moved: ['a', 'b'], linked: ['a', 'b', 'c'], backup: null });
    expect(summarize(r)).toBe('Would move 2 skills into the store; would link 3 skills for Claude Code.');
    expect(tree()).toEqual(before);
  });

  // Value: protects=the rollback when linking fails: the moved folder goes back where the CLI had it, the half-made store copy is dropped, and the run reports the error instead of a move; fails_when=the catch stops restoring (a skill vanishes from Codex) or still counts it as moved/linked; why_new=every other test has link() succeed; seam=none (a file where ~/.claude/skills should be makes the real link and mkdir fail)
  it('puts a skill back and reports it when the Claude link cannot be made', () => {
    skill(codex('seo-audit'), 'seo-audit', 'v1');
    skill(store('ads'));
    removeTempDir(join(homes.claudeDir, 'skills'));
    writeFileSync(join(homes.claudeDir, 'skills'), 'not a folder');
    const settled = new Map();
    const r = sync({ settled });
    expect(r).toMatchObject({ moved: [], linked: [], folded: [], backup: null });
    expect(r.errors.map(e => e.name).sort()).toEqual(['ads', 'seo-audit']);
    // Not retried at the next spawn while nothing about them changed.
    expect(sync({ settled, now: new Date('2026-10-09T13:00:00Z') })).toMatchObject({ moved: [], linked: [], errors: [] });
    expect(readFileSync(join(codex('seo-audit'), 'SKILL.md'), 'utf8')).toMatch(/v1/);
    expect(existsSync(store('seo-audit'))).toBe(false);
    expect(existsSync(join(store('ads'), 'SKILL.md'))).toBe(true);
    expect(summarize(r)).toMatch(/^2 failed \(/);
  });

  it.skipIf(process.platform === 'win32')('a store copy that stops part way is dropped, so it is no conflict later', () => {
    skill(claude('z'));
    writeFileSync(join(claude('z'), 'secret'), 'x');
    chmodSync(join(claude('z'), 'secret'), 0o000);
    try {
      const r = sync();
      expect(r.errors.map(e => e.name)).toEqual(['z']);
      expect(existsSync(store('z'))).toBe(false);
      expect(lstatSync(claude('z')).isDirectory()).toBe(true);
    } finally { chmodSync(join(claude('z'), 'secret'), 0o600); }
  });

  it('leaves a folder alone whose relative link points outside it', () => {
    skill(join(root, 'shared'), 'shared');
    skill(claude('foo'));
    symlinkSync(join('..', '..', '..', 'shared'), join(claude('foo'), 'lib'), 'junction');
    // A junction is stored absolute on Windows, where this case cannot occur.
    if (process.platform === 'win32') return;
    const before = tree();
    expect(sync()).toMatchObject({ moved: [], linked: [], errors: [] });
    expect(tree()).toEqual(before);
  });

  it('never removes a store folder it did not make: a name that differs only in Unicode form is one name', () => {
    skill(claude('caf\u00e9'), 'cafe', 'same');
    skill(codex('cafe\u0301'), 'cafe', 'same');
    const r = sync();
    // One folder on a disk that normalises names, two on one that does not: never a failed half.
    expect(r.errors).toEqual([]);
    expect(r.moved.length + r.conflicts.length).toBe(1);
  });

  it('a conflict resolved by editing a nested file is looked at again', () => {
    skill(claude('n'), 'n', 'same');
    skill(codex('n'), 'n', 'same');
    mkdirSync(join(claude('n'), 'scripts'));
    writeFileSync(join(claude('n'), 'scripts', 'x.py'), 'mine');
    const settled = new Map();
    expect(sync({ settled }).conflicts.map(c => c.name)).toEqual(['n']);
    mkdirSync(join(codex('n'), 'scripts'));
    writeFileSync(join(codex('n'), 'scripts', 'x.py'), 'mine');
    expect(sync({ settled, now: new Date('2026-10-09T13:00:00Z') })).toMatchObject({ moved: ['n'], conflicts: [] });
  });

  it('a second run has nothing to do', () => {
    skill(claude('a'));
    skill(codex('b'));
    sync();
    const after = tree();
    const again = sync({ now: new Date('2026-10-09T13:00:00Z') });
    expect(again).toMatchObject({ moved: [], linked: [], folded: [], conflicts: [], errors: [], backup: null });
    expect(summarize(again)).toBe('Nothing to do, every skill is in the store.');
    expect(tree()).toEqual(after);
    expect(planSync({ homes, map: map() })).toMatchObject({ moves: [], links: [], conflicts: [] });
  });

  it('skill families still group a linked skill by its lock-file source', () => {
    skill(claude('copywriting'));
    mkdirSync(homes.agentsDir, { recursive: true });
    writeFileSync(join(homes.agentsDir, '.skill-lock.json'), JSON.stringify({ version: 3, skills: { copywriting: { source: 'coreyhaines31/marketingskills' } } }));
    sync();
    const scan = scanFamilies({ claudeDir: homes.claudeDir, agentsDir: homes.agentsDir, map: map(), listing: null });
    expect(scan.families.get('marketing')).toEqual([{ name: 'copywriting', line: 'Does copywriting.' }]);
    // The lock file is never written.
    expect(JSON.parse(readFileSync(join(homes.agentsDir, '.skill-lock.json'), 'utf8')).skills).toEqual({ copywriting: { source: 'coreyhaines31/marketingskills' } });
  });
});

describe('the server side', () => {
  it('autoSync does nothing until turned on, then records its result', () => {
    skill(claude('a'));
    expect(autoSync({ file: stateFile, homes, map: map(), backupRoot })).toBeNull();
    expect(isLink(claude('a'))).toBe(false);
    expect(readStoreState(stateFile)).toEqual({ enabled: false, last: null });
    writeStoreState({ enabled: true, last: null }, stateFile);
    const r = autoSync({ file: stateFile, homes, map: map(), backupRoot });
    expect(r.moved).toEqual(['a']);
    expect(readStoreState(stateFile).last.moved).toEqual(['a']);
    // A quiet run keeps the last one that did something.
    autoSync({ file: stateFile, homes, map: map(), backupRoot });
    expect(readStoreState(stateFile).last.moved).toEqual(['a']);
  });

  it('autoSync never throws into a spawn, and keeps reporting a conflict it no longer re-hashes', () => {
    writeStoreState({ enabled: true, last: null }, stateFile);
    expect(autoSync({ file: stateFile, homes: { ...homes, agentsDir: null }, backupRoot })).toBeNull();
    skill(claude('xlsx'), 'xlsx', 'one');
    skill(codex('xlsx'), 'xlsx', 'two');
    for (let i = 0; i < 2; i++) expect(autoSync({ file: stateFile, homes, map: map(), backupRoot }).conflicts.map(c => c.name)).toEqual(['xlsx']);
  });
});
