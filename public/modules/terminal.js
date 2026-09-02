// Terminal (xterm.js) lifecycle, tabs, session switching, file upload
import { agents, activeSessionId, setActiveSession, stateColor, canControlAgent, boardActive, jobs } from './state.js';
import { send } from './ws.js';
import { escapeHtml, safeColor } from './auth.js';
import { isGlobalShortcut } from './shortcuts.js';
import { stopVoice } from './voice.js';
import { showJobBoard, hideJobBoard } from './jobs.js';
// Circular with office.js (it imports switchToSession), which is fine: both
// sides only call the other's functions at event time, never during load.
import { noteAgentDeparture } from './office.js';

function waitForXterm() {
  return new Promise((resolve) => {
    if (window.Terminal) return resolve();
    const check = setInterval(() => {
      if (window.Terminal) { clearInterval(check); resolve(); }
    }, 50);
  });
}

function getTerminalTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return isLight
    ? {
        // GitHub-light ANSI palette on a warm paper background — the dark
        // palette's cyan/green/yellow were near-invisible on light. The
        // background/foreground/cursor track the CSS light-theme tokens
        // (guarded by test/theme-tokens.test.js); selection is a gold-tinted
        // cream chosen to stay visible against the #f2f0e5 ground.
        background: '#f2f0e5', foreground: '#1c1b1a', cursor: '#7d611f', selectionBackground: '#e4d8ab',
        black: '#24292f',
        red: '#cf222e',
        green: '#1a7f37',
        yellow: '#7d4e00',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        // white / bright entries darkened from stock GitHub-light: that
        // palette assumes a #ffffff ground and loses AA on the cream one.
        white: '#5c6570',
        brightBlack: '#57606a',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#633c01',
        brightBlue: '#0969da',
        brightMagenta: '#8250df',
        brightCyan: '#3192aa',
        brightWhite: '#24292f',
      }
    : {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#7fdbca',
        selectionBackground: '#264f78',
        black: '#6e7681',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#76d9e6',
        white: '#c9d1d9',
        brightBlack: '#8b949e',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#a5d6ff',
        brightWhite: '#f0f3f6',
      };
}

export function updateTerminalThemes() {
  const theme = getTerminalTheme();
  for (const [, agent] of agents) {
    if (agent.term) agent.term.options.theme = theme;
  }
}

// Callbacks set by app.js for cross-module coordination
let onSessionChanged = null;
export function setOnSessionChanged(fn) { onSessionChanged = fn; }

