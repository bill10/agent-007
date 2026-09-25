import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseFragment, nextVersion, changelogWith, release } from '../scripts/release.js';

const frag = (bump, body) => `---\nbump: ${bump}\n---\n${body}\n`;

describe('nextVersion', () => {
  it('bumps one part and zeroes the parts after it', () => {
    expect(nextVersion('0.6.6.3', ['micro'])).toBe('0.6.6.4');
    expect(nextVersion('0.6.6.3', ['patch'])).toBe('0.6.7.0');
    expect(nextVersion('0.6.6.3', ['minor'])).toBe('0.7.0.0');
    expect(nextVersion('0.6.6.3\n', ['major'])).toBe('1.0.0.0');
  });

  it('takes the largest level when several fragments land together', () => {
    expect(nextVersion('0.6.6.0', ['micro', 'patch', 'micro'])).toBe('0.6.7.0');
  });

  it('rejects a VERSION that is not four-part', () => {
    expect(() => nextVersion('0.6.6', ['patch'])).toThrow(/MAJOR.MINOR.PATCH.MICRO/);
  });
});

describe('parseFragment', () => {
  it('reads the bump and the notes, CRLF too', () => {
    expect(parseFragment(frag('micro', '### Fixed\n\n- a').replace(/\n/g, '\r\n')))
      .toEqual({ bump: 'micro', body: '### Fixed\n\n- a' });
  });

  it('rejects a missing or unknown bump and empty notes', () => {
    expect(() => parseFragment('### Fixed\n\n- a', 'x.md')).toThrow(/x.md: needs front matter/);
    expect(() => parseFragment(frag('huge', '- a'))).toThrow(/front matter/);
    expect(() => parseFragment(frag('patch', ''))).toThrow(/no release notes/);
  });
});

describe('changelogWith', () => {
  it('puts the new section above the newest one', () => {
    const out = changelogWith('# Changelog\n\nintro\n\n## [0.1.0.0] - 2026-01-01\n\nold\n', '0.1.1.0', '2026-02-02', ['a', 'b']);
    expect(out).toBe('# Changelog\n\nintro\n\n## [0.1.1.0] - 2026-02-02\n\na\n\nb\n\n## [0.1.0.0] - 2026-01-01\n\nold\n');
  });
});

describe('release', () => {
  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'release-'));
    mkdirSync(join(root, 'changelog.d'));
    writeFileSync(join(root, 'VERSION'), '0.6.6.0\n');
    writeFileSync(join(root, 'package.json'), '{\n  "name": "x",\n  "version": "0.6.6"\n}\n');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.6.6', packages: { '': { version: '0.6.6' } } }));
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.6.6.0] - 2026-09-25\n\nold\n');
    writeFileSync(join(root, 'changelog.d', 'README.md'), 'how to write a fragment');
    return root;
  }
  const read = (root, f) => readFileSync(join(root, f), 'utf8');

  it('does nothing without fragments', () => {
    const root = repo();
    expect(release(root)).toBe(null);
    expect(read(root, 'VERSION')).toBe('0.6.6.0\n');
  });

  it('releases two parallel PRs as one version with both notes, and deletes the fragments', () => {
    const root = repo();
    writeFileSync(join(root, 'changelog.d', 'branch-a.md'), frag('micro', '### Fixed\n\n- **A.** from branch a'));
    writeFileSync(join(root, 'changelog.d', 'branch-b.md'), frag('patch', '### Added\n\n- **B.** from branch b'));

    expect(release(root, '2026-09-26')).toBe('0.6.7.0');
    expect(read(root, 'VERSION')).toBe('0.6.7.0\n');
    expect(JSON.parse(read(root, 'package.json')).version).toBe('0.6.7');
    const lock = JSON.parse(read(root, 'package-lock.json'));
    expect([lock.version, lock.packages[''].version]).toEqual(['0.6.7', '0.6.7']);
    expect(read(root, 'CHANGELOG.md')).toBe(
      '# Changelog\n\n## [0.6.7.0] - 2026-09-26\n\n### Fixed\n\n- **A.** from branch a\n\n### Added\n\n- **B.** from branch b\n\n## [0.6.6.0] - 2026-09-25\n\nold\n',
    );
    expect(readdirSync(join(root, 'changelog.d'))).toEqual(['README.md']);
  });

  it('writes nothing when a fragment is malformed', () => {
    const root = repo();
    writeFileSync(join(root, 'changelog.d', 'ok.md'), frag('patch', '- ok'));
    writeFileSync(join(root, 'changelog.d', 'bad.md'), '- no front matter');
    expect(() => release(root)).toThrow(/changelog.d\/bad.md/);
    expect(read(root, 'VERSION')).toBe('0.6.6.0\n');
    expect(readdirSync(join(root, 'changelog.d')).sort()).toEqual(['README.md', 'bad.md', 'ok.md']);
  });
});
