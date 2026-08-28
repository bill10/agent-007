// Job board — a pinned tab in the terminal panel. Renders three columns
// (To do / In progress / Review) and drives the dispatcher settings.
//
// Card *state* comes from the server (durable, persisted). The "needs you"
// badge is computed here from the live agent map, because it describes a PTY
// as it is right now — a value the server persisted would be stale the moment
// it was written.

import { agents, jobs, boardSettings, setBoardSettings, boardActive, setBoardActive, activeSessionId, repos } from './state.js';
import { send } from './ws.js';
import { escapeHtml } from './auth.js';
import { switchToSession } from './terminal.js';

const COLUMNS = [
  { state: 'todo', label: 'To do' },
  { state: 'in-progress', label: 'In progress' },
  { state: 'review', label: 'Review' },
];

// Mirrors STALLED_AFTER_MS in lib/jobs.js.
const STALLED_AFTER_MS = 3 * 60 * 1000;

let editingJobId = null;

// --- Helpers ---

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function repoSlug(repoPath) {
  const repo = repos.get(repoPath);
  if (repo) return repo.slug;
  return String(repoPath || '').split('/').filter(Boolean).pop() || repoPath;
}

// Live status for an in-progress card. Deliberately mirrors deriveJobStatus in
// lib/jobs.js, but reads the client's agent map so the badge reacts the instant
// a state-change arrives rather than on the next board broadcast.
function liveStatus(job) {
  if (job.state !== 'in-progress') return null;
  const agent = job.agentSessionId ? agents.get(job.agentSessionId) : null;
  if (!agent || agent.state === 'DISCONNECTED') return 'gone';
  if (agent.state === 'MESSAGE') return 'needs-input';
  if (agent.state === 'WAITING' && (Date.now() - (agent.lastOutputAt || 0)) > STALLED_AFTER_MS) return 'stalled';
  return 'running';
}

const STATUS_TEXT = {
  'running': 'running',
  'needs-input': 'needs you',
  'stalled': 'quiet — may need you',
  'gone': 'agent gone',
};

// --- Rendering ---

export function renderBoard() {
  const container = document.getElementById('job-columns');
  if (!container || !boardActive) return;

  const byState = new Map(COLUMNS.map(c => [c.state, []]));
  for (const job of jobs.values()) {
    if (byState.has(job.state)) byState.get(job.state).push(job);
  }
  // Newest first within To do would bury the next thing to be dispatched, so
  // To do stays oldest-first to match the dispatcher's own ordering. The other
  // columns show most-recent activity first.
  byState.get('todo').sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
  byState.get('in-progress').sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  byState.get('review').sort((a, b) => String(b.reviewAt || '').localeCompare(String(a.reviewAt || '')));

  container.innerHTML = '';
  for (const col of COLUMNS) {
    const list = byState.get(col.state);
    const colEl = document.createElement('div');
    colEl.className = 'job-column';
    colEl.dataset.state = col.state;

    const header = document.createElement('div');
    header.className = 'job-column-header';
    header.innerHTML = `<span class="job-column-label">${escapeHtml(col.label)}</span><span class="job-column-count">${list.length}</span>`;
    colEl.appendChild(header);

    const cards = document.createElement('div');
    cards.className = 'job-cards';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'job-column-empty';
      empty.textContent = col.state === 'todo' ? 'No jobs queued' : '—';
      cards.appendChild(empty);
    }
    for (const job of list) cards.appendChild(renderCard(job));
    colEl.appendChild(cards);
    container.appendChild(colEl);
  }
}