export async function handleSessionCreated(msg) {
  await waitForXterm();
  const { sessionId, name, color, command, state, repoPath, repoSlug, branchName, changedCount, additions, removals, ownerId, ownerName, ownerColor, spawnedBy, jobId } = msg;

  if (agents.has(sessionId)) {
    const a = agents.get(sessionId);
    a.state = state || 'WORKING';
    // Keep ownership fresh if the session is re-emitted (reconnect/reassignment).
    a.ownerId = ownerId || null;
    a.ownerName = ownerName || null;
    a.ownerColor = ownerColor || null;
    updateStatusBar();
    if (onSessionChanged) onSessionChanged();
    return;
  }

  const term = new Terminal({
    theme: getTerminalTheme(),
    // Agents inside the PTY (e.g. Claude Code) pick their own truecolor text
    // for prompts and can't see the browser theme — dark-on-dark otherwise.
    // xterm nudges any foreground below WCAG AA toward readable, live, in
    // both themes, without touching colors that already pass.
    minimumContrastRatio: 4.5,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
  });

  const termEl = document.createElement('div');
  termEl.className = 'terminal-container';
  termEl.style.display = 'none';
  document.getElementById('terminal-viewport').appendChild(termEl);
  term.open(termEl);

  let fitAddon = null;
  if (window.FitAddon) {
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }
  if (window.WebLinksAddon) {
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  }

  // Custom key handler for global shortcuts
  term.attachCustomKeyEventHandler((event) => {
    if (isGlobalShortcut(event)) {
      return false;
    }
    return true;
  });

  agents.set(sessionId, {
    name, color, command, fitAddon,
    state: state || 'WORKING',
    term, termEl,
    ownerId: ownerId || null,
    ownerName: ownerName || null,
    ownerColor: ownerColor || null,
    repoPath: repoPath || null,
    repoSlug: repoSlug || null,
    branchName: branchName || null,
    changedCount: changedCount || 0,
    additions: additions || 0,
    removals: removals || 0,
    fileTree: null,
    conflicts: [],
    spawnedBy: spawnedBy || 'user',
    jobId: jobId || null,
    // Local mirror of the server's lastOutputAt, maintained in handlePtyOutput.
    // The job board uses it to tell "still working" from "parked at a prompt,
    // probably waiting on a human" without any extra server traffic.
    lastOutputAt: Date.now(),
  });

  if (fitAddon) {
    requestAnimationFrame(() => {
      if (termEl.offsetWidth > 0) {
        fitAddon.fit();
        // Only the owner drives the PTY size; viewers fit locally without resizing it.
        if (canControlAgent(agents.get(sessionId))) send({ type: 'pty-resize', sessionId, cols: term.cols, rows: term.rows });
      }
    });
  }

  term.onData((data) => {
    // Read-only for non-owners: don't forward keystrokes (server enforces too).
    if (!canControlAgent(agents.get(sessionId))) return;
    send({ type: 'pty-input', sessionId, data });
  });

  // A board-dispatched agent opens its tab quietly. The dispatcher fires
  // unattended every few minutes, so auto-switching would yank the user out of
  // whatever they were typing — the tab dot, the office character and the job
  // card all still announce it, and clicking any of them jumps here.
  const stealFocus = (spawnedBy || 'user') !== 'board' || !activeSessionId;
  if (stealFocus) switchToSession(sessionId);
  updateTabs();
  updateStatusBar();
  document.getElementById('office-empty').style.display = 'none';
  if (onSessionChanged) onSessionChanged();
}

export function handlePtyOutput(msg) {
  const agent = agents.get(msg.sessionId);
  if (!agent) return;
  const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
  agent.lastOutputAt = Date.now();
  agent.term.write(bytes);
}

export function handleStateChange(msg) {
  const agent = agents.get(msg.sessionId);
  if (!agent) return;
  agent.state = msg.state;
  updateTabs();
  updateStatusBar();
  if (onSessionChanged) onSessionChanged();
}

export function handleSpawnError(msg) {
  const bar = document.getElementById('status-bar');
  bar.textContent = `Error: ${msg.error}`;
  bar.style.color = 'var(--state-disconnected)';
  setTimeout(() => {
    bar.style.color = '';
    updateStatusBar();
  }, 4000);
}

export function handleSessionEnded(msg) {
  const agent = agents.get(msg.sessionId);
  if (!agent) return;
  // The server drops input to an exited session — keeping the mic hot here
  // would transcribe speech into a dead pty forever.
  if (msg.sessionId === activeSessionId) stopVoice({ notice: 'Voice input stopped — agent ended' });
  agent.state = 'DISCONNECTED';

  // A board agent retired after opening its PR takes its tab with it. Under
  // unattended dispatch these arrive steadily, and a row of dead tabs is pure
  // clutter — the job card still carries the agent name, branch and PR link.
  // Agents you spawned yourself keep their tab, as before, so you can read the
  // output and close it when you're ready.
  if (agent.spawnedBy === 'board' && agent.jobId) {
    disposeAgent(msg.sessionId);
    return;
  }

  updateTabs();
  updateStatusBar();
  if (onSessionChanged) onSessionChanged();
}

