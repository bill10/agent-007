// File explorer panel — repo sections, branch trees, inline diffs
import { agents, repos, orphans, activeSessionId } from './state.js';
import { send } from './ws.js';
import { switchToSession } from './terminal.js';

let explorerVisible = true;
let expandedBranches = new Set();  // sessionIds with expanded file trees
let activeDiff = null;             // { sessionId, filePath, diff } for modal
let pendingDiffs = new Set();      // loading state
let conflicts = [];                // current conflict list
let fullTreeSessions = new Set();  // sessionIds showing full tree
let fullTreeCache = new Map();     // sessionId -> full tree data
let fullTreePending = new Set();   // in-flight full tree requests
let expandedDirs = new Set();      // "sessionId:dir/path" expanded directories (collapsed by default)

export function setupExplorer() {
  document.getElementById('btn-toggle-explorer').onclick = toggleExplorer;
  document.getElementById('btn-reopen-explorer').onclick = toggleExplorer;
  // Refresh button
  const refreshBtn = document.getElementById('btn-refresh-tree');
  if (refreshBtn) {
    refreshBtn.onclick = () => {
      for (const [sessionId, agent] of agents) {
        if (agent.repoPath) send({ type: 'refresh-tree', sessionId });
      }
    };
  }
  // Start collapsed if no repos
  if (repos.size === 0) {
    setExplorerVisible(false);
  }
}

export function toggleExplorer() {
  setExplorerVisible(!explorerVisible);
}

function setExplorerVisible(visible) {
  explorerVisible = visible;
  const panel = document.getElementById('explorer-panel');
  const divider = document.getElementById('divider-explorer');
  const toggleBtn = document.getElementById('btn-toggle-explorer');
  const reopenBtn = document.getElementById('btn-reopen-explorer');
  if (visible) {
    panel.classList.remove('collapsed');
    divider.style.display = '';
    reopenBtn.style.display = 'none';
    toggleBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M8 1L3 6l5 5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
  } else {
    panel.classList.add('collapsed');
    divider.style.display = 'none';
    reopenBtn.style.display = '';
    toggleBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 1l5 5-5 5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
  }
}

export function handleReposList(msg) {
  const hadRepos = repos.size;
  repos.clear();
  for (const r of msg.repos) {
    repos.set(r.path, { slug: r.slug, exists: r.exists });
  }
  renderExplorer();
  // Auto-expand explorer when first repo added
  if (repos.size > 0 && !explorerVisible) {
    setExplorerVisible(true);
  }
}

export function handleRepoError(msg) {
  const bar = document.getElementById('status-bar');
  if (bar) {
    bar.style.display = '';
    bar.textContent = msg.error;
    bar.style.color = 'var(--state-disconnected)';
    setTimeout(() => { bar.style.display = 'none'; bar.style.color = ''; }, 5000);
  }
}

export function handleFileTree(msg) {
  const agent = agents.get(msg.sessionId);
  if (!agent) return;
  agent.fileTree = msg.tree;
  agent.changedCount = msg.changedCount;
  agent.additions = msg.additions || 0;
  agent.removals = msg.removals || 0;
  fullTreeCache.delete(msg.sessionId); // invalidate stale full tree
  renderExplorer();
}

export function handleFullTree(msg) {
  fullTreePending.delete(msg.sessionId);
  fullTreeCache.set(msg.sessionId, msg.tree);
  renderExplorer();
}

export function handleConflictsUpdate(msg) {
  conflicts = msg.conflicts || [];
  // Update agent conflict state
  for (const [, agent] of agents) {
    agent.conflicts = [];
  }
  for (const c of conflicts) {
    for (const sid of c.sessionIds) {
      const agent = agents.get(sid);
      if (agent) {
        agent.conflicts = [...(agent.conflicts || []), ...c.files];
      }
    }
  }
  renderExplorer();
}

export function handleFileDiff(msg) {
  const key = `${msg.sessionId}:${msg.filePath}`;
  pendingDiffs.delete(key);
  activeDiff = { sessionId: msg.sessionId, filePath: msg.filePath, diff: msg.diff };
  showDiffViewer();
  renderExplorer();
}

export function handleOrphansList(msg) {
  orphans.clear();
  for (const o of msg.orphans) {
    orphans.set(o.id, o);
  }
  renderExplorer();
}

