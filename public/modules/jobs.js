// Job board — a pinned tab in the terminal panel. Renders three columns
// (To do / In progress / Review), an archive of finished jobs behind a toolbar
// toggle, and drives the dispatcher settings.
//
// Two kinds of card share those columns. A one-time job crosses them once and
// stops in Review. A scheduled job cycles To do -> In progress -> To do on its
// cron schedule, so it lives in To do between runs with its next run time on it
// and never reaches Review.
//
// Card *state* comes from the server (durable, persisted). The "needs you"
// badge is computed here from the live agent map, because it describes a PTY
// as it is right now — a value the server persisted would be stale the moment
// it was written.

import { agents, jobs, boardSettings, setBoardSettings, boardActive, setBoardActive, activeSessionId, repos } from './state.js';
import { send } from './ws.js';
import { escapeHtml, getToken } from './auth.js';
import { switchToSession } from './terminal.js';

// The columns, in board order. `done` deliberately has none: a job whose PR
// merged is finished work, and a Review column that accumulates it stops
// meaning "needs your review". Those jobs are kept and reachable through the
// Finished jobs view below.
export const COLUMNS = [
  { state: 'todo', label: 'To do' },
  { state: 'in-progress', label: 'In progress' },
  { state: 'review', label: 'Review' },
];

// The one mode that leaves a dispatched agent unreviewed. Named here rather
// than compared inline in three places, and marked wherever it is shown so it
// never reads as just another entry in a list of six. Kept in step with
// PERMISSION_MODES in lib/jobs.js by a test — public/ cannot import it.
const DANGEROUS_MODE = 'bypassPermissions';

function markDangerousMode(el) {
  if (el) el.classList.toggle('job-mode-danger', el.value === DANGEROUS_MODE);
}

// Mirrors STALLED_AFTER_MS in lib/jobs.js.
const STALLED_AFTER_MS = 3 * 60 * 1000;

let editingJobId = null;
// Files waiting in the form: { name } for one the card already has, { name,
// data } (base64) for a new one, `reading` while the FileReader is still busy.
let pendingAttachments = [];
// Which of the two views the board is showing. The columns and the finished
// list share the same space rather than stacking, so the finished archive can
// never push the live work off the screen.
let showingFinished = false;

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

// relativeTime only looks backwards. A scheduled card's whole point is the run
// that has not happened yet, so it needs the other direction too.
function untilTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.round((then - Date.now()) / 1000);
  // Due, but the board only acts on a scan — saying "0s" would imply a
  // precision the dispatcher does not have.
  if (secs <= 0) return 'due';
  if (secs < 60) return 'in <1m';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

// The absolute time as well, in the browser's locale, because "in 14h" alone
// does not tell you whether that lands at a sensible hour.
function clockTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  // Past ~6 days the weekday alone no longer says which date is meant (a
  // monthly cron's "next Sat" could be either of two Saturdays), so add it.
  const far = then - Date.now() > 6 * 24 * 60 * 60 * 1000;
  return new Date(then).toLocaleString([], {
    weekday: 'short', ...(far ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit', minute: '2-digit',
  });
}

