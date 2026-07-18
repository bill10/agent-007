// Main init + message routing
import { agents, repos } from './modules/state.js';
import { connect, send } from './modules/ws.js';
import {
  handleSessionCreated, handlePtyOutput, handleStateChange,
  handleSpawnError, handleSessionEnded, switchToSession,
  removeSession, updateTabs, updateStatusBar, fitActiveTerminal,
  setOnSessionChanged, handleUploadComplete, setupUpload,
  updateTerminalThemes,
} from './modules/terminal.js';
import { renderOffice, setupOfficeClick, startAnimationLoop } from './modules/office.js';
import {
  setupExplorer, handleReposList, handleFileTree, handleFullTree,
  handleConflictsUpdate, handleFileDiff, handleOrphansList,
  renderExplorer, closeDiffViewer,
  handleRepoError as explorerHandleRepoError,
} from './modules/explorer.js';
import { setupShortcuts } from './modules/shortcuts.js';
import { captureTokenFromUrl, authHeaders, showLogin, renderPresence } from './modules/auth.js';

// Current viewer identity (phase 1) — set from the server's `welcome` message.
let selfUserId = null;

// Cross-module coordination: when sessions change, re-render office + explorer
setOnSessionChanged(() => {
  closeDiffViewer();
  renderOffice();
  renderExplorer();
});

// --- Spawn Form ---
function setupSpawnForm() {
  const form = document.getElementById('spawn-form');
  const cmdInput = document.getElementById('spawn-command');
  const nameInput = document.getElementById('spawn-name');
  const branchInput = document.getElementById('spawn-branch');
  const repoInput = document.getElementById('spawn-repo');
  const repoDropdown = document.getElementById('repo-dropdown');
  const advancedToggle = document.getElementById('spawn-advanced-toggle');
  const advancedSection = document.getElementById('spawn-advanced');

  advancedToggle.onclick = () => {
    const open = advancedSection.style.display !== 'none';
    advancedSection.style.display = open ? 'none' : 'flex';
    advancedToggle.innerHTML = open ? 'Advanced &#x25B6;' : 'Advanced &#x25BC;';
  };

  const errorEl = document.getElementById('spawn-form-error');
  function showSpawnError(text) {
    errorEl.textContent = text;
    errorEl.style.display = 'block';
  }
  function clearSpawnError() {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }

  document.getElementById('btn-new-agent').onclick = () => {
    form.style.display = 'flex';
    nameInput.value = '';
    branchInput.value = '';
    cmdInput.value = 'claude';
    advancedSection.style.display = 'none';
    advancedToggle.innerHTML = 'Advanced &#x25B6;';
    clearSpawnError();
    updateRepoDropdown();
    repoInput.focus();
  };

  document.getElementById('btn-spawn-cancel').onclick = () => {
    form.style.display = 'none';
    clearSpawnError();
  };

  const startBtn = document.getElementById('btn-spawn-start');
  let spawnTimeout = null;

  function doSpawn() {
    const command = cmdInput.value.trim() || 'claude';
    const name = nameInput.value.trim() || undefined;
    const branch = branchInput.value.trim() || undefined;
    const repoPath = repoInput.value.trim() || undefined;
    clearSpawnError();
    const ok = send({ type: 'spawn', command, name, branch, repoPath });
    if (!ok) {
      showSpawnError('Not connected to server — refresh the page and try again.');
      return;
    }
    startBtn.disabled = true;
    startBtn.textContent = 'Creating...';
    spawnTimeout = setTimeout(() => {
      resetSpawnForm();
      showSpawnError('Spawn timed out — server did not reply within 10 seconds. Check server logs.');
    }, 10000);
  }

  function resetSpawnForm() {
    startBtn.disabled = false;
    startBtn.textContent = 'Start';
    clearTimeout(spawnTimeout);
  }

  window._onSessionCreatedCloseSpawn = () => {
    // Only clear savedActiveTab if we were actually spawning (form was visible)
    if (form.style.display !== 'none') {
      savedActiveTab = null;
    }
    form.style.display = 'none';
    clearSpawnError();
    resetSpawnForm();
  };
  window._onSpawnErrorInForm = (error) => {
    resetSpawnForm();
    showSpawnError(`Error: ${error}`);
  };

  startBtn.onclick = doSpawn;
  cmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSpawn(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSpawn(); });
  branchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSpawn(); });
  repoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSpawn();
    if (e.key === 'Escape') repoDropdown.style.display = 'none';
  });

  // Combo-box: show dropdown on focus, filter on input
  repoInput.addEventListener('focus', () => {
    updateRepoDropdown();
    if (repos.size > 0) repoDropdown.style.display = 'block';
  });
  repoInput.addEventListener('input', () => {
    updateRepoDropdown();
  });
  repoInput.addEventListener('blur', () => {
    // Delay to allow click on dropdown item
    setTimeout(() => { repoDropdown.style.display = 'none'; }, 150);
  });

  form.onclick = (e) => { if (e.target === form) form.style.display = 'none'; };

  // Directory browser
  document.getElementById('btn-browse-repo').onclick = () => openDirBrowser(repoInput.value.trim() || '');
}