// Tear down a session's terminal locally. Unlike removeSession() this sends no
// 'kill' — the process is already gone; this only reclaims the client's UI.
function disposeAgent(sessionId) {
  const agent = agents.get(sessionId);
  if (!agent) return;
  agent.term.dispose();
  agent.termEl.remove();
  agents.delete(sessionId);
  if (activeSessionId === sessionId) {
    setActiveSession(null);
    const remaining = [...agents.keys()];
    if (remaining.length > 0) {
      switchToSession(remaining[remaining.length - 1]);
    } else {
      // Nothing left to show. The board is the sensible landing spot: it is
      // what dispatched this agent and it explains where the work went. The
      // office still needs its empty state though — removeSession() sets this
      // too, and without it the office renders a room with no one in it and no
      // explanation.
      document.getElementById('office-empty').style.display = 'flex';
      showJobBoard();
    }
  }
  updateTabs();
  updateStatusBar();
  if (onSessionChanged) onSessionChanged();
}

export function switchToSession(sessionId) {
  // Dictation targets the active session — don't let speech begun for one
  // agent land in another's shell after a tab switch (or auto-switch on kill).
  if (sessionId !== activeSessionId) stopVoice({ notice: 'Voice input stopped — switched agents' });
  hideJobBoard();
  if (activeSessionId && agents.has(activeSessionId)) {
    agents.get(activeSessionId).termEl.style.display = 'none';
  }
  setActiveSession(sessionId);
  const agent = agents.get(sessionId);
  if (!agent) return;
  agent.termEl.style.display = 'block';
  localStorage.setItem('agent007-active-tab', sessionId);
  document.getElementById('terminal-empty').style.display = 'none';
  // Double rAF ensures browser has reflowed after display change
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (agent.fitAddon && agent.termEl.offsetWidth > 0) {
        agent.fitAddon.fit();
        if (canControlAgent(agent)) send({ type: 'pty-resize', sessionId, cols: agent.term.cols, rows: agent.term.rows });
      }
      agent.term.scrollToBottom();
      agent.term.focus();
    });
  });
  updateTabs();
  updateTopbarAgent();
  if (onSessionChanged) onSessionChanged();
}

export function removeSession(sessionId) {
  const agent = agents.get(sessionId);
  if (!agent) return;
  // Confirm before closing agent with a repo (unsaved work will be orphaned)
  if (agent.repoPath && agent.state !== 'DISCONNECTED') {
    if (!confirm(`Close ${agent.name}? Unsaved work will be kept as an orphan.`)) return;
  }
  // Closing the last session never reaches switchToSession, so its stopVoice
  // guard would be bypassed and the mic would stay hot over the empty state.
  if (sessionId === activeSessionId) stopVoice({ notice: 'Voice input stopped — agent closed' });
  if (agent.state !== 'DISCONNECTED') {
    noteAgentDeparture(sessionId); // walk out before the tile disappears
    send({ type: 'kill', sessionId });
  }
  agent.term.dispose();
  agent.termEl.remove();
  agents.delete(sessionId);
  if (activeSessionId === sessionId) {
    setActiveSession(null);
    const remaining = [...agents.keys()];
    if (remaining.length > 0) {
      switchToSession(remaining[remaining.length - 1]);
    } else {
      document.getElementById('terminal-empty').style.display = 'flex';
      document.getElementById('office-empty').style.display = 'flex';
    }
  }
  updateTabs();
  updateStatusBar();
  if (onSessionChanged) onSessionChanged();
}