export function renderExplorer() {
  const content = document.getElementById('explorer-content');
  if (!content) return;
  const scrollTop = content.scrollTop;
  content.innerHTML = '';

  if (repos.size === 0 && agents.size === 0 && orphans.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'explorer-empty';
    empty.textContent = 'No repos yet';
    content.appendChild(empty);
  }

  // Group agents by repo
  const repoAgents = new Map();
  for (const [sessionId, agent] of agents) {
    if (!agent.repoPath) continue;
    if (!repoAgents.has(agent.repoPath)) repoAgents.set(agent.repoPath, []);
    repoAgents.get(agent.repoPath).push({ sessionId, agent });
  }

  // Group orphans by repo
  const repoOrphans = new Map();
  for (const [orphanId, orphan] of orphans) {
    if (!repoOrphans.has(orphan.repoPath)) repoOrphans.set(orphan.repoPath, []);
    repoOrphans.get(orphan.repoPath).push({ orphanId, orphan });
  }

  // Render each configured repo
  for (const [repoPath, repo] of repos) {
    const section = document.createElement('div');
    section.className = 'explorer-repo';

    // Sticky header
    const header = document.createElement('div');
    header.className = 'explorer-repo-header';

    const headerName = document.createElement('span');
    headerName.className = 'explorer-repo-name';
    headerName.textContent = repo.slug;
    header.appendChild(headerName);

    if (!repo.exists) {
      const err = document.createElement('span');
      err.className = 'explorer-error-badge';
      err.textContent = 'not found';
      header.appendChild(err);
    }

    const headerActions = document.createElement('span');
    headerActions.className = 'explorer-repo-actions';

    // Spawn agent on this repo
    const addBtn = document.createElement('button');
    addBtn.className = 'explorer-icon-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Spawn agent on this repo';
    addBtn.onclick = (e) => {
      e.stopPropagation();
      openSpawnFormWithRepo(repoPath);
    };
    headerActions.appendChild(addBtn);

    // Remove repo
    const removeBtn = document.createElement('button');
    removeBtn.className = 'explorer-icon-btn explorer-remove-btn';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove repo';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      send({ type: 'remove-repo', path: repoPath });
    };
    headerActions.appendChild(removeBtn);

    header.appendChild(headerActions);
    section.appendChild(header);

    // Branches
    const branchAgents = repoAgents.get(repoPath) || [];
    const repoOrphanList = repoOrphans.get(repoPath) || [];
    if (branchAgents.length === 0 && repoOrphanList.length === 0 && repo.exists) {
      const noBranch = document.createElement('div');
      noBranch.className = 'explorer-no-agents';
      noBranch.textContent = '(no agents)';
      section.appendChild(noBranch);
    }

    for (const { sessionId, agent } of branchAgents) {
      const branchEl = createBranchEntry(sessionId, agent);
      section.appendChild(branchEl);
    }

    // Render orphans for this repo
    for (const { orphanId, orphan } of repoOrphanList) {
      section.appendChild(createOrphanEntry(orphanId, orphan));
    }

    content.appendChild(section);
  }

  // Render orphans for repos not in the configured repos list
  for (const [repoPath, orphanList] of repoOrphans) {
    if (repos.has(repoPath)) continue; // Already rendered above
    const section = document.createElement('div');
    section.className = 'explorer-repo';
    const header = document.createElement('div');
    header.className = 'explorer-repo-header';
    const headerName = document.createElement('span');
    headerName.className = 'explorer-repo-name';
    headerName.textContent = orphanList[0].orphan.repoSlug || repoPath.split('/').pop();
    header.appendChild(headerName);
    section.appendChild(header);
    for (const { orphanId, orphan } of orphanList) {
      section.appendChild(createOrphanEntry(orphanId, orphan));
    }
    content.appendChild(section);
  }

  // Agents without repos (legacy mode)
  const noRepoAgents = [...agents.entries()].filter(([, a]) => !a.repoPath);
  if (noRepoAgents.length > 0) {
    const section = document.createElement('div');
    section.className = 'explorer-repo';
    const header = document.createElement('div');
    header.className = 'explorer-repo-header';
    header.innerHTML = '<span class="explorer-repo-name">No repo</span>';
    section.appendChild(header);
    for (const [sessionId, agent] of noRepoAgents) {
      const entry = document.createElement('div');
      entry.className = `explorer-branch${sessionId === activeSessionId ? ' active' : ''}`;
      entry.onclick = () => switchToSession(sessionId);
      const dot = document.createElement('span');
      dot.className = 'explorer-dot';
      dot.style.background = stateColor(agent.state);
      entry.appendChild(dot);
      entry.appendChild(document.createTextNode(agent.name));
      section.appendChild(entry);
    }
    content.appendChild(section);
  }

  content.scrollTop = scrollTop;
}