// --- Directory Browser ---
let dirBrowserCurrentPath = '';
let dirBrowserIsGitRepo = false;
let dirBrowserOnSelect = null;

function openDirBrowser(startPath, onSelect) {
  dirBrowserOnSelect = onSelect || null;
  document.getElementById('dir-browser-modal').style.display = 'flex';
  fetchDirectory(startPath && startPath.startsWith('/') ? startPath : '');
}

function closeDirBrowser(selectedPath) {
  document.getElementById('dir-browser-modal').style.display = 'none';
  if (selectedPath) {
    if (dirBrowserOnSelect) {
      dirBrowserOnSelect(selectedPath);
    } else {
      document.getElementById('spawn-repo').value = selectedPath;
    }
  }
  dirBrowserOnSelect = null;
}

async function fetchDirectory(path) {
  const list = document.getElementById('dir-browser-list');
  list.innerHTML = '<div class="dir-browser-empty">Loading...</div>';

  const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
  try {
    const resp = await fetch(url, { headers: authHeaders() });
    if (resp.status === 401) {
      showLogin();
      list.innerHTML = '<div class="dir-browser-error">Not authorized</div>';
      return;
    }
    const data = await resp.json();
    if (!resp.ok) {
      list.innerHTML = `<div class="dir-browser-error">${data.error || 'Failed to browse'}</div>`;
      return;
    }
    dirBrowserCurrentPath = data.path;
    dirBrowserIsGitRepo = data.isGitRepo;
    document.getElementById('dir-browser-path').textContent = data.path;
    const selectBtn = document.getElementById('btn-dir-browser-select');
    selectBtn.disabled = !data.isGitRepo;
    selectBtn.textContent = data.isGitRepo ? 'Select This Directory' : 'Select (not a git repo)';
    renderDirList(data);
  } catch (err) {
    list.innerHTML = `<div class="dir-browser-error">Network error: ${err.message}</div>`;
  }
}

function renderDirList(data) {
  const list = document.getElementById('dir-browser-list');
  list.innerHTML = '';

  // Parent entry
  if (data.parent !== null) {
    const parentEl = document.createElement('div');
    parentEl.className = 'dir-browser-entry';
    parentEl.innerHTML = '<span class="dir-browser-entry-icon">..</span><span class="dir-browser-entry-name">(parent directory)</span>';
    parentEl.onclick = () => fetchDirectory(data.parent);
    list.appendChild(parentEl);
  }

  if (data.entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dir-browser-empty';
    empty.textContent = 'No subdirectories';
    list.appendChild(empty);
    return;
  }

  for (const entry of data.entries) {
    const el = document.createElement('div');
    el.className = `dir-browser-entry${entry.isGitRepo ? ' is-git' : ''}`;

    const icon = document.createElement('span');
    icon.className = 'dir-browser-entry-icon';
    icon.textContent = entry.isGitRepo ? '\uD83D\uDCC2' : '\uD83D\uDCC1';
    el.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'dir-browser-entry-name';
    name.textContent = entry.name;
    el.appendChild(name);

    if (entry.isGitRepo) {
      const badge = document.createElement('span');
      badge.className = 'dir-browser-git-badge';
      badge.textContent = 'git';
      el.appendChild(badge);
    }

    const fullPath = data.path === '/' ? '/' + entry.name : data.path + '/' + entry.name;
    // Single-click always navigates into directory
    el.onclick = () => fetchDirectory(fullPath);
    list.appendChild(el);
  }
}

