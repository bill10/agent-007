// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { agents, repos, orphans, setActiveSession, setView } from '../public/modules/state.js';
import { showJobBoard, hideJobBoard } from '../public/modules/jobs.js';
import { handleFileDiff, closeDiffViewer } from '../public/modules/explorer.js';
import { switchToSession } from '../public/modules/terminal.js';

// Below 700px style.css shows one panel, keyed on body[data-view]; these are
// the state transitions behind it. The nav itself is plain markup + CSS.
const NAV_HTML = `
  <nav class="mobile-nav" id="mobile-nav">
    <button data-view="files">Files</button>
    <button data-view="office" aria-current="true">Office</button>
    <button data-view="terminal">Terminal</button>
  </nav>`;
const PANELS_HTML = `
  <div id="explorer-content"></div>
  <div class="spawn-form" id="spawn-form" style="display:none"></div>
  <canvas id="office-canvas"></canvas>
  <div id="office-empty"></div>
  <div id="diff-viewer" style="display:none">
    <span id="diff-viewer-path"></span><button id="diff-viewer-close"></button>
    <pre id="diff-viewer-content"></pre>
  </div>
  <div id="terminal-tabs"></div>
  <div id="terminal-empty"></div>
  <div id="job-board" style="display:none"></div>`;

const current = () => [...document.querySelectorAll('.mobile-nav button')]
  .filter(b => b.getAttribute('aria-current') === 'true').map(b => b.dataset.view);

beforeEach(() => {
  document.body.innerHTML = NAV_HTML + PANELS_HTML;
  document.body.dataset.view = 'office';
  agents.clear();
  repos.clear();
  orphans.clear();
  setActiveSession(null);
  closeDiffViewer();
  hideJobBoard();
});

describe('setView', () => {
  it('sets body[data-view] and moves aria-current to the matching nav button', () => {
    setView('files');
    expect(document.body.dataset.view).toBe('files');
    expect(current()).toEqual(['files']);
    setView('terminal');
    expect(document.body.dataset.view).toBe('terminal');
    expect(current()).toEqual(['terminal']);
  });

  it('is harmless without the nav in the DOM (desktop-only fixtures)', () => {
    document.body.innerHTML = PANELS_HTML;
    expect(() => setView('terminal')).not.toThrow();
    expect(document.body.dataset.view).toBe('terminal');
  });

  it('an unknown view still lands on the body and clears every nav button', () => {
    setView('nope');
    expect(document.body.dataset.view).toBe('nope');
    expect(current()).toEqual([]);
  });
});

describe('panel changes pick the phone view', () => {
  it('opening a file diff lands on the office panel, closing it returns to files', () => {
    setView('files');
    handleFileDiff({ sessionId: 's1', filePath: 'src/a.js', diff: '@@ -1 +1 @@\n-a\n+b' });
    expect(document.body.dataset.view).toBe('office');
    expect(current()).toEqual(['office']);
    expect(document.getElementById('diff-viewer').style.display).toBe('flex');
    closeDiffViewer();
    expect(document.body.dataset.view).toBe('files');
    closeDiffViewer(); // already closed: a state-change repaint must not move the view
    setView('office');
    closeDiffViewer();
    expect(document.body.dataset.view).toBe('office');
  });

  // Spawns, exits and the reconnect replay all switch sessions or open the
  // board; only a tap on the office canvas moves a phone to the terminal.
  it('switching sessions or opening the board in the background leaves the view alone', () => {
    const termEl = document.createElement('div');
    document.body.appendChild(termEl);
    agents.set('s1', { name: 'Viper', state: 'IDLE', termEl, term: { scrollToBottom() {}, focus() {} } });
    setView('files');
    switchToSession('s1');
    expect(termEl.style.display).toBe('block');
    expect(document.body.dataset.view).toBe('files');
    showJobBoard();
    expect(document.getElementById('job-board').style.display).toBe('flex');
    expect(document.body.dataset.view).toBe('files');
  });
});