function renderCard(job) {
  const card = document.createElement('div');
  const status = liveStatus(job);
  card.className = 'job-card' + (status ? ` status-${status}` : '');
  card.dataset.jobId = job.id;

  const title = document.createElement('div');
  title.className = 'job-card-title';
  title.textContent = job.title;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'job-card-meta';
  const posted = job.postedByName ? `${escapeHtml(job.postedByName)} · ${relativeTime(job.postedAt)}` : relativeTime(job.postedAt);
  meta.innerHTML = `<span class="job-card-repo">${escapeHtml(repoSlug(job.repoPath))}</span><span class="job-card-posted">${posted}</span>`;
  card.appendChild(meta);

  if (job.detail) {
    const detail = document.createElement('div');
    detail.className = 'job-card-detail';
    detail.textContent = job.detail;
    card.appendChild(detail);
  }

  // Who worked on it, and where the work is (requirement 3). Rendered whenever
  // EITHER is known: the branch is a fact about the job, not about the agent,
  // and gating it on the name left a finished card showing nothing at all once
  // the name was lost.
  if (job.agentName || job.branchName || job.startedAt) {
    const agentEl = document.createElement('div');
    agentEl.className = 'job-card-agent';
    const parts = [];
    if (job.agentName) parts.push(`<span class="job-card-agent-name">${escapeHtml(job.agentName)}</span>`);
    if (job.branchName) parts.push(`<span class="job-card-branch">${escapeHtml(job.branchName)}</span>`);
    if (job.startedAt) parts.push(`<span class="job-card-since">started ${relativeTime(job.startedAt)}</span>`);
    agentEl.innerHTML = parts.join(' ');
    card.appendChild(agentEl);
  }

  if (status) {
    const badge = document.createElement('button');
    badge.className = `job-card-status job-status-${status}`;
    badge.innerHTML = `<span class="job-status-dot"></span>${escapeHtml(STATUS_TEXT[status] || status)}`;
    const canJump = job.agentSessionId && agents.has(job.agentSessionId);
    badge.title = canJump
      ? `Open ${job.agentName}'s terminal`
      : 'This agent is no longer running';
    badge.onclick = (e) => {
      e.stopPropagation();
      if (canJump) switchToSession(job.agentSessionId);
    };
    if (!canJump) badge.disabled = true;
    card.appendChild(badge);
  }

  // On a review card the agent is usually gone (closed when the PR opened), so
  // say so rather than leaving a bare agent name that no longer resolves.
  if (job.state === 'review' && job.agentName && !agents.has(job.agentSessionId)) {
    const note = document.createElement('div');
    note.className = 'job-card-retired';
    note.textContent = 'agent closed · worktree released';
    card.appendChild(note);
  }

  // The URL comes from `gh pr list`, but it still ends up in an href, and a
  // non-http scheme there (javascript:, data:) executes on click. Cheap guard.
  const prHref = /^https?:\/\//i.test(String(job.prUrl || '')) ? job.prUrl : null;
  if (prHref) {
    const pr = document.createElement('a');
    pr.className = 'job-card-pr';
    pr.href = prHref;
    pr.target = '_blank';
    pr.rel = 'noopener noreferrer';
    pr.textContent = job.prNumber ? `PR #${job.prNumber}` : 'View PR';
    card.appendChild(pr);
  }

  if (job.lastError) {
    const err = document.createElement('div');
    err.className = 'job-card-error';
    err.textContent = job.lastError;
    card.appendChild(err);
  }

  // Shown alongside lastError, never instead of it: "the agent is gone" and
  // "the board cannot see this repo's pull requests" are both worth knowing,
  // and together they explain why a card is stuck.
  if (job.prCheckError) {
    const err = document.createElement('div');
    err.className = 'job-card-error';
    err.textContent = job.prCheckError;
    card.appendChild(err);
  }

  card.appendChild(renderCardActions(job));
  return card;
}

function renderCardActions(job) {
  const actions = document.createElement('div');
  actions.className = 'job-card-actions';

  const mk = (label, title, onClick, cls = '') => {
    const b = document.createElement('button');
    b.className = `job-card-btn ${cls}`.trim();
    b.textContent = label;
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    return b;
  };

  // Manual moves in both directions: the automatic transitions are best-effort
  // (gh may be unavailable, an agent may finish without a PR), so the user
  // always keeps the final say over where a card sits.
  if (job.state === 'todo') {
    actions.appendChild(mk('Edit', 'Edit this job', () => openForm(job.id)));
  }
  if (job.state === 'in-progress') {
    actions.appendChild(mk('→ Review', 'Mark as ready for review (use when the PR was opened outside the board)', () => send({ type: 'job-move', jobId: job.id, state: 'review' })));
    actions.appendChild(mk('← To do', 'Requeue this job and close its agent. Uncommitted or unpushed work is kept as an orphan.', () => {
      if (confirm(`Return "${job.title}" to To do?\n\n${job.agentName || 'The agent'} is closed and its worktree released, then the board dispatches a fresh agent for this job. Any uncommitted or unpushed work is kept as an orphan.`)) {
        send({ type: 'job-move', jobId: job.id, state: 'todo' });
      }
    }));
  }
  if (job.state === 'review') {
    actions.appendChild(mk('← In progress', 'Send back to In progress', () => send({ type: 'job-move', jobId: job.id, state: 'in-progress' })));
  }
  actions.appendChild(mk('Delete', 'Delete this job from the board', () => {
    if (confirm(`Delete "${job.title}"?\n\n${job.agentSessionId ? 'Its agent is closed and the worktree released. Uncommitted or unpushed work is kept as an orphan.' : 'This removes the card.'}`)) {
      send({ type: 'job-delete', jobId: job.id });
    }
  }, 'danger'));

  return actions;
}

// --- Toolbar ---

