// @vitest-environment happy-dom
// Billion's row in the explorer: pinned above the repos, with a Start button
// while it is stopped, and absent on a server that does not run it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

import { send } from '../public/modules/ws.js';
import { switchToSession } from '../public/modules/terminal.js';
import { agents, repos, orphans, setActiveSession, setBillionEnabled, billionFirst } from '../public/modules/state.js';
import { renderExplorer } from '../public/modules/explorer.js';

const row = () => document.querySelector('.explorer-billion');

beforeEach(() => {
  document.body.innerHTML = '<div id="explorer-content"></div>';
  agents.clear();
  repos.clear();
  orphans.clear();
  setActiveSession(null);
  setBillionEnabled(true);
  vi.clearAllMocks();
});

describe('Billion in the explorer', () => {
  it('offers Start while no Billion is running, and sends billion-start without switching', () => {
    renderExplorer();
    expect(row().textContent).toContain('stopped');
    row().querySelector('.explorer-billion-start').click();
    expect(send).toHaveBeenCalledWith({ type: 'billion-start' });
    expect(switchToSession).not.toHaveBeenCalled();
  });

  it('shows a running Billion without Start, first, and not again under "no repo"', () => {
    repos.set('/r/app', { slug: 'app', exists: true });
    agents.set('b', { name: 'Billion', isBillion: true, state: 'WAITING', repoPath: null });
    setActiveSession('b');
    renderExplorer();
    const content = document.getElementById('explorer-content');
    expect(content.firstElementChild).toBe(row());
    expect(row().querySelector('.explorer-billion-start')).toBeNull();
    expect(row().querySelector('.explorer-branch').classList.contains('active')).toBe(true);
    expect(content.querySelectorAll('.explorer-repo')).toHaveLength(2);   // Billion + app, no legacy section
    row().querySelector('.explorer-branch').click();
    expect(switchToSession).toHaveBeenCalledWith('b');
  });

  it('starts a stopped Billion from anywhere on its row, once', () => {
    renderExplorer();
    row().querySelector('.explorer-branch').click();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'billion-start' });
    send.mockClear();
    row().querySelector('.explorer-billion-start').click();   // the button does not also fire the row
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shows red only for a Billion that ran and stopped, grey before it has run', () => {
    renderExplorer();
    expect(row().querySelector('.explorer-dot').style.background).toBe('var(--state-idle)');
    agents.set('b', { name: 'Billion', isBillion: true, state: 'DISCONNECTED' });
    renderExplorer();
    expect(row().querySelector('.explorer-dot').style.background).toBe('var(--state-disconnected)');
  });

  it('treats a disconnected Billion as stopped', () => {
    agents.set('b', { name: 'Billion', isBillion: true, state: 'DISCONNECTED' });
    renderExplorer();
    expect(row().querySelector('.explorer-billion-start')).not.toBeNull();
  });

  it('still says "No repos yet" when Billion is the only agent', () => {
    agents.set('b', { name: 'Billion', isBillion: true, state: 'WAITING' });
    renderExplorer();
    expect(document.querySelector('.explorer-empty').textContent).toBe('No repos yet');
  });

  it('has no row on a server without Billion', () => {
    setBillionEnabled(false);
    renderExplorer();
    expect(row()).toBeNull();
  });
});

describe('billionFirst', () => {
  it('puts Billion first and keeps everyone else in order', () => {
    const m = new Map([['a', {}], ['b', { isBillion: true }], ['c', {}]]);
    expect(billionFirst(m).map(([id]) => id)).toEqual(['b', 'a', 'c']);
  });
});
