// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
// terminal.js pulls in xterm; the explorer only needs switchToSession from it.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

import { send } from '../public/modules/ws.js';
import { agents, repos, orphans, setActiveSession } from '../public/modules/state.js';
import { renderExplorer } from '../public/modules/explorer.js';

// collapsedRepos is module-level state in explorer.js and survives between
// tests (deliberately: collapse must persist across re-renders), so each test
// uses its own unique repoPath to stay independent.
const EXPLORER_HTML = `
  <div id="explorer-content"></div>
  <div class="spawn-form" id="spawn-form" style="display:none">
    <input type="text" id="spawn-repo">
    <input type="text" id="spawn-name">
  </div>`;

const AGENT = (repoPath, over = {}) => ({
  name: 'Viper', state: 'IDLE', repoPath, branchName: 'branch/viper', color: '#fff',
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = EXPLORER_HTML;
  agents.clear();
  repos.clear();
  orphans.clear();
  setActiveSession(null);
  vi.clearAllMocks();
});

function section(slugText) {
  return [...document.querySelectorAll('.explorer-repo')]
    .find(s => s.querySelector('.explorer-repo-header').textContent.includes(slugText));
}
function headerOf(slugText) {
  return section(slugText).querySelector('.explorer-repo-header');
}

describe('explorer repo section collapse/expand', () => {
  it('configured repo: header click collapses, second click re-expands', () => {
    repos.set('/repos/alpha', { slug: 'alpha', exists: true });
    agents.set('s1', AGENT('/repos/alpha'));
    renderExplorer();

    expect(section('alpha').querySelectorAll('.explorer-branch')).toHaveLength(1);
    expect(headerOf('alpha').textContent).toContain('▾'); // ▾ expanded

    headerOf('alpha').click();
    expect(section('alpha').querySelectorAll('.explorer-branch')).toHaveLength(0);
    expect(headerOf('alpha').textContent).toContain('▸'); // ▸ collapsed

    headerOf('alpha').click();
    expect(section('alpha').querySelectorAll('.explorer-branch')).toHaveLength(1);
    expect(headerOf('alpha').textContent).toContain('▾');
  });

  it('collapsing hides the "(no agents)" placeholder too', () => {
    repos.set('/repos/beta', { slug: 'beta', exists: true });
    renderExplorer();
    expect(section('beta').querySelector('.explorer-no-agents')).not.toBeNull();

    headerOf('beta').click();
    expect(section('beta').querySelector('.explorer-no-agents')).toBeNull();
  });

  it('collapsed state persists across re-renders', () => {
    repos.set('/repos/gamma', { slug: 'gamma', exists: true });
    agents.set('s1', AGENT('/repos/gamma'));
    renderExplorer();

    headerOf('gamma').click();
    renderExplorer(); // e.g. a file-tree update re-renders the panel
    renderExplorer();
    expect(section('gamma').querySelectorAll('.explorer-branch')).toHaveLength(0);
    expect(headerOf('gamma').textContent).toContain('▸');
  });

  it('+ button opens the spawn form without toggling the section', () => {
    repos.set('/repos/delta', { slug: 'delta', exists: true });
    agents.set('s1', AGENT('/repos/delta'));
    renderExplorer();

    headerOf('delta').querySelector('.explorer-icon-btn').click();
    expect(document.getElementById('spawn-form').style.display).toBe('flex');
    expect(document.getElementById('spawn-repo').value).toBe('/repos/delta');
    // stopPropagation: section stays expanded
    expect(section('delta').querySelectorAll('.explorer-branch')).toHaveLength(1);
  });

  it('× button sends remove-repo without toggling the section', () => {
    repos.set('/repos/epsilon', { slug: 'epsilon', exists: true });
    agents.set('s1', AGENT('/repos/epsilon'));
    renderExplorer();

    headerOf('epsilon').querySelector('.explorer-remove-btn').click();
    expect(send).toHaveBeenCalledWith({ type: 'remove-repo', path: '/repos/epsilon' });
    expect(section('epsilon').querySelectorAll('.explorer-branch')).toHaveLength(1);
  });

  it('orphan-only repo section collapses and re-expands', () => {
    orphans.set('o1', { id: 'o1', repoPath: '/repos/zeta', repoSlug: 'zeta', name: 'Ghost', reason: 'stale' });
    renderExplorer();
    expect(section('zeta').querySelector('.explorer-orphan')).not.toBeNull();

    headerOf('zeta').click();
    expect(section('zeta').querySelector('.explorer-orphan')).toBeNull();
    expect(headerOf('zeta').textContent).toContain('▸');

    headerOf('zeta').click();
    expect(section('zeta').querySelector('.explorer-orphan')).not.toBeNull();
  });

  it('collapsed header shows agent count and most urgent state dot', () => {
    repos.set('/repos/eta', { slug: 'eta', exists: true });
    agents.set('s1', AGENT('/repos/eta', { state: 'IDLE' }));
    agents.set('s2', AGENT('/repos/eta', { name: 'Vesper', state: 'MESSAGE' }));
    renderExplorer();
    expect(section('eta').querySelector('.explorer-collapsed-badge')).toBeNull();

    headerOf('eta').click();
    const badge = section('eta').querySelector('.explorer-collapsed-badge');
    expect(badge.textContent).toContain('2');
    expect(badge.querySelector('.explorer-dot').style.background).toBe('var(--state-message)');
  });

  it('header is keyboard-operable and exposes aria-expanded', () => {
    repos.set('/repos/theta', { slug: 'theta', exists: true });
    renderExplorer();
    expect(headerOf('theta').getAttribute('aria-expanded')).toBe('true');

    headerOf('theta').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(headerOf('theta').getAttribute('aria-expanded')).toBe('false');
    expect(headerOf('theta').textContent).toContain('▸');
  });

  it('Enter on a nested header button does not toggle the section', () => {
    repos.set('/repos/kappa', { slug: 'kappa', exists: true });
    agents.set('s1', AGENT('/repos/kappa'));
    renderExplorer();

    headerOf('kappa').querySelector('.explorer-icon-btn')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(headerOf('kappa').getAttribute('aria-expanded')).toBe('true');
    expect(section('kappa').querySelectorAll('.explorer-branch')).toHaveLength(1);
  });

  it('keyboard toggle keeps focus on the header across the re-render', () => {
    repos.set('/repos/lambda', { slug: 'lambda', exists: true });
    renderExplorer();

    headerOf('lambda').focus();
    headerOf('lambda').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.activeElement).toBe(headerOf('lambda'));
    // and toggling works repeatedly
    headerOf('lambda').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(headerOf('lambda').getAttribute('aria-expanded')).toBe('true');
  });

  it('removing a repo clears its collapsed state', () => {
    repos.set('/repos/iota', { slug: 'iota', exists: true });
    renderExplorer();
    headerOf('iota').click();
    expect(headerOf('iota').textContent).toContain('▸');

    headerOf('iota').querySelector('.explorer-remove-btn').click();
    // Re-added later: starts expanded, not mysteriously collapsed
    renderExplorer();
    expect(headerOf('iota').textContent).toContain('▾');
  });

  it('"No repo" section collapses and re-expands', () => {
    agents.set('s1', AGENT(null, { name: 'Loner' }));
    renderExplorer();
    expect(section('No repo').querySelectorAll('.explorer-branch')).toHaveLength(1);

    headerOf('No repo').click();
    expect(section('No repo').querySelectorAll('.explorer-branch')).toHaveLength(0);
    expect(headerOf('No repo').textContent).toContain('▸');

    headerOf('No repo').click();
    expect(section('No repo').querySelectorAll('.explorer-branch')).toHaveLength(1);
  });
});
