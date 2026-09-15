// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { agents, setSelf, setActiveSession } from '../public/modules/state.js';
import { updateTabs, updateTopbarAgent } from '../public/modules/terminal.js';

// Double-clicking an agent tab renames it — but only for tabs the viewer owns.
describe('rename an agent from its tab', () => {
  const tabFor = (agent) => {
    document.body.innerHTML = '<div id="terminal-tabs"></div>';
    agents.clear();
    agents.set('s1', { name: 'viper', state: 'IDLE', ...agent });
    updateTabs();
    return document.querySelector('.terminal-tab[data-session-id="s1"]');
  };

  beforeEach(() => { send.mockClear(); setSelf('u1', true); });

  it('sends the trimmed new name for the owner', () => {
    globalThis.prompt = vi.fn(() => '  cobra  ');
    const tab = tabFor({ ownerId: 'u1' });
    expect(tab.title).toBe('Double-click to rename');
    tab.dispatchEvent(new MouseEvent('dblclick'));
    expect(send).toHaveBeenCalledWith({ type: 'rename-session', sessionId: 's1', name: 'cobra' });
  });

  it('sends nothing when the prompt is cancelled, blank, or unchanged', () => {
    const tab = tabFor({ ownerId: 'u1' });
    for (const answer of [null, '   ', 'viper', ' viper ']) {
      globalThis.prompt = vi.fn(() => answer);
      tab.dispatchEvent(new MouseEvent('dblclick'));
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('offers a topbar button as the keyboard path, for the owner only', () => {
    document.body.innerHTML = '<div id="terminal-tabs"></div><span id="topbar-agent-info"></span><div id="terminal-panel"></div>';
    agents.clear();
    agents.set('s1', { name: 'viper', state: 'IDLE', ownerId: 'u1' });
    setActiveSession('s1');
    globalThis.prompt = vi.fn(() => 'cobra');
    updateTopbarAgent();
    const btn = document.querySelector('#topbar-agent-info .topbar-rename');
    expect(btn.getAttribute('aria-label')).toBe('Rename agent');
    btn.click();
    expect(send).toHaveBeenCalledWith({ type: 'rename-session', sessionId: 's1', name: 'cobra' });

    agents.get('s1').ownerId = 'u2';
    updateTopbarAgent();
    expect(document.querySelector('#topbar-agent-info .topbar-rename')).toBeNull();
  });

  it("gives another user's tab no rename handler", () => {
    const tab = tabFor({ ownerId: 'u2' });
    expect(tab.ondblclick).toBeFalsy();
    expect(tab.title).not.toBe('Double-click to rename');
  });
});
