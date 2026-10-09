// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
import { renderVersion, renderNotes, renderNotesBody } from '../public/modules/settings.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const text = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

describe('Settings version line', () => {
  it('shows the version, a newer one and Update', () => {
    const d = text(renderVersion({ version: '0.53.5.0', kind: 'npm', latest: '0.54.0.0' }));
    expect(d.textContent).toContain('Agent 007 0.53.5.0');
    expect(d.textContent).toContain('Version 0.54.0.0 is available');
    expect(d.querySelector('[data-update="start"]').textContent).toBe('Update');
    expect(d.querySelector('[data-update="notes"]').textContent).toBe('What’s new');
    expect(text(renderVersion({ version: '1.0.0.0', kind: 'npm' })).querySelector('[data-update="notes"]')).toBeNull();
    expect(text(renderVersion({ version: '1.0.0.0', kind: 'npm', latest: '2.0.0.0' }, 'updating')).querySelector('[data-update="notes"]')).toBeNull();
  });

  it('shows who Cloudflare Access let in, as text', () => {
    expect(text(renderVersion({ version: '1.0.0.0', kind: 'npm', accessEmail: '<b>ada@example.com</b>' })).textContent).toContain('Signed in through Cloudflare Access as <b>ada@example.com</b>');
    expect(text(renderVersion({ version: '1.0.0.0', kind: 'npm' })).textContent).not.toContain('Cloudflare');
  });

  it('offers Check for updates, and says what it found', () => {
    const cur = { version: '1.0.0.0', kind: 'npm' };
    expect(text(renderVersion(cur)).querySelector('[data-update="check"]').textContent).toBe('Check for updates');
    expect(text(renderVersion({ ...cur, latest: '2.0.0.0' })).querySelector('[data-update="check"]')).not.toBeNull();
    const busy = text(renderVersion(cur, null, 'checking'));
    expect(busy.textContent).toContain('Checking…');
    expect(busy.querySelector('[data-update="check"]')).toBeNull();
    expect(text(renderVersion(cur, null, 'checked')).textContent).toContain('Up to date (version 1.0.0.0)');
    const newer = text(renderVersion({ ...cur, latest: '2.0.0.0' }, null, 'checked'));
    expect(newer.textContent).toContain('Version 2.0.0.0 is available');
    expect(newer.textContent).not.toContain('Up to date');
    const failed = text(renderVersion({ ...cur, checkFailed: true }, null, 'checked'));
    expect(failed.textContent).toContain('The check failed');
    expect(failed.textContent).not.toContain('Up to date');
    expect(failed.querySelector('[data-update="check"]')).not.toBeNull();
    expect(text(renderVersion(cur, 'updating')).querySelector('button')).toBeNull();
  });

  it('shows no check button for npx', () => {
    const npx = text(renderVersion({ version: '1.0.0.0', kind: 'npx', latest: '2.0.0.0' }));
    expect(npx.textContent).toContain('npx runs the latest each start');
    expect(npx.querySelector('button')).toBeNull();
  });

  it('shows each step of an update', () => {
    const info = { version: '1.0.0.0', kind: 'npm', latest: '2.0.0.0' };
    expect(text(renderVersion(info, 'updating')).textContent).toContain('Updating…');
    expect(text(renderVersion({ ...info, updating: { waiting: 3 } }, 'updating')).textContent).toContain('Waiting for 3 busy workers…');
    expect(text(renderVersion(info, 'restarting')).textContent).toContain('Restarting…');
    expect(text(renderVersion({ version: '2.0.0.0', kind: 'npm' }, 'done')).textContent).toContain('Updated to 2.0.0.0');
    const failed = text(renderVersion({ ...info, finished: { code: 1, log: 'EACCES <b>' } }, 'failed'));
    expect(failed.querySelector('.settings-version-error').textContent).toBe('EACCES <b>');
    expect(failed.textContent).toContain('agent007 update');
    expect(failed.querySelector('[data-update="start"]')).toBeNull();
  });
});