function renderToolbar() {
  const toggle = document.getElementById('btn-dispatcher-toggle');
  const status = document.getElementById('job-dispatcher-status');
  const cap = document.getElementById('job-max-per-repo');
  if (!toggle) return;

  const running = boardSettings.running;
  toggle.textContent = running ? 'Stop' : 'Start';
  toggle.classList.toggle('running', running);
  const mins = Math.round((boardSettings.intervalMs || 180000) / 60000);
  status.textContent = running
    ? `scanning every ${mins}m`
    : 'dispatcher stopped';
  status.classList.toggle('running', running);
  if (document.activeElement !== cap) cap.value = boardSettings.maxPerRepo;
}

// --- Form ---

function openForm(jobId) {
  editingJobId = jobId || null;
  const form = document.getElementById('job-form');
  const titleEl = document.getElementById('job-title');
  const detailEl = document.getElementById('job-detail');
  const repoEl = document.getElementById('job-repo');
  const saveBtn = document.getElementById('btn-job-save');

  repoEl.innerHTML = '';
  for (const [path, repo] of repos) {
    const opt = document.createElement('option');
    opt.value = path;
    opt.textContent = repo.slug;
    repoEl.appendChild(opt);
  }
  if (repos.size === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No repositories — add one in the explorer first';
    repoEl.appendChild(opt);
  }

  const job = jobId ? jobs.get(jobId) : null;
  titleEl.value = job ? job.title : '';
  detailEl.value = job ? job.detail : '';
  if (job) repoEl.value = job.repoPath;
  saveBtn.textContent = job ? 'Save' : 'Post job';
  clearFormError();
  form.style.display = 'flex';
  titleEl.focus();
}

function closeForm() {
  editingJobId = null;
  document.getElementById('job-form').style.display = 'none';
  clearFormError();
}

function showFormError(text) {
  const el = document.getElementById('job-form-error');
  el.textContent = text;
  el.style.display = 'block';
}
function clearFormError() {
  const el = document.getElementById('job-form-error');
  el.textContent = '';
  el.style.display = 'none';
}

function saveForm() {
  const title = document.getElementById('job-title').value.trim();
  const detail = document.getElementById('job-detail').value;
  const repoPath = document.getElementById('job-repo').value;
  if (!title) return showFormError('Give the job a title.');
  if (!repoPath) return showFormError('Add a repository in the explorer first — a job needs one to run in.');
  if (editingJobId) send({ type: 'job-update', jobId: editingJobId, title, detail, repoPath });
  else send({ type: 'job-create', title, detail, repoPath });
  closeForm();
}

// --- Show / hide ---

export function showJobBoard() {
  const agent = activeSessionId ? agents.get(activeSessionId) : null;
  if (agent) agent.termEl.style.display = 'none';
  document.getElementById('terminal-empty').style.display = 'none';
  document.getElementById('job-board').style.display = 'flex';
  setBoardActive(true);
  renderToolbar();
  renderBoard();
  if (window._onBoardVisibilityChanged) window._onBoardVisibilityChanged();
}

export function hideJobBoard() {
  document.getElementById('job-board').style.display = 'none';
  setBoardActive(false);
}

// --- Messages ---

export function handleJobsList(msg) {
  jobs.clear();
  for (const job of msg.jobs || []) jobs.set(job.id, job);
  if (msg.settings) setBoardSettings(msg.settings);
  renderToolbar();
  renderBoard();
  if (window._onBoardVisibilityChanged) window._onBoardVisibilityChanged();
}

// --- Setup ---

export function setupJobBoard() {
  document.getElementById('btn-new-job').onclick = () => openForm(null);
  document.getElementById('btn-job-cancel').onclick = closeForm;
  document.getElementById('btn-job-save').onclick = saveForm;
  document.getElementById('job-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveForm(); }
    if (e.key === 'Escape') closeForm();
  });
  document.getElementById('job-detail').addEventListener('keydown', (e) => {
    // Cmd/Ctrl+Enter submits; a bare Enter has to stay available for newlines.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveForm(); }
    if (e.key === 'Escape') closeForm();
  });

  document.getElementById('btn-dispatcher-toggle').onclick = () => {
    send({ type: 'job-settings', running: !boardSettings.running });
  };
  document.getElementById('btn-dispatch-now').onclick = () => {
    send({ type: 'job-dispatch-now' });
  };
  document.getElementById('job-max-per-repo').onchange = (e) => {
    const value = parseInt(e.target.value, 10);
    if (Number.isFinite(value)) send({ type: 'job-settings', maxPerRepo: value });
  };

  // Relative timestamps and the "quiet" threshold both drift with the clock, so
  // the board re-renders on a slow tick while it is visible. Cheap: it only
  // touches the DOM when the board is the active tab.
  setInterval(() => { if (boardActive) renderBoard(); }, 30_000);
}
