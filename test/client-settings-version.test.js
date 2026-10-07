// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
import { renderVersion } from '../public/modules/settings.js';

const text = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

describe('Settings version line', () => {
  it('shows the version, a newer one and Update', () => {
    const d = text(renderVersion({ version: '0.53.5.0', kind: 'npm', latest: '0.54.0.0' }));
    expect(d.textContent).toContain('Agent 007 0.53.5.0');
    expect(d.textContent).toContain('Version 0.54.0.0 is available');
    expect(d.querySelector('[data-update="start"]').textContent).toBe('Update');
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