function stateColor(state) {
  switch (state) {
    case 'WORKING': return 'var(--state-working)';
    case 'WAITING': return 'var(--state-waiting)';
    case 'MESSAGE': return 'var(--state-message)';
    case 'IDLE': return 'var(--state-idle)';
    case 'DISCONNECTED': return 'var(--state-disconnected)';
    default: return 'var(--state-idle)';
  }
}

function createBranchEntry(sessionId, agent) {
  const isActive = sessionId === activeSessionId;
  const isExpanded = expandedBranches.has(sessionId);
  const wrapper = document.createElement('div');
  wrapper.className = 'explorer-branch-wrapper';

  // Branch header row — click to toggle file tree
  const branchEl = document.createElement('div');
  branchEl.className = `explorer-branch${isActive ? ' active' : ''}`;
  if (isActive) branchEl.style.borderLeftColor = agent.color;
  branchEl.onclick = () => {
    if (expandedBranches.has(sessionId)) {
      expandedBranches.delete(sessionId);
    } else {
      expandedBranches.add(sessionId);
    }
    renderExplorer();
  };

  // Status dot
  const dot = document.createElement('span');
  dot.className = 'explorer-dot';
  dot.style.background = stateColor(agent.state);
  branchEl.appendChild(dot);

  // Agent name (click to switch session)
  const nameEl = document.createElement('span');
  nameEl.className = 'explorer-branch-name';
  nameEl.textContent = agent.name;
  nameEl.onclick = (e) => {
    e.stopPropagation();
    switchToSession(sessionId);
    if (expandedBranches.has(sessionId)) {
      expandedBranches.delete(sessionId);
    } else {
      expandedBranches.add(sessionId);
    }
    renderExplorer();
  };
  branchEl.appendChild(nameEl);

  // Branch label: "on branch/vesper"
  if (agent.branchName) {
    const onLabel = document.createElement('span');
    onLabel.className = 'explorer-branch-label';
    onLabel.textContent = `on ${agent.branchName}`;
    branchEl.appendChild(onLabel);
  }

  // Tree mode toggle switch (changes vs all files)
  let toggleEl = null;
  if (isExpanded && (agent.fileTree || fullTreeCache.has(sessionId))) {
    const showFull = fullTreeSessions.has(sessionId);
    const toggle = document.createElement('span');
    toggle.className = 'explorer-tree-toggle';

    const changesOpt = document.createElement('span');
    changesOpt.className = 'explorer-tree-toggle-opt' + (!showFull ? ' active' : '');
    changesOpt.textContent = 'changes';
    changesOpt.onclick = (e) => {
      e.stopPropagation();
      fullTreeSessions.delete(sessionId);
      renderExplorer();
    };

    const allOpt = document.createElement('span');
    allOpt.className = 'explorer-tree-toggle-opt' + (showFull ? ' active' : '');
    allOpt.textContent = 'all';
    allOpt.onclick = (e) => {
      e.stopPropagation();
      fullTreeSessions.add(sessionId);
      if (!fullTreeCache.has(sessionId) && !fullTreePending.has(sessionId)) {
        fullTreePending.add(sessionId);
        send({ type: 'get-full-tree', sessionId });
      }
      renderExplorer();
    };

    toggle.appendChild(changesOpt);
    toggle.appendChild(allOpt);
    toggleEl = toggle;
  }

  wrapper.appendChild(branchEl);

  // File tree (if expanded)
  if (isExpanded) {
    const showFull = fullTreeSessions.has(sessionId);
    const treeData = showFull ? fullTreeCache.get(sessionId) : agent.fileTree;

    if (fullTreePending.has(sessionId)) {
      const loading = document.createElement('div');
      loading.className = 'explorer-diff-loading';
      loading.style.paddingLeft = '16px';
      loading.textContent = 'Loading file tree\u2026';
      wrapper.appendChild(loading);
    } else if (treeData) {
      const treeEl = document.createElement('div');
      treeEl.className = 'explorer-file-tree';
      // Toggle floats right at top of tree
      if (toggleEl) {
        toggleEl.style.float = 'right';
        toggleEl.style.margin = '2px 4px 2px 0';
        treeEl.appendChild(toggleEl);
      }
      renderTreeNode(treeEl, treeData, sessionId, 1, showFull);
      wrapper.appendChild(treeEl);
    }
  }

  return wrapper;
}