function setupDirBrowser() {
  document.getElementById('btn-dir-browser-close').onclick = () => closeDirBrowser();
  document.getElementById('btn-dir-browser-cancel').onclick = () => closeDirBrowser();
  document.getElementById('btn-dir-browser-select').onclick = () => {
    if (dirBrowserCurrentPath) closeDirBrowser(dirBrowserCurrentPath);
  };
  document.getElementById('dir-browser-modal').onclick = (e) => {
    if (e.target.id === 'dir-browser-modal') closeDirBrowser();
  };
}

function setupAddRepoButton() {
  const bar = document.getElementById('add-repo-bar');
  const input = document.getElementById('add-repo-input');
  const browseBtn = document.getElementById('add-repo-browse');

  document.getElementById('btn-add-repo').onclick = () => {
    const visible = bar.style.display !== 'none';
    bar.style.display = visible ? 'none' : 'flex';
    if (!visible) {
      input.value = '';
      input.focus();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const path = input.value.trim();
      if (path) {
        send({ type: 'add-repo', path });
        bar.style.display = 'none';
      }
    } else if (e.key === 'Escape') {
      bar.style.display = 'none';
    }
  });

  browseBtn.onclick = () => {
    openDirBrowser(input.value.trim() || '', (selectedPath) => {
      send({ type: 'add-repo', path: selectedPath });
      bar.style.display = 'none';
    });
  };
}

function updateRepoDropdown() {
  const repoInput = document.getElementById('spawn-repo');
  const dropdown = document.getElementById('repo-dropdown');
  dropdown.innerHTML = '';
  const filter = repoInput.value.trim().toLowerCase();
  let count = 0;
  for (const [path, repo] of repos) {
    if (filter && !path.toLowerCase().includes(filter) && !repo.slug.toLowerCase().includes(filter)) continue;
    const item = document.createElement('div');
    item.className = 'repo-dropdown-item';
    item.innerHTML = `<span class="repo-dropdown-slug">${repo.slug}</span><span class="repo-dropdown-path">${path}</span>`;
    item.onmousedown = (e) => {
      e.preventDefault();
      repoInput.value = path;
      dropdown.style.display = 'none';
    };
    dropdown.appendChild(item);
    count++;
  }
  dropdown.style.display = count > 0 ? 'block' : 'none';
}

// --- Dividers (N-panel layout) ---
function setupDividers() {
  restorePanelWidths();
  setupDivider('divider-explorer', 'explorer-panel', 'office-panel', 180, 160);
  setupDivider('divider', 'office-panel', 'terminal-panel', 160, 300);
}

function savePanelWidths() {
  const widths = {};
  for (const id of ['explorer-panel', 'office-panel']) {
    const el = document.getElementById(id);
    if (el && el.style.width) widths[id] = el.style.width;
  }
  localStorage.setItem('agent007-panel-widths', JSON.stringify(widths));
}

function restorePanelWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem('agent007-panel-widths'));
    if (!saved) return;
    for (const [id, width] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el) el.style.width = width;
    }
  } catch {}
}

function setupDivider(dividerId, leftId, rightId, leftMin, rightMin) {
  const divider = document.getElementById(dividerId);
  const left = document.getElementById(leftId);
  if (!divider || !left) return;

  let startX, startWidth;

  divider.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = left.offsetWidth;
    divider.classList.add('dragging');
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onDragEnd);
    e.preventDefault();
  });

  function onDrag(e) {
    const right = document.getElementById(rightId);
    const totalAvail = left.offsetWidth + right.offsetWidth;
    let newWidth = startWidth + e.clientX - startX;
    newWidth = Math.max(leftMin, Math.min(totalAvail - rightMin, newWidth));
    left.style.width = `${newWidth}px`;
    if (leftId === 'office-panel' || rightId === 'terminal-panel') {
      renderOffice();
      fitActiveTerminal();
    }
  }

  function onDragEnd() {
    divider.classList.remove('dragging');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onDragEnd);
    savePanelWidths();
  }
}