export function updateTabs() {
  const container = document.getElementById('terminal-tabs');
  container.innerHTML = '';

  // Pinned board tab: always first, never draggable, never closable. It has no
  // data-session-id, so the drag-reorder handler below skips it automatically.
  const boardTab = document.createElement('div');
  boardTab.className = `terminal-tab board-tab${boardActive ? ' active' : ''}`;
  boardTab.title = 'Job board';
  const attention = [...jobs.values()].filter((j) => {
    if (j.state !== 'in-progress' || !j.agentSessionId) return false;
    const a = agents.get(j.agentSessionId);
    // A scheduled run whose agent has gone is a run that FINISHED — that is the
    // completion signal, and the board closes the card out on its next scan.
    // Only a genuine question needs a human, so that is all this counts.
    if (j.type === 'scheduled') return !!a && a.state === 'MESSAGE';
    return !a || a.state === 'MESSAGE' || a.state === 'DISCONNECTED';
  }).length;
  boardTab.innerHTML = '<svg class="board-tab-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1.5" width="2.6" height="9"/><rect x="4.7" y="1.5" width="2.6" height="6"/><rect x="8.4" y="1.5" width="2.6" height="7.5"/></svg>';
  boardTab.appendChild(document.createTextNode('Jobs'));
  if (attention > 0) {
    const badge = document.createElement('span');
    badge.className = 'board-tab-badge';
    badge.textContent = String(attention);
    badge.title = `${attention} job${attention === 1 ? '' : 's'} need attention`;
    boardTab.appendChild(badge);
  }
  boardTab.onclick = () => { showJobBoard(); updateTabs(); };
  container.appendChild(boardTab);

  for (const [sessionId, agent] of agents) {
    const tab = document.createElement('div');
    tab.className = `terminal-tab${sessionId === activeSessionId ? ' active' : ''}`;
    tab.draggable = true;
    tab.dataset.sessionId = sessionId;
    tab.onclick = (e) => {
      if (!e.target.classList.contains('close-btn') && !e.target.classList.contains('upload-btn')) switchToSession(sessionId);
    };
    tab.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', sessionId);
      tab.classList.add('dragging');
    };
    tab.ondragend = () => { tab.classList.remove('dragging'); };
    tab.ondragover = (e) => {
      e.preventDefault();
      const dragging = container.querySelector('.dragging');
      if (dragging && dragging !== tab) {
        const rect = tab.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (e.clientX < mid) {
          container.insertBefore(dragging, tab);
        } else {
          container.insertBefore(dragging, tab.nextSibling);
        }
      }
    };
    tab.ondrop = (e) => {
      e.preventDefault();
      // Rebuild agents Map in new tab order
      const tabs = [...container.querySelectorAll('.terminal-tab[data-session-id]')];
      const newOrder = new Map();
      for (const t of tabs) {
        const id = t.dataset.sessionId;
        if (agents.has(id)) newOrder.set(id, agents.get(id));
      }
      // Add any agents not in tabs (shouldn't happen but be safe)
      for (const [id, agent] of agents) {
        if (!newOrder.has(id)) newOrder.set(id, agent);
      }
      agents.clear();
      for (const [id, agent] of newOrder) agents.set(id, agent);
      localStorage.setItem('agent007-tab-order', JSON.stringify([...agents.keys()]));
      if (onSessionChanged) onSessionChanged();
    };
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = stateColor(agent.state);
    tab.appendChild(dot);
    if (agent.spawnedBy === 'board') tab.classList.add('board-spawned');
    tab.appendChild(document.createTextNode(agent.name));
    const close = document.createElement('span');
    close.className = 'close-btn';
    close.textContent = '\u00d7';
    close.onclick = (e) => { e.stopPropagation(); removeSession(sessionId); };
    tab.appendChild(close);
    container.appendChild(tab);
  }
}

export function updateTopbarAgent() {
  const el = document.getElementById('topbar-agent-info');
  if (!el) return;
  if (!activeSessionId) {
    el.innerHTML = '';
    return;
  }
  const agent = activeSessionId ? agents.get(activeSessionId) : null;
  // Read-only visual treatment, recomputed here so it stays fresh even if identity
  // (welcome) or ownership arrives after the tab was switched.
  const panel = document.getElementById('terminal-panel');
  if (panel) panel.classList.toggle('readonly', !!agent && !canControlAgent(agent));
  if (!agent) { el.innerHTML = ''; return; }
  const parts = [];
  // Read-only badge when viewing an agent you don't own (phase 3).
  if (!canControlAgent(agent)) {
    const c = safeColor(agent.ownerColor);
    const who = agent.ownerName ? ` · ${escapeHtml(agent.ownerName)}` : '';
    parts.push(`<span class="topbar-readonly" style="color:${c};border-color:${c}">\u{1F441} view-only${who}</span>`);
  }
  if (agent.repoSlug) {
    parts.push(`<span class="topbar-repo-label">Repo:</span> <span class="topbar-repo-name">${escapeHtml(agent.repoSlug)}</span>`);
  }
  if (agent.branchName) {
    parts.push(`<svg class="topbar-branch-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="3.5" cy="2.5" r="1.2"/><circle cx="3.5" cy="9.5" r="1.2"/><circle cx="8.5" cy="4" r="1.2"/><path d="M3.5 3.7v4.6"/><path d="M8.5 5.2c0 2.2-1.8 2.6-3.4 3.1"/></svg><span class="topbar-branch-name">${escapeHtml(agent.branchName)}</span>`);
  }
  el.innerHTML = parts.join(' ');
}

