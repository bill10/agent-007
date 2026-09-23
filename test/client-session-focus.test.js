// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { agents, activeSessionId, setActiveSession, setBoardActive } from '../public/modules/state.js';
import { handleSessionCreated } from '../public/modules/terminal.js';

// A new tab takes focus only in the window the server marked `focus` (the one
// that spawned or re-adopted it), or in a window showing no tab at all.
describe('session-created focus', () => {
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
  });

  const created = (sessionId, extra = {}) => handleSessionCreated({ type: 'session-created', sessionId, name: sessionId, state: 'IDLE', ...extra });

  it('a window with no active tab switches to the new one', async () => {
    await created('s1');
    expect(activeSessionId).toBe('s1');
  });

  it('someone else\'s spawn opens quietly beside the active tab', async () => {
    await created('s1');
    await created('s2');
    expect(activeSessionId).toBe('s1');
    expect(agents.has('s2')).toBe(true);
  });

  it('someone else\'s spawn leaves an open job board alone', async () => {
    setBoardActive(true);
    await created('s1');
    expect(activeSessionId).toBe(null);
  });

  it('the spawning window (focus) switches even with a tab already active', async () => {
    await created('s1');
    await created('s2', { focus: true });
    expect(activeSessionId).toBe('s2');
  });
});