// --- Resize ---
function setupResize() {
  window.addEventListener('resize', () => {
    renderOffice();
    fitActiveTerminal();
  });
}

// --- WS Message Router ---
function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      selfUserId = msg.user ? msg.user.id : null;
      break;
    case 'presence': renderPresence(msg.users, selfUserId); break;
    case 'session-created':
      handleSessionCreated(msg);
      if (window._onSessionCreatedCloseSpawn) window._onSessionCreatedCloseSpawn();
      scheduleTabRestore();
      break;
    case 'pty-output': handlePtyOutput(msg); break;
    case 'state-change': handleStateChange(msg); break;
    case 'session-ended': handleSessionEnded(msg); break;
    case 'spawn-error':
      handleSpawnError(msg);
      if (window._onSpawnErrorInForm) window._onSpawnErrorInForm(msg.error);
      break;
    case 'repos-list': handleReposList(msg); break;
    case 'file-tree': handleFileTree(msg); break;
    case 'branch-changed': {
      const agent = agents.get(msg.sessionId);
      if (agent) {
        agent.branchName = msg.branchName;
        updateStatusBar();
        renderExplorer();
      }
      break;
    }
    case 'conflicts-update': handleConflictsUpdate(msg); break;
    case 'file-diff': handleFileDiff(msg); break;
    case 'full-tree': handleFullTree(msg); break;
    case 'orphans-list': handleOrphansList(msg); break;
    case 'upload-complete': handleUploadComplete(msg); break;
    case 'notification': handleNotification(msg); break;
    case 'repo-error':
      handleRepoError(msg);
      explorerHandleRepoError(msg);
      break;
  }
}

function handleNotification(msg) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg.message;
  bar.style.color = msg.level === 'error' ? 'var(--state-disconnected)' : 'var(--state-message)';
  const duration = msg.level === 'warning' ? 6000 : 4000;
  setTimeout(() => {
    bar.style.color = '';
    updateStatusBar();
  }, duration);
}

function handleRepoError(msg) {
  const bar = document.getElementById('status-bar');
  bar.textContent = `Repo error: ${msg.error}`;
  bar.style.color = 'var(--state-disconnected)';
  setTimeout(() => {
    bar.style.color = '';
    updateStatusBar();
  }, 4000);
}

// --- Theme Toggle ---
function setupThemePicker() {
  const saved = localStorage.getItem('agent007-theme') || 'dark';
  applyTheme(saved);

  document.getElementById('theme-toggle').onclick = () => {
    const current = localStorage.getItem('agent007-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  };
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  // Toggle icon: show sun in dark mode (to switch to light), moon in light mode (to switch to dark)
  document.getElementById('theme-icon-sun').style.display = theme === 'dark' ? '' : 'none';
  document.getElementById('theme-icon-moon').style.display = theme === 'light' ? '' : 'none';
  localStorage.setItem('agent007-theme', theme);
  updateTerminalThemes();
}

// --- Active Tab Restore ---
// Capture saved tab before connect() triggers replay (which overwrites localStorage)
let savedActiveTab = localStorage.getItem('agent007-active-tab');
let restoreTimer = null;

function scheduleTabRestore() {
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => {
    // Restore tab order from saved preference
    try {
      const savedOrder = JSON.parse(localStorage.getItem('agent007-tab-order'));
      if (savedOrder && Array.isArray(savedOrder)) {
        const reordered = new Map();
        for (const id of savedOrder) {
          if (agents.has(id)) reordered.set(id, agents.get(id));
        }
        for (const [id, agent] of agents) {
          if (!reordered.has(id)) reordered.set(id, agent);
        }
        agents.clear();
        for (const [id, agent] of reordered) agents.set(id, agent);
        updateTabs();
      }
    } catch {}
    if (savedActiveTab && agents.has(savedActiveTab)) switchToSession(savedActiveTab);
    restoreTimer = null;
  }, 100);
}

// --- Init ---
async function init() {
  captureTokenFromUrl();
  setupThemePicker();
  setupSpawnForm();
  setupDirBrowser();
  setupAddRepoButton();
  setupDividers();
  setupOfficeClick();
  setupExplorer();
  setupShortcuts();
  setupResize();
  setupUpload();
  startAnimationLoop();
  connect(onMessage);
  renderOffice();
}

init();
