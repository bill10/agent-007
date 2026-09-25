// Turns changelog.d/ fragments into a release: run by .github/workflows/release.yml
// on every push to main. PRs never edit VERSION or CHANGELOG.md, so parallel
// PRs cannot conflict on them; each adds its own changelog.d/<slug>.md:
//
//   ---
//   bump: patch
//   ---
//   ### Fixed
//
//   - ...
//
// `node scripts/release.js` collects every fragment, bumps VERSION by the
// largest level among them, writes package.json and package-lock.json's
// MAJOR.MINOR.PATCH, adds a "## [X] - date" section to the top of CHANGELOG.md,
// deletes the fragments and prints the new version. With no fragments it
// changes nothing and prints nothing. See CONTRIBUTING.md "Releases".
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

export const LEVELS = ['major', 'minor', 'patch', 'micro'];

export function parseFragment(text, name = 'fragment') {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const bump = m?.[1].match(/^bump:\s*(\S+)\s*$/m)?.[1];
  if (!LEVELS.includes(bump)) {
    throw new Error(`${name}: needs front matter "---\\nbump: ${LEVELS.join('|')}\\n---"`);
  }
  const body = m[2].trim();
  if (!body) throw new Error(`${name}: has no release notes under its front matter`);
  return { bump, body };
}

// The largest bump wins and zeroes the parts after it: 0.6.6.3 + patch = 0.6.7.0.
export function nextVersion(version, bumps) {
  const parts = version.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`VERSION must be MAJOR.MINOR.PATCH.MICRO, got "${version.trim()}"`);
  }
  const i = Math.min(...bumps.map((b) => LEVELS.indexOf(b)));
  return parts.map((n, j) => (j < i ? n : j === i ? n + 1 : 0)).join('.');
}

export function changelogWith(changelog, version, date, bodies) {
  const section = `## [${version}] - ${date}\n\n${bodies.join('\n\n')}\n\n`;
  const at = changelog.search(/^## \[/m);
  return at === -1 ? `${changelog.trimEnd()}\n\n${section}` : changelog.slice(0, at) + section + changelog.slice(at);
}

export function release(root, date = new Date().toISOString().slice(0, 10)) {
  const dir = join(root, 'changelog.d');
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md').sort() : [];
  if (!names.length) return null;
  const fragments = names.map((n) => parseFragment(readFileSync(join(dir, n), 'utf8'), `changelog.d/${n}`));

  const version = nextVersion(readFileSync(join(root, 'VERSION'), 'utf8'), fragments.map((f) => f.bump));
  const semver = version.split('.').slice(0, 3).join('.');
  writeFileSync(join(root, 'VERSION'), `${version}\n`);
  for (const file of ['package.json', 'package-lock.json']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const json = JSON.parse(readFileSync(path, 'utf8'));
    json.version = semver;
    if (json.packages?.['']) json.packages[''].version = semver;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  }
  const changelog = join(root, 'CHANGELOG.md');
  writeFileSync(changelog, changelogWith(readFileSync(changelog, 'utf8'), version, date, fragments.map((f) => f.body)));
  for (const n of names) rmSync(join(dir, n));
  return version;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const version = release(process.argv[2] || '.');
  if (version) console.log(version);
}