function createOrphanEntry(orphanId, orphan) {
  const wrapper = document.createElement('div');
  wrapper.className = 'explorer-branch-wrapper explorer-orphan';

  const row = document.createElement('div');
  row.className = 'explorer-branch';

  // Warning icon instead of toggle arrow
  const warn = document.createElement('span');
  warn.className = 'explorer-toggle-arrow';
  warn.textContent = '\u26a0'; // ⚠
  warn.style.color = 'var(--state-message)';
  row.appendChild(warn);

  // Dimmed dot
  const dot = document.createElement('span');
  dot.className = 'explorer-dot';
  dot.style.background = 'var(--state-idle)';
  row.appendChild(dot);

  // Name
  const nameEl = document.createElement('span');
  nameEl.className = 'explorer-branch-name';
  nameEl.textContent = orphan.name;
  row.appendChild(nameEl);

  // Reason badge
  const badge = document.createElement('span');
  badge.className = 'orphan-badge';
  badge.textContent = orphan.reason;
  row.appendChild(badge);

  wrapper.appendChild(row);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'explorer-orphan-actions';

  const respawnBtn = document.createElement('button');
  respawnBtn.textContent = 'Re-spawn';
  respawnBtn.onclick = (e) => {
    e.stopPropagation();
    send({ type: 're-adopt-orphan', orphanId });
  };
  actions.appendChild(respawnBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'orphan-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.onclick = (e) => {
    e.stopPropagation();
    if (confirm(`Delete orphan ${orphan.name}? This will remove the worktree and branch permanently.`)) {
      send({ type: 'delete-orphan', orphanId });
    }
  };
  actions.appendChild(deleteBtn);

  wrapper.appendChild(actions);
  return wrapper;
}

function renderTreeNode(container, node, sessionId, depth, fullTreeMode = false, parentPath = '') {
  if (!node || !node.children) return;
  // Sort: dirs first, then files, alphabetical
  const sorted = [...node.children].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of sorted) {
    if (child.type === 'dir') {
      const dirPath = parentPath ? `${parentPath}/${child.name}` : child.name;
      const dirKey = `${sessionId}:${dirPath}`;
      const isExpanded = expandedDirs.has(dirKey);
      const dirEl = document.createElement('div');
      dirEl.className = 'explorer-dir';
      dirEl.style.paddingLeft = `${depth * 8}px`;
      dirEl.textContent = (isExpanded ? '\u25be ' : '\u25b8 ') + child.name + '/';
      dirEl.onclick = (e) => {
        e.stopPropagation();
        if (expandedDirs.has(dirKey)) expandedDirs.delete(dirKey);
        else expandedDirs.add(dirKey);
        renderExplorer();
      };
      container.appendChild(dirEl);
      if (isExpanded) {
        renderTreeNode(container, child, sessionId, depth + 1, fullTreeMode, dirPath);
      }
    } else {
      const hasChange = child.status != null;
      const fileEl = document.createElement('div');
      fileEl.className = 'explorer-file';
      fileEl.style.paddingLeft = `${depth * 8}px`;

      // Status dot (only for changed files)
      if (hasChange) {
        const statusDot = document.createElement('span');
        statusDot.className = 'explorer-status-dot';
        statusDot.style.background = statusColor(child.status);
        statusDot.setAttribute('aria-label', statusLabel(child.status));
        fileEl.appendChild(statusDot);
      }

      // Filename (dim unchanged files in full tree mode)
      const fname = document.createElement('span');
      fname.className = 'explorer-filename';
      if (fullTreeMode && !hasChange) fname.style.opacity = '0.45';
      fname.textContent = child.name;
      fileEl.appendChild(fname);

      // Conflict indicator
      const agent = agents.get(sessionId);
      if (agent && agent.conflicts && agent.conflicts.includes(child.path)) {
        const warn = document.createElement('span');
        warn.className = 'explorer-conflict';
        warn.textContent = '\u26a0';
        const otherConflict = conflicts.find(c =>
          c.sessionIds.includes(sessionId) && c.files.includes(child.path)
        );
        if (otherConflict) {
          const otherId = otherConflict.sessionIds.find(id => id !== sessionId);
          const otherAgent = agents.get(otherId);
          if (otherAgent) {
            warn.title = `Also modified by ${otherAgent.name}`;
            warn.onclick = (e) => {
              e.stopPropagation();
              switchToSession(otherId);
            };
          }
        }
        fileEl.appendChild(warn);
      }

      // Click to open diff modal (only for changed files)
      if (hasChange) {
        const diffKey = `${sessionId}:${child.path}`;
        fileEl.onclick = () => {
          if (!pendingDiffs.has(diffKey)) {
            pendingDiffs.add(diffKey);
            send({ type: 'get-diff', sessionId, filePath: child.path, status: child.status });
          }
        };
        fileEl.style.cursor = 'pointer';
      }
      container.appendChild(fileEl);
    }
  }
}

