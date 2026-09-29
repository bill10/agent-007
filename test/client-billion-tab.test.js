// @vitest-environment happy-dom
// Billion's tab: first, fixed, and replaced in place by a restarted Billion.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { agents, activeSessionId, setActiveSession, setBoardActive, setSelf, setBillionTabOpen, setWaitingActive } from '../public/modules/state.js';
import { handleSessionCreated, updateTabs } from '../public/modules/terminal.js';

beforeEach(() => {
  window.Terminal = class {
    open() {} loadAddon() {} attachCustomKeyEventHandler() {} onData() {}
    scrollToBottom() {} focus() {} dispose() {}
  };
  document.body.innerHTML = '<div id="terminal-viewport"></div><div id="terminal-tabs"></div>'
    + '<div id="status-bar"></div><div id="office-empty"></div><div id="terminal-empty"></div>'
    + '<span id="topbar-agent-info"></span><div id="terminal-panel"></div><div id="job-board"></div>';
  agents.clear();
  setActiveSession(null);
  setBoardActive(false);
  setSelf(null, false);
  setBillionTabOpen(false);
});

const created = (sessionId, extra = {}) => handleSessionCreated({ type: 'session-created', sessionId, name: sessionId, state: 'IDLE', ...extra });
const tabIds = () => [...document.querySelectorAll('.terminal-tab[data-session-id]')].map(t => t.dataset.sessionId);

describe('Billion\'s tab', () => {
  it('is hidden until opened, then comes first, cannot be dragged, and offers no rename', async () => {
    await created('w1');
    await created('b1', { isBillion: true, name: 'Billion' });
    expect(tabIds()).toEqual(['w1']);
    setBillionTabOpen(true);
    updateTabs();
    expect(tabIds()).toEqual(['b1', 'w1']);
    const tab = document.querySelector('.terminal-tab[data-session-id="b1"]');
    expect(tab.draggable).toBe(false);
    expect(tab.title).not.toBe('Double-click to rename');
    expect(document.querySelector('.terminal-tab[data-session-id="w1"]').draggable).toBe(true);
  });

  it('a restarted Billion replaces the stopped tab and keeps focus where it was', async () => {
    await created('b1', { isBillion: true });
    expect(activeSessionId).toBe('b1');
    await created('b2', { isBillion: true });
    expect(agents.has('b1')).toBe(false);
    expect(activeSessionId).toBe('b2');
    expect(tabIds()).toEqual(['b2']);
  });

  it('takes Billion\'s notice from session-created, and a re-emit without one clears it', async () => {
    document.body.innerHTML += '<div id="waiting-board"><div id="waiting-list"></div></div>';
    const { showWaiting } = await import('../public/modules/waiting.js');
    showWaiting();
    await created('b1', { isBillion: true, notice: 'Claude Code says it is not logged in.' });
    expect(document.getElementById('chat-notice').textContent).toMatch(/^Claude Code says it is not logged in\./);
    await created('b1', { isBillion: true, notice: null });
    expect(document.getElementById('chat-notice').hidden).toBe(true);
    setWaitingActive(false);
  });

  it('a restart does not steal focus from another tab', async () => {
    await created('b1', { isBillion: true });
    await created('w1', { focus: true });
    await created('b2', { isBillion: true });
    expect(activeSessionId).toBe('w1');
    expect(tabIds()).toEqual(['b2', 'w1']);
  });
});