describe('What’s new', () => {
  it('renders the CHANGELOG’s markdown, escaped', () => {
    const d = text(renderNotes([
      '## [2.0.0.0] - 2026-10-08', '', '### Added', '',
      '- **Bold.** with `code <x>` and [a link](https://example.com/a) and [bad](javascript:alert(1))',
      '  - nested', '- second', '', 'A paragraph <script>.',
    ].join('\n')));
    expect(d.querySelector('h3').textContent).toBe('2.0.0.0 2026-10-08');
    expect(d.querySelector('h4').textContent).toBe('Added');
    expect(d.querySelector('li strong').textContent).toBe('Bold.');
    expect(d.querySelector('li code').textContent).toBe('code <x>');
    expect(d.querySelectorAll('a')).toHaveLength(1);
    expect(d.querySelector('a').getAttribute('href')).toBe('https://example.com/a');
    expect(d.querySelector('li ul li').textContent).toBe('nested');
    expect(d.querySelectorAll(':scope > ul > li')).toHaveLength(2);
    expect(d.querySelector('p').textContent).toBe('A paragraph <script>.');
    expect(d.querySelector('script')).toBeNull();
  });

  // Value: protects=bold or code that wraps onto an item's next line still renders; fails_when=inline runs line by line again; why_new=the table above has one-line items only; seam=none
  it('formats bold and code that wrap onto the next line', () => {
    const d = text(renderNotes('- **Billion hears when CI\n  finishes.** Runs `npm\n  test`.\n\nA **para\nwraps**.'));
    expect(d.querySelector('li strong').textContent).toBe('Billion hears when CI finishes.');
    expect(d.querySelector('li code').textContent).toBe('npm test');
    expect(d.querySelector('p strong').textContent).toBe('para wraps');
    expect(d.textContent).not.toContain('**');
  });

  // Value: protects=the real CHANGELOG rendering as headings and lists, not raw markdown; fails_when=renderNotes stops matching the CHANGELOG's actual heading or list syntax; why_new=the test above uses a small hand-written sample; seam=none
  it('renders the repo’s own CHANGELOG as headings and lists', () => {
    const log = readFileSync(join(__dirname, '../CHANGELOG.md'), 'utf8');
    const md = log.slice(log.search(/^## \[/m)); // the sections, as the server sends them
    const d = text(renderNotes(md));
    expect(d.querySelectorAll('h3')).toHaveLength(md.match(/^## \[/gm).length);
    expect(d.querySelector('h3').textContent).toMatch(/^\d+\.\d+\.\d+\.\d+ \d{4}-\d\d-\d\d$/);
    expect(d.querySelectorAll('li').length).toBe(md.match(/^\s*[-*] /gm).length);
    for (const el of d.querySelectorAll('h3, h4, li, p')) expect(el.textContent).not.toMatch(/^#|\*\*/);
  });

  it('says when the notes could not load, and links to GitHub', () => {
    const d = text(renderNotesBody({ error: 'Could not load the release notes from GitHub.', url: 'https://github.com/x/CHANGELOG.md' }));
    expect(d.textContent).toContain('Could not load');
    expect(d.querySelector('a').getAttribute('href')).toBe('https://github.com/x/CHANGELOG.md');
    expect(text(renderNotesBody(null)).querySelector('a')).not.toBeNull();
  });
});

describe('Settings agent CLI versions', () => {
  it('shows each CLI\'s version and path, a newer one with Update, and what Restart has to do with it', async () => {
    const { renderClis } = await import('../public/modules/settings.js');
    const agents = ['claude', 'codex', 'gemini'].map(cli => ({ cli, version: `${cli}-raw 1`, path: `/bin/${cli}`, accounts: [] }));
    const d = text(renderClis(agents, { claude: { version: '2.1.295', latest: '2.1.300' }, codex: { version: '0.157.0', latest: '0.157.0' } }));
    expect(d.textContent).toContain('Claude Code 2.1.295 · /bin/claude · Update to 2.1.300');
    expect(d.querySelector('[data-cli-update]').title).toContain('Running agents pick it up on their next Restart.');
    expect(d.textContent).toContain('Codex 0.157.0 · /bin/codex');
    expect(d.textContent).toContain('Gemini CLI gemini-raw 1 · /bin/gemini');
    expect([...d.querySelectorAll('[data-cli-update]')].map(b => b.dataset.cliUpdate)).toEqual(['claude']);
    const codex = [agents[1]];
    expect(text(renderClis(codex, { codex: { version: '0.157.0', updating: true } })).textContent).toContain('Updating…');
    expect(text(renderClis(codex, { codex: { version: '0.158.0', finished: { code: 0, log: '' } } })).textContent).toContain('Updated. Running agents pick it up on their next Restart.');
    const failed = text(renderClis(codex, { codex: { version: '0.157.0', finished: { code: 1, log: '<b>EACCES</b>' } } }));
    expect(failed.querySelector('.settings-version-error').textContent).toBe('<b>EACCES</b>');
    expect(failed.textContent).toContain('codex update');
  });
});