function renderDiffHtml(diff) {
  if (!diff || !diff.trim()) return '<span class="diff-empty">No changes</span>';
  return diff.split('\n').map(line => {
    const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return `<span class="diff-add">${escaped}</span>`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      return `<span class="diff-del">${escaped}</span>`;
    } else if (line.startsWith('@@')) {
      return `<span class="diff-hunk">${escaped}</span>`;
    }
    return escaped;
  }).join('\n');
}

function showDiffViewer() {
  if (!activeDiff) return;
  const viewer = document.getElementById('diff-viewer');
  const canvas = document.getElementById('office-canvas');
  const empty = document.getElementById('office-empty');
  const pathEl = document.getElementById('diff-viewer-path');
  const contentEl = document.getElementById('diff-viewer-content');

  pathEl.textContent = activeDiff.filePath;
  contentEl.innerHTML = renderDiffHtml(activeDiff.diff);

  canvas.style.display = 'none';
  empty.style.display = 'none';
  viewer.style.display = 'flex';

  // Close button
  document.getElementById('diff-viewer-close').onclick = closeDiffViewer;

  // Escape to close
  if (!closeDiffViewer._keyHandler) {
    closeDiffViewer._keyHandler = (e) => { if (e.key === 'Escape' && viewer.style.display !== 'none') closeDiffViewer(); };
    document.addEventListener('keydown', closeDiffViewer._keyHandler);
  }
}

export function closeDiffViewer() {
  activeDiff = null;
  const viewer = document.getElementById('diff-viewer');
  const canvas = document.getElementById('office-canvas');
  const empty = document.getElementById('office-empty');
  if (viewer) viewer.style.display = 'none';
  if (canvas) canvas.style.display = '';
  // Restore empty state if no agents
  if (empty && agents.size === 0) empty.style.display = 'flex';
}

function statusColor(status) {
  switch (status) {
    case 'M': return 'var(--state-working)';   // yellow
    case 'A': return 'var(--state-waiting)';    // green
    case 'D': return 'var(--state-disconnected)'; // red
    case '?': return 'var(--state-idle)';       // gray
    case 'R': return 'var(--state-message)';    // orange
    default: return 'var(--state-idle)';
  }
}

function statusLabel(status) {
  switch (status) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case '?': return 'untracked';
    case 'R': return 'renamed';
    default: return status;
  }
}

function openSpawnFormWithRepo(repoPath) {
  const form = document.getElementById('spawn-form');
  const repoInput = document.getElementById('spawn-repo');
  form.style.display = 'flex';
  if (repoInput) repoInput.value = repoPath;
  const nameInput = document.getElementById('spawn-name');
  if (nameInput) {
    nameInput.value = '';
    nameInput.focus();
  }
}

export function isExplorerVisible() {
  return explorerVisible;
}