export function updateStatusBar() {
  const bar = document.getElementById('status-bar');
  const count = agents.size;
  const needsAttention = [...agents.values()].filter(a => a.state === 'MESSAGE').length;
  if (count === 0) {
    bar.textContent = 'No agents running';
  } else {
    let text = `${count} agent${count !== 1 ? 's' : ''} running`;
    if (needsAttention > 0) {
      text += ` \u00b7 ${needsAttention} need${needsAttention !== 1 ? '' : 's'} attention`;
    }
    bar.textContent = text;
  }
  updateTopbarAgent();
}

export function fitActiveTerminal() {
  if (activeSessionId) {
    const agent = agents.get(activeSessionId);
    if (agent && agent.fitAddon && agent.termEl.offsetWidth > 0) {
      agent.fitAddon.fit();
      if (canControlAgent(agent)) send({ type: 'pty-resize', sessionId: activeSessionId, cols: agent.term.cols, rows: agent.term.rows });
    }
  }
}

// --- File Upload ---

function uploadFiles(files, sessionId) {
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      showUploadNotification(`${file.name} too large (max 10MB)`, true);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      send({ type: 'upload-file', sessionId, filename: file.name, data: base64 });
    };
    reader.readAsDataURL(file);
  }
}

function showUploadNotification(message, isError) {
  const bar = document.getElementById('status-bar');
  bar.textContent = message;
  bar.style.color = isError ? 'var(--state-disconnected)' : 'var(--state-message)';
  setTimeout(() => { bar.style.color = ''; updateStatusBar(); }, 3000);
}

export function handleUploadComplete(msg) {
  showUploadNotification(`Uploaded: ${msg.path}`, false);
}

export function setupUpload() {
  setupClipboardPaste();
  const viewport = document.getElementById('terminal-viewport');
  if (!viewport) return;

  // Drag-and-drop overlay
  const overlay = document.createElement('div');
  overlay.className = 'upload-drop-overlay';
  overlay.textContent = 'Drop files to upload';
  overlay.style.display = 'none';
  viewport.appendChild(overlay);

  let dragCounter = 0;

  viewport.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (activeSessionId && agents.get(activeSessionId)?.repoPath) {
      overlay.style.display = 'flex';
    }
  });

  viewport.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  viewport.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.style.display = 'none';
    }
  });

  viewport.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.style.display = 'none';
    if (!activeSessionId) return;
    const agent = agents.get(activeSessionId);
    if (!agent || !agent.repoPath) {
      showUploadNotification('Upload requires an agent with a repo', true);
      return;
    }
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files, activeSessionId);
    }
  });
}

function setupClipboardPaste() {
  // Use capture phase to intercept before xterm.js handles paste
  document.addEventListener('paste', (e) => {
    if (!activeSessionId) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const agent = agents.get(activeSessionId);
        if (!agent || !agent.repoPath) {
          showUploadNotification('Paste requires an agent with a repo', true);
          return;
        }
        const blob = item.getAsFile();
        if (!blob) return;
        const ext = item.type.split('/')[1] === 'png' ? 'png' : 'jpg';
        const filename = `screenshot-${Date.now()}.${ext}`;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          send({ type: 'upload-file', sessionId: activeSessionId, filename, data: base64 });
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  }, true);
}

export function triggerUpload() {
  if (!activeSessionId) return;
  const agent = agents.get(activeSessionId);
  if (!agent || !agent.repoPath) {
    showUploadNotification('Upload requires an agent with a repo', true);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => {
    if (input.files.length > 0) uploadFiles(input.files, activeSessionId);
  };
  input.click();
}
