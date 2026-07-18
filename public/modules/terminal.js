// Terminal (xterm.js) lifecycle, tabs, session switching, file upload
import { agents, activeSessionId, setActiveSession, stateColor } from './state.js';
import { send } from './ws.js';

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
        // GitHub-light ANSI palette — the dark palette's cyan/green/yellow
        // were near-invisible on the light terminal background.
        background: '#f9f8f7', foreground: '#24292f', cursor: '#a07d2e', selectionBackground: '#dcd8d0',
        black: '#24292f',
        red: '#cf222e',
        green: '#1a7f37',
        yellow: '#7d4e00',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#6e7781',
        brightBlack: '#57606a',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#633c01',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
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
  const { sessionId, name, color, command, state, repoPath, repoSlug, branchName, changedCount, additions, removals } = msg;

  if (agents.has(sessionId)) {
    agents.get(sessionId).state = state || 'WORKING';
    updateStatusBar();
    if (onSessionChanged) onSessionChanged();
    return;
  }

  const term = new Terminal({
    theme: getTerminalTheme(),
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
    if (event.metaKey && ['1','2','3','4','5','6','7','8','9','e','n'].includes(event.key)) {
      return false;
    }
    return true;
  });

  agents.set(sessionId, {
    name, color, command, fitAddon,
    state: state || 'WORKING',
    term, termEl,
    repoPath: repoPath || null,
    repoSlug: repoSlug || null,
    branchName: branchName || null,
    changedCount: changedCount || 0,
    additions: additions || 0,
    removals: removals || 0,
    fileTree: null,
    conflicts: [],
  });

  if (fitAddon) {
    requestAnimationFrame(() => {
      if (termEl.offsetWidth > 0) {
        fitAddon.fit();
        send({ type: 'pty-resize', sessionId, cols: term.cols, rows: term.rows });
      }
    });
  }

  term.onData((data) => {
    send({ type: 'pty-input', sessionId, data });
  });

  switchToSession(sessionId);
  updateTabs();
  updateStatusBar();
  document.getElementById('office-empty').style.display = 'none';
  if (onSessionChanged) onSessionChanged();
}

export function handlePtyOutput(msg) {
  const agent = agents.get(msg.sessionId);
  if (!agent) return;
  const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
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
  agent.state = 'DISCONNECTED';
  updateTabs();
  updateStatusBar();
  if (onSessionChanged) onSessionChanged();
}

export function switchToSession(sessionId) {
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
        send({ type: 'pty-resize', sessionId, cols: agent.term.cols, rows: agent.term.rows });
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
  if (agent.state !== 'DISCONNECTED') {
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
  const agent = agents.get(activeSessionId);
  if (!agent) { el.innerHTML = ''; return; }
  const parts = [];
  if (agent.repoSlug) {
    parts.push(`<span class="topbar-repo-label">Repo:</span> <span class="topbar-repo-name">${agent.repoSlug}</span>`);
  }
  if (agent.branchName) {
    parts.push(`<svg class="topbar-branch-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="3.5" cy="2.5" r="1.2"/><circle cx="3.5" cy="9.5" r="1.2"/><circle cx="8.5" cy="4" r="1.2"/><path d="M3.5 3.7v4.6"/><path d="M8.5 5.2c0 2.2-1.8 2.6-3.4 3.1"/></svg><span class="topbar-branch-name">${agent.branchName}</span>`);
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
      send({ type: 'pty-resize', sessionId: activeSessionId, cols: agent.term.cols, rows: agent.term.rows });
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