function isScheduled(job) {
  return job.type === 'scheduled';
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

// "Quiet" means two different things depending on the card. On a one-time job it
// is a warning — the agent may be waiting on you and its PR never appeared. On a
// scheduled run it is the completion signal itself: the board reads that same
// quiet as "done" and re-arms the card on its next scan (keeping the agent's
// terminal open to read), so telling the user they might be needed would be
// the opposite of true.
function statusText(job, status) {
  if (isScheduled(job) && (status === 'stalled' || status === 'gone')) return 'run finished';
  return STATUS_TEXT[status] || status;
}

// --- Rendering ---

export function renderBoard() {
  const container = document.getElementById('job-columns');
  if (!container || !boardActive) return;

  const finished = [...jobs.values()].filter(j => j.state === 'done');
  const panel = document.getElementById('job-finished');
  // A page served from cache after an upgrade can have the old markup and the
  // new module — nothing busts the cache on app.js. Falling back to the columns
  // beats hiding them to show an archive whose container does not exist.
  if (!panel) showingFinished = false;
  renderFinishedToggle(finished.length);
  if (panel) panel.style.display = showingFinished ? 'flex' : 'none';
  container.style.display = showingFinished ? 'none' : '';
  if (showingFinished) return renderFinishedList(finished);

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

// Newest first: the thing that just merged is the one you are most likely to be
// looking for.
function renderFinishedList(finished) {
  const cards = document.getElementById('job-finished-cards');
  const count = document.getElementById('job-finished-count');
  if (!cards) return;
  const sorted = [...finished].sort((a, b) =>
    String(b.doneAt || b.prMergedAt || '').localeCompare(String(a.doneAt || a.prMergedAt || '')));
  if (count) count.textContent = String(sorted.length);
  cards.innerHTML = '';
  if (sorted.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'job-column-empty';
    empty.textContent = 'No finished jobs yet — a card lands here once its pull request merges.';
    cards.appendChild(empty);
    return;
  }
  for (const job of sorted) cards.appendChild(renderCard(job));
}

// The title and aria-pressed move with the label: a tooltip still describing the
// view you just left is worse than no tooltip, and the accent border is the only
// other thing saying which view you are in — which reaches nobody using a screen
// reader.
function renderFinishedToggle(count) {
  const btn = document.getElementById('btn-finished-jobs');
  if (!btn) return;
  btn.textContent = showingFinished
    ? '\u2190 Back to board'
    : `View finished jobs${count ? ` (${count})` : ''}`;
  btn.title = showingFinished
    ? 'Back to the To do / In progress / Review columns'
    : 'Jobs whose pull request has merged. They leave the board but are kept here.';
  btn.setAttribute('aria-pressed', String(showingFinished));
  btn.classList.toggle('showing', showingFinished);
}

function renderCard(job) {
  const card = document.createElement('div');
  const status = liveStatus(job);
  // A scheduled run that has gone quiet or whose agent exited is a run that
  // FINISHED (statusText says so in words) — so style it idle-gray, not the
  // alarm red/gray of a one-time card whose agent died mid-job.
  const displayStatus = isScheduled(job) && (status === 'gone' || status === 'stalled') ? 'stalled' : status;
  card.className = 'job-card' + (displayStatus ? ` status-${displayStatus}` : '');
  card.dataset.jobId = job.id;

  // An in-progress job whose agent is still around is a jump target. The badge
  // below stays clickable, but the whole card is a far bigger hit area than a
  // one-line pill, and "click the job to see the agent" is what the columns
  // already imply.
  const liveAgentId = job.state === 'in-progress' && job.agentSessionId && agents.has(job.agentSessionId)
    ? job.agentSessionId
    : null;

  const title = document.createElement('div');
  title.className = 'job-card-title';
  title.textContent = job.title;
  if (isScheduled(job)) {
    // A chip rather than a whole second column: a scheduled card is still an
    // ordinary card in the same queue, and splitting the board would hide it
    // from the glance that the three columns exist to give.
    const chip = document.createElement('span');
    chip.className = 'job-card-type';
    chip.textContent = 'scheduled';
    chip.title = 'Runs again on its schedule instead of finishing in Review';
    title.appendChild(chip);
  }
  if (job.permissionMode) {
    // Only when the card overrides the board. The mode decides how much its
    // agent may do unasked, so a card carrying its own must say so on its face
    // rather than only inside the edit form.
    const chip = document.createElement('span');
    // bypassPermissions gets the danger colour rather than the routine gold:
    // it is the one mode with nothing reviewing the agent, and a card already
    // on the board is exactly where that has to be readable at a glance.
    chip.className = `job-card-type${job.permissionMode === DANGEROUS_MODE ? ' job-mode-danger' : ''}`;
    chip.textContent = job.permissionMode;
    chip.title = `This job runs with --permission-mode ${job.permissionMode} instead of the board's setting`;
    title.appendChild(chip);
  }
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'job-card-meta';
  // "Who posted it" is up to three facts: the person it belongs to, the agent
  // that typed it (when one did — see the board's MCP tool), and when. Any of
  // the first two can be absent, so filter rather than branch.
  const posted = [
    job.postedByName ? escapeHtml(job.postedByName) : null,
    job.postedByAgent ? `<span class="job-card-via">via ${escapeHtml(job.postedByAgent)}</span>` : null,
    relativeTime(job.postedAt),
    // An agent can rewrite a To do card through the board's edit_job tool, and
    // that text becomes the next agent's prompt. The card would otherwise still
    // read as the work of whoever queued it, so the rewrite says so on the card
    // and not only in the toast that has already scrolled away.
    job.editedByAgent
      ? `<span class="job-card-via">edited by ${escapeHtml(job.editedByAgent)} ${relativeTime(job.editedAt)}</span>`
      : null,
  ].filter(Boolean).join(' · ');
  meta.innerHTML = `<span class="job-card-repo">${escapeHtml(repoSlug(job.repoPath))}</span><span class="job-card-posted">${posted}</span>`;
  card.appendChild(meta);

  if (isScheduled(job)) {
    const sched = document.createElement('div');
    sched.className = 'job-card-schedule';
    const bits = [`<span class="job-card-cron">${escapeHtml(job.schedule || '')}</span>`];
    // While a run is in flight nextRunAt still points at the run that is
    // happening, so showing it would read as a second run being due. The next
    // one is only decided when this one finishes.
    if (job.state === 'in-progress') {
      bits.push(`<span class="job-card-next">running now${job.paused ? ', paused after this run' : ''}</span>`);
    } else if (job.paused) {
      // The stored nextRunAt is not shown: it is the due time the pause is
      // holding, and resuming re-arms from that moment instead of running it.
      bits.push('<span class="job-card-next job-card-paused">paused</span>');
    } else if (job.nextRunAt) {
      bits.push(`<span class="job-card-next">next ${escapeHtml(clockTime(job.nextRunAt))} · ${escapeHtml(untilTime(job.nextRunAt))}</span>`);
    } else {
      // nextCronIso returned nothing: a valid expression that matches no date
      // that will ever come round, such as 30 February.
      bits.push('<span class="job-card-next">never fires again</span>');
    }
    // Coerced, not trusted: this lands in innerHTML, and job records come from
    // config.json, which a person can edit by hand.
    const runs = Number(job.runCount) || 0;
    if (runs) bits.push(`<span class="job-card-runs">· ran ${runs}\u00d7${job.lastRunAt ? `, last ${escapeHtml(relativeTime(job.lastRunAt))}` : ''}</span>`);
    sched.innerHTML = bits.join(' ');
    card.appendChild(sched);

    // The last run's agent is kept open so its terminal can be read (the next
    // run replaces it). Only rendered while that tab actually exists — after a
    // restart, or once the user closes it, the pointer is stale and the row
    // would lead nowhere.
    if (job.state !== 'in-progress' && job.lastRunSessionId && agents.has(job.lastRunSessionId)) {
      const last = document.createElement('button');
      last.className = 'job-card-lastrun';
      last.textContent = `last run: ${job.lastRunAgentName || 'agent'} — open terminal`;
      last.title = "Read what the last run wrote. The tab stays until the next run starts or you close it.";
      last.onclick = (e) => { e.stopPropagation(); switchToSession(job.lastRunSessionId); };
      card.appendChild(last);
    }
  }

  if (job.detail) {
    const detail = document.createElement('div');
    detail.className = 'job-card-detail';
    detail.textContent = job.detail;
    card.appendChild(detail);
  }

  if (Array.isArray(job.attachments) && job.attachments.length) {
    const files = document.createElement('div');
    files.className = 'job-card-attachments';
    for (const a of job.attachments) {
      const link = document.createElement('a');
      link.className = 'job-card-attachment';
      link.href = attachmentUrl(job.id, a.name);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = a.name;
      files.appendChild(link);
    }
    card.appendChild(files);
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
    if (job.startedAt) parts.push(`<span class="job-card-since">· started ${relativeTime(job.startedAt)}</span>`);
    agentEl.innerHTML = parts.join(' ');
    card.appendChild(agentEl);
  }

  if (status) {
    const badge = document.createElement('button');
    badge.className = `job-card-status job-status-${displayStatus}`;
    badge.innerHTML = `<span class="job-status-dot"></span>${escapeHtml(statusText(job, status))}`;
    const canJump = !!liveAgentId;
    badge.title = canJump
      ? `Open ${job.agentName}'s terminal`
      : 'This agent is no longer running';
    badge.onclick = (e) => {
      e.stopPropagation();
      if (canJump) switchToSession(liveAgentId);
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

  if (job.state === 'done') {
    const fin = document.createElement('div');
    fin.className = 'job-card-finished';
    fin.textContent = job.prMergedAt
      ? `merged ${relativeTime(job.prMergedAt)}`
      : `finished ${relativeTime(job.doneAt)}`;
    card.appendChild(fin);
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

  if (liveAgentId) {
    // Pointer affordance only. The card holds buttons and a link, so giving it
    // role="button" would flatten them out of the accessibility tree, and a
    // second tab stop would just duplicate the status badge — which is already
    // a real button that jumps to the same place.
    card.classList.add('job-card-live');
    card.title = `Open ${job.agentName || 'this agent'}'s terminal`;
    card.onclick = (e) => {
      // The buttons and the PR link own their own clicks, and a click that ends
      // a selection inside this card is someone reading it, not asking to leave.
      if (e.target.closest && e.target.closest('button, a')) return;
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed && card.contains(sel.anchorNode)) return;
      switchToSession(liveAgentId);
    };
  }

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
  // Pause holds the NEXT firing, so it is offered in both states a scheduled
  // card lives in: between runs, and during one (where "End run" stops the run
  // itself but leaves the schedule armed).
  if (isScheduled(job) && job.state !== 'done') {
    actions.appendChild(job.paused
      ? mk('Resume', 'Resume this schedule. The next run is set from now, so a firing missed while paused is not replayed.',
        () => send({ type: 'job-pause', jobId: job.id, paused: false }))
      : mk('Pause', 'Hold this schedule. The card stays in To do and no further runs go out until you resume; a run already under way is left alone.',
        () => send({ type: 'job-pause', jobId: job.id, paused: true })));
  }
  if (job.state === 'in-progress' && isScheduled(job)) {
    // No "→ Review" here: a scheduled card has no finished state to move to.
    // Its only manual control is ending the run early, which is the same move
    // the board makes for it when the agent goes quiet.
    actions.appendChild(mk('End run', 'End this run now and re-arm the schedule. The agent is closed and its worktree released; uncommitted or unpushed work is kept as an orphan.', () => {
      if (confirm(`End this run of "${job.title}"?\n\n${job.agentName || 'The agent'} is closed and its worktree released. The card returns to To do and runs again at its next scheduled time. Any uncommitted or unpushed work is kept as an orphan.`)) {
        send({ type: 'job-move', jobId: job.id, state: 'todo' });
      }
    }));
  } else if (job.state === 'in-progress') {
    actions.appendChild(mk('→ Review', 'Mark as ready for review (use when the PR was opened outside the board)', () => send({ type: 'job-move', jobId: job.id, state: 'review' })));
    actions.appendChild(mk('← To do', 'Requeue this job and close its agent. Uncommitted or unpushed work is kept as an orphan.', () => {
      if (confirm(`Return "${job.title}" to To do?\n\n${job.agentName || 'The agent'} is closed and its worktree released, then the board dispatches a fresh agent for this job. Any uncommitted or unpushed work is kept as an orphan.`)) {
        send({ type: 'job-move', jobId: job.id, state: 'todo' });
      }
    }));
  }
  if (job.state === 'review') {
    actions.appendChild(mk('← In progress', 'Send back to In progress', () => send({ type: 'job-move', jobId: job.id, state: 'in-progress' })));
    // The board files a card away by itself once its PR merges; this is the
    // same move by hand, for a PR the board cannot see or work that landed
    // some other way. It is one-way — done is the end of a card's life on the
    // board — so it asks first, the way Delete does.
    actions.appendChild(mk('✓ Done', 'File this job away as finished. This is final: the card leaves the board for Finished jobs and cannot be brought back.', () => {
      // Names the agent for the same reason Delete does: this move retires it,
      // and an agent re-adopted on a shipped branch is one someone is using.
      const agentNote = job.agentSessionId
        ? `${job.agentName || 'Its agent'} is closed and its worktree released. `
        : '';
      if (confirm(`File "${job.title}" away as finished?\n\n${agentNote}The card leaves the board for Finished jobs and cannot be moved back — follow-up work needs a new job.`)) {
        send({ type: 'job-move', jobId: job.id, state: 'done' });
      }
    }));
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
  const perm = document.getElementById('job-permission-mode');
  if (!toggle) return;

  const running = boardSettings.running;
  toggle.textContent = running ? 'Stop' : 'Start';
  toggle.classList.toggle('running', running);
  const mins = Math.round((boardSettings.intervalMs || 300000) / 60000);
  status.textContent = running
    ? `scanning every ${mins}m`
    : 'dispatcher stopped';
  status.classList.toggle('running', running);
  if (document.activeElement !== cap) cap.value = boardSettings.maxPerRepo;
  // The mode a card falls back to when it does not name one of its own.
  if (perm && document.activeElement !== perm) perm.value = boardSettings.permissionMode || 'auto';
  markDangerousMode(perm);
}

// --- Attachments ---

// Mirrors the server's limits in server/jobs.js (public/ cannot import it).
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
// Pasted screenshots carry a MIME type, not a name.
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

// A plain link cannot send a bearer header, so the token rides in the query,
// which the server accepts for exactly this case.
function attachmentUrl(jobId, name) {
  const token = getToken();
  return `/api/jobs/${encodeURIComponent(jobId)}/attachments/${encodeURIComponent(name)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

function renderAttachments() {
  const box = document.getElementById('job-attachments');
  if (!box) return;
  box.innerHTML = '';
  for (const a of pendingAttachments) {
    const chip = document.createElement('span');
    chip.className = 'job-attachment';
    chip.textContent = a.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'job-attachment-remove';
    rm.textContent = '\u00d7';
    rm.title = `Remove ${a.name}`;
    rm.onclick = () => { pendingAttachments = pendingAttachments.filter(x => x !== a); renderAttachments(); };
    chip.appendChild(rm);
    box.appendChild(chip);
  }
}

function addAttachments(files, fallbackName) {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) { showFormError(`${file.name} is too large (max 10MB)`); continue; }
    // A pasted screenshot arrives as "image.png" every time; a timestamp keeps
    // the second one from replacing the first.
    const name = fallbackName && /^image\.\w+$/i.test(file.name || 'image.png')
      ? `${fallbackName}-${Date.now()}.${IMAGE_EXT[file.type] || file.type.split('/')[1] || 'png'}`
      : file.name;
    const others = pendingAttachments.filter(a => a.name !== name);
    // The same limits the server enforces, caught here while the file picker
    // is still open rather than as a toast after the form has closed.
    if (others.length >= MAX_ATTACHMENTS) { showFormError(`At most ${MAX_ATTACHMENTS} files per job`); continue; }
    if (others.reduce((n, a) => n + (a.size || 0), 0) + file.size > MAX_ATTACHMENT_TOTAL_BYTES) { showFormError('Attachments add up to more than 50MB'); continue; }
    const entry = { name, size: file.size, reading: true };
    pendingAttachments = [...others, entry];
    const reader = new FileReader();
    reader.onload = () => { entry.data = String(reader.result).split(',')[1]; delete entry.reading; };
    // A file that vanished or cannot be read must not leave a chip that
    // blocks every save with "still reading".
    reader.onerror = reader.onabort = () => {
      pendingAttachments = pendingAttachments.filter(a => a !== entry);
      showFormError(`Could not read ${name}`);
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
  renderAttachments();
}

// --- Form ---

// The cron box only means anything for a scheduled job, so it is hidden rather
// than left sitting there inert next to a one-time card.
function syncScheduleField() {
  const scheduled = document.getElementById('job-type').value === 'scheduled';
  document.getElementById('job-schedule-field').style.display = scheduled ? 'flex' : 'none';
}

// A shape check only — five whitespace-separated fields, or a known @shorthand.
// The real parser is lib/cron.js on the server, and it stays the authority; this
// exists so the commonest typo (too few fields) is caught while the form is
// still open and the user's text is still in it, rather than coming back as a
// toast after the form has closed. Keep the @-list in sync with CRON_MACROS in
// lib/cron.js — public/ cannot import server modules, so this is a copy.
const CRON_MACROS = ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'];

function looksLikeCron(text) {
  const raw = text.trim();
  if (raw.startsWith('@')) return CRON_MACROS.includes(raw.toLowerCase());
  return raw.split(/\s+/).length === 5;
}

function openForm(jobId) {
  // The agent spawn form is an overlay anchored below the 36px header strip,
  // and it sizes to its own content rather than covering the viewport, so the
  // board's toolbar and cards stay clickable underneath it. Every door into
  // this form goes through here, so this is the one place that has to dismiss
  // it — otherwise the form opens behind the overlay and focuses a title input
  // the user cannot see, swallowing whatever they type next.
  const spawn = document.getElementById('spawn-form');
  if (spawn) spawn.style.display = 'none';
  editingJobId = jobId || null;
  // A new job lands in To do, which the archive is covering. Posting one from
  // there would look like nothing happened, so the form takes you back to the
  // columns first — the same move showJobBoard makes. Repainted immediately
  // rather than waiting for the server's next broadcast, so the form never
  // opens over a view its result will not appear in.
  if (showingFinished) {
    showingFinished = false;
    renderBoard();
  }
  const form = document.getElementById('job-form');
  const titleEl = document.getElementById('job-title');
  const detailEl = document.getElementById('job-detail');
  const repoEl = document.getElementById('job-repo');
  const typeEl = document.getElementById('job-type');
  const scheduleEl = document.getElementById('job-schedule');
  const permEl = document.getElementById('job-permission-mode-field');
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
  typeEl.value = job && isScheduled(job) ? 'scheduled' : 'one-time';
  scheduleEl.value = job && job.schedule ? job.schedule : '';
  // '' is the "Board default" option, and it is what a card with no mode of
  // its own goes back to — never pre-filled with the board's current value,
  // which would silently freeze the card onto today's setting.
  if (permEl) permEl.value = job && job.permissionMode ? job.permissionMode : '';
  markDangerousMode(permEl);
  pendingAttachments = job && Array.isArray(job.attachments) ? job.attachments.map(a => ({ name: a.name })) : [];
  renderAttachments();
  syncScheduleField();
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
  const jobType = document.getElementById('job-type').value;
  const schedule = document.getElementById('job-schedule').value.trim();
  const permissionMode = document.getElementById('job-permission-mode-field')?.value || '';
  if (!title) return showFormError('Give the job a title.');
  if (!repoPath) return showFormError('Add a repository in the explorer first — a job needs one to run in.');
  if (jobType === 'scheduled' && !schedule) return showFormError('A scheduled job needs a cron schedule, for example "0 9 * * 1-5".');
  if (jobType === 'scheduled' && !looksLikeCron(schedule)) {
    return showFormError('That does not look like a cron schedule — five fields (minute hour day month weekday), or @daily / @hourly / @weekly.');
  }
  if (pendingAttachments.some(a => a.reading)) return showFormError('Still reading an attached file — try again in a moment.');
  // The form always holds the complete list; an empty one on an edit means
  // "none left".
  const attachments = pendingAttachments.map(a => ({ name: a.name, data: a.data }));
  const fields = { title, detail, repoPath, jobType, schedule, permissionMode, attachments };
  if (editingJobId) send({ type: 'job-update', jobId: editingJobId, ...fields });
  else send({ type: 'job-create', ...fields });
  closeForm();
}

// Opening the form from outside the board — the top bar's "+ Job" button. The
// board may not be the visible tab, so bring it up first; otherwise the form
// opens where nobody can see it. The tab strip repaints itself: showJobBoard()
// fires the board-visibility hook, which app.js wires to updateTabs(), and
// openForm() clears the spawn overlay. app.js closes this form on the way in
// the other direction.
export function openJobForm() {
  showJobBoard();
  openForm(null);
}

export function closeJobForm() {
  closeForm();
}

// --- Show / hide ---

export function showJobBoard() {
  // Always open on the columns. Opening the board is the user asking for the
  // live work; the archive is somewhere you go on purpose, not somewhere the
  // Jobs tab can strand you.
  showingFinished = false;
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
  document.getElementById('btn-new-job-shortcut').onclick = openJobForm;
  document.getElementById('btn-job-cancel').onclick = closeForm;
  document.getElementById('btn-job-save').onclick = saveForm;
  document.getElementById('job-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveForm(); }
    if (e.key === 'Escape') closeForm();
  });
  document.getElementById('job-type').onchange = syncScheduleField;
  document.getElementById('job-schedule').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveForm(); }
    if (e.key === 'Escape') closeForm();
  });
  document.getElementById('job-detail').addEventListener('keydown', (e) => {
    // Cmd/Ctrl+Enter submits; a bare Enter has to stay available for newlines.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveForm(); }
    if (e.key === 'Escape') closeForm();
  });
  document.getElementById('job-detail').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addAttachments(files, 'screenshot');
  });
  const attachBtn = document.getElementById('btn-job-attach');
  const attachInput = document.getElementById('job-attach-input');
  if (attachBtn && attachInput) {
    attachBtn.onclick = () => attachInput.click();
    attachInput.onchange = () => { addAttachments(attachInput.files); attachInput.value = ''; };
  }

  document.getElementById('btn-dispatcher-toggle').onclick = () => {
    send({ type: 'job-settings', running: !boardSettings.running });
  };
  document.getElementById('btn-dispatch-now').onclick = () => {
    send({ type: 'job-dispatch-now' });
  };
  const finishedBtn = document.getElementById('btn-finished-jobs');
  if (finishedBtn) finishedBtn.onclick = () => { showingFinished = !showingFinished; renderBoard(); };
  document.getElementById('job-max-per-repo').onchange = (e) => {
    const value = parseInt(e.target.value, 10);
    if (Number.isFinite(value)) send({ type: 'job-settings', maxPerRepo: value });
  };
  const permEl = document.getElementById('job-permission-mode');
  // Sending this is what records the mode as CHOSEN on the server, which is
  // how a stored value is told apart from one a default wrote (see
  // boardSettings in server/jobs.js) — so it must only fire on a real change.
  if (permEl) permEl.onchange = (e) => {
    markDangerousMode(e.target);
    send({ type: 'job-settings', permissionMode: e.target.value });
  };
  // The form's own select is marked as it changes too, not only when the form
  // opens — the warning has to be on screen while the choice is being made.
  const formPermEl = document.getElementById('job-permission-mode-field');
  if (formPermEl) formPermEl.onchange = () => markDangerousMode(formPermEl);

  // Relative timestamps and the "quiet" threshold both drift with the clock, so
  // the board re-renders on a slow tick while it is visible. Cheap: it only
  // touches the DOM when the board is the active tab.
  setInterval(() => { if (boardActive) renderBoard(); }, 30_000);
}
