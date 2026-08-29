// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
// terminal.js pulls in xterm; the board only needs switchToSession and
// updateTabs from it, and stubbing it also proves the board does not depend on
// the real module loading.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

import { send } from '../public/modules/ws.js';
import { switchToSession } from '../public/modules/terminal.js';
import { agents, jobs, repos, setActiveSession } from '../public/modules/state.js';
import { handleJobsList, showJobBoard, hideJobBoard, renderBoard, setupJobBoard, openJobForm, closeJobForm } from '../public/modules/jobs.js';

const BOARD_HTML = `
  <button id="btn-new-job-shortcut"></button>
  <div class="spawn-form" id="spawn-form" style="display:none"></div>
  <div id="terminal-viewport">
    <div id="terminal-empty"></div>
    <div class="job-board" id="job-board" style="display:none">
      <div class="job-board-toolbar">
        <button id="btn-new-job"></button>
        <button id="btn-dispatcher-toggle"></button>
        <button id="btn-dispatch-now"></button>
        <span id="job-dispatcher-status"></span>
        <input type="number" id="job-max-per-repo">
        <button id="btn-finished-jobs"></button>
      </div>
      <div class="job-form" id="job-form" style="display:none">
        <input type="text" id="job-title">
        <select id="job-repo"></select>
        <textarea id="job-detail"></textarea>
        <button id="btn-job-save"></button>
        <button id="btn-job-cancel"></button>
        <div id="job-form-error" style="display:none"></div>
      </div>
      <div class="job-columns" id="job-columns"></div>
      <div class="job-finished" id="job-finished" style="display:none">
        <span id="job-finished-count"></span>
        <div class="job-cards" id="job-finished-cards"></div>
      </div>
    </div>
  </div>`;

const JOB = (over = {}) => ({
  id: 'job-1', title: 'Add rate limiting', detail: 'Token bucket.',
  repoPath: '/repos/alpha', state: 'todo',
  postedByName: 'Bill', postedAt: new Date().toISOString(),
  agentSessionId: null, agentName: null, startedAt: null,
  branchName: null, prUrl: null, prNumber: null, lastError: null,
  prMergedAt: null, doneAt: null,
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = BOARD_HTML;
  jobs.clear();
  agents.clear();
  repos.clear();
  repos.set('/repos/alpha', { slug: 'alpha', exists: true });
  setActiveSession(null);
  vi.clearAllMocks();
  setupJobBoard();
  showJobBoard();
});

function cards() {
  return [...document.querySelectorAll('.job-card')];
}
function columnCards(state) {
  return [...document.querySelectorAll(`.job-column[data-state="${state}"] .job-card`)];
}

describe('board rendering', () => {
  it('renders the three columns in workflow order', () => {
    handleJobsList({ jobs: [], settings: {} });
    const labels = [...document.querySelectorAll('.job-column')].map(c => c.dataset.state);
    expect(labels).toEqual(['todo', 'in-progress', 'review']);
  });

  it('places each job in its own column and counts them', () => {
    handleJobsList({
      jobs: [
        JOB({ id: 'a', state: 'todo' }),
        JOB({ id: 'b', state: 'in-progress', agentSessionId: 's1', agentName: 'Viper' }),
        JOB({ id: 'c', state: 'review', prUrl: 'https://x/pull/9', prNumber: 9 }),
      ],
      settings: {},
    });
    expect(columnCards('todo')).toHaveLength(1);
    expect(columnCards('in-progress')).toHaveLength(1);
    expect(columnCards('review')).toHaveLength(1);
    expect([...document.querySelectorAll('.job-column-count')].map(e => e.textContent)).toEqual(['1', '1', '1']);
  });

  it('shows title, repo, poster, agent and branch on the card', () => {
    handleJobsList({
      jobs: [JOB({
        state: 'in-progress', agentSessionId: 's1', agentName: 'Viper',
        branchName: 'bill/vesper', startedAt: new Date().toISOString(),
      })],
      settings: {},
    });
    const card = cards()[0];
    expect(card.querySelector('.job-card-title').textContent).toBe('Add rate limiting');
    expect(card.querySelector('.job-card-repo').textContent).toBe('alpha');
    expect(card.querySelector('.job-card-posted').textContent).toContain('Bill');
    expect(card.querySelector('.job-card-agent-name').textContent).toBe('Viper');
    expect(card.querySelector('.job-card-branch').textContent).toBe('bill/vesper');
  });

  it('links the PR on a review card', () => {
    handleJobsList({ jobs: [JOB({ state: 'review', prUrl: 'https://gh/o/r/pull/12', prNumber: 12 })], settings: {} });
    const link = cards()[0].querySelector('.job-card-pr');
    expect(link.textContent).toBe('PR #12');
    expect(link.getAttribute('href')).toBe('https://gh/o/r/pull/12');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('escapes a title containing markup rather than rendering it', () => {
    handleJobsList({ jobs: [JOB({ title: '<img src=x onerror=alert(1)>' })], settings: {} });
    const title = cards()[0].querySelector('.job-card-title');
    expect(title.querySelector('img')).toBeNull();
    expect(title.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('surfaces a dispatch failure on the card', () => {
    handleJobsList({ jobs: [JOB({ lastError: 'Failed to create worktree: disk full' })], settings: {} });
    expect(cards()[0].querySelector('.job-card-error').textContent).toMatch(/disk full/);
  });
});

describe('live status badge', () => {
  const inProgress = (agentState, lastOutputAt = Date.now()) => {
    agents.set('s1', { name: 'Viper', state: agentState, lastOutputAt, termEl: document.createElement('div') });
    handleJobsList({ jobs: [JOB({ state: 'in-progress', agentSessionId: 's1', agentName: 'Viper' })], settings: {} });
    return cards()[0];
  };

  it('marks a working agent as running', () => {
    expect(inProgress('WORKING').querySelector('.job-card-status').textContent).toContain('running');
  });

  it('marks an agent at a permission prompt as needing the user', () => {
    const card = inProgress('MESSAGE');
    expect(card.querySelector('.job-card-status').textContent).toContain('needs you');
    expect(card.classList.contains('status-needs-input')).toBe(true);
  });

  it('only flags a WAITING agent once it has been quiet past the window', () => {
    expect(inProgress('WAITING', Date.now()).querySelector('.job-card-status').textContent).toContain('running');
    const stale = inProgress('WAITING', Date.now() - 10 * 60 * 1000);
    expect(stale.querySelector('.job-card-status').textContent).toContain('may need you');
  });

  it('marks a job whose agent has gone', () => {
    handleJobsList({ jobs: [JOB({ state: 'in-progress', agentSessionId: 'missing', agentName: 'Ghost' })], settings: {} });
    const badge = cards()[0].querySelector('.job-card-status');
    expect(badge.textContent).toContain('agent gone');
    expect(badge.disabled).toBe(true);   // nothing to jump to
  });

  it('jumps to the agent terminal when the badge is clicked', () => {
    const card = inProgress('MESSAGE');
    card.querySelector('.job-card-status').click();
    expect(switchToSession).toHaveBeenCalledWith('s1');
  });

  it('opens the agent tab when the card itself is clicked', () => {
    const card = inProgress('WORKING');
    expect(card.classList.contains('job-card-live')).toBe(true);
    card.click();
    expect(switchToSession).toHaveBeenCalledWith('s1');
  });

  it('leaves the keyboard path to the badge rather than nesting a role=button', () => {
    // The card holds buttons and a link; role="button" would hide them from
    // assistive tech, and the badge inside is already a real focusable button.
    const card = inProgress('WORKING');
    expect(card.getAttribute('role')).toBeNull();
    expect(card.hasAttribute('tabindex')).toBe(false);
    expect(card.querySelector('.job-card-status').disabled).toBe(false);
  });

  it('does not jump when the PR link on a live card is clicked', () => {
    // The action buttons stopPropagation themselves; the PR anchor does not, so
    // the card handler is the only thing keeping a PR click from also jumping.
    agents.set('s1', { name: 'Viper', state: 'WORKING', lastOutputAt: Date.now(), termEl: document.createElement('div') });
    handleJobsList({
      jobs: [JOB({ state: 'in-progress', agentSessionId: 's1', agentName: 'Viper', prUrl: 'https://gh/o/r/pull/4', prNumber: 4 })],
      settings: {},
    });
    const link = cards()[0].querySelector('.job-card-pr');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(switchToSession).not.toHaveBeenCalled();
  });

  it('still jumps when the stale selection is somewhere else on the page', () => {
    // Guarding on any non-empty selection would make every card unclickable
    // after the user selected text in a terminal.
    const card = inProgress('WORKING');
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'selected in another pane';
    document.body.appendChild(elsewhere);
    const range = document.createRange();
    range.selectNodeContents(elsewhere);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    card.click();
    expect(switchToSession).toHaveBeenCalledWith('s1');
    sel.removeAllRanges();
  });

  it('does not jump when the click only ended a text selection on the card', () => {
    const card = inProgress('WORKING');
    const range = document.createRange();
    range.selectNodeContents(card.querySelector('.job-card-detail'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    card.click();
    expect(switchToSession).not.toHaveBeenCalled();
    sel.removeAllRanges();
  });

  it('leaves the card inert when its agent is gone', () => {
    handleJobsList({ jobs: [JOB({ state: 'in-progress', agentSessionId: 'missing', agentName: 'Ghost' })], settings: {} });
    const card = cards()[0];
    expect(card.classList.contains('job-card-live')).toBe(false);
    card.click();
    expect(switchToSession).not.toHaveBeenCalled();
  });

  it('does not jump when a card action button is clicked', () => {
    const card = inProgress('WORKING');
    window.confirm = vi.fn(() => false);
    [...card.querySelectorAll('.job-card-btn')].find(b => b.textContent === 'Delete').click();
    expect(switchToSession).not.toHaveBeenCalled();
  });

  it('does not make todo or review cards clickable', () => {
    agents.set('s1', { name: 'Viper', state: 'WORKING', lastOutputAt: Date.now(), termEl: document.createElement('div') });
    handleJobsList({
      jobs: [
        JOB({ id: 'j1', state: 'todo', agentSessionId: 's1', agentName: 'Viper' }),
        JOB({ id: 'j2', state: 'review', agentSessionId: 's1', agentName: 'Viper' }),
      ],
      settings: {},
    });
    expect(document.querySelectorAll('.job-card-live')).toHaveLength(0);
  });

  it('shows no badge on todo or review cards', () => {
    handleJobsList({ jobs: [JOB({ state: 'todo' }), JOB({ id: 'j2', state: 'review' })], settings: {} });
    expect(document.querySelectorAll('.job-card-status')).toHaveLength(0);
  });
});

describe('dispatcher controls', () => {
  it('reflects the stopped state and starts on click', () => {
    handleJobsList({ jobs: [], settings: { running: false, maxPerRepo: 2, intervalMs: 180000 } });
    expect(document.getElementById('btn-dispatcher-toggle').textContent).toBe('Start');
    expect(document.getElementById('job-dispatcher-status').textContent).toMatch(/stopped/);

    document.getElementById('btn-dispatcher-toggle').click();
    expect(send).toHaveBeenCalledWith({ type: 'job-settings', running: true });
  });

  it('reflects the running state and its interval', () => {
    handleJobsList({ jobs: [], settings: { running: true, maxPerRepo: 2, intervalMs: 300000 } });
    expect(document.getElementById('btn-dispatcher-toggle').textContent).toBe('Stop');
    expect(document.getElementById('job-dispatcher-status').textContent).toMatch(/every 5m/);
  });

  it('sends a manual scan', () => {
    document.getElementById('btn-dispatch-now').click();
    expect(send).toHaveBeenCalledWith({ type: 'job-dispatch-now' });
  });

  it('sends a new cap', () => {
    const cap = document.getElementById('job-max-per-repo');
    cap.value = '4';
    cap.dispatchEvent(new Event('change'));
    expect(send).toHaveBeenCalledWith({ type: 'job-settings', maxPerRepo: 4 });
  });
});

describe('job form', () => {
  it('posts a new job with the chosen repo', () => {
    document.getElementById('btn-new-job').click();
    document.getElementById('job-title').value = 'New task';
    document.getElementById('job-detail').value = 'Some detail';
    document.getElementById('btn-job-save').click();
    expect(send).toHaveBeenCalledWith({
      type: 'job-create', title: 'New task', detail: 'Some detail', repoPath: '/repos/alpha',
    });
  });

  it('refuses an empty title instead of posting', () => {
    document.getElementById('btn-new-job').click();
    document.getElementById('job-title').value = '   ';
    document.getElementById('btn-job-save').click();
    expect(send).not.toHaveBeenCalled();
    expect(document.getElementById('job-form-error').style.display).toBe('block');
  });

  it('explains itself when no repo has been added yet', () => {
    repos.clear();
    document.getElementById('btn-new-job').click();
    document.getElementById('job-title').value = 'Task';
    document.getElementById('btn-job-save').click();
    expect(send).not.toHaveBeenCalled();
    expect(document.getElementById('job-form-error').textContent).toMatch(/repository/i);
  });
});

describe('card actions', () => {
  it('offers a manual move to review while in progress', () => {
    handleJobsList({ jobs: [JOB({ state: 'in-progress', agentSessionId: 's1', agentName: 'V' })], settings: {} });
    const btn = [...cards()[0].querySelectorAll('.job-card-btn')].find(b => b.textContent.includes('Review'));
    btn.click();
    expect(send).toHaveBeenCalledWith({ type: 'job-move', jobId: 'job-1', state: 'review' });
  });

  it('confirms before deleting', () => {
    handleJobsList({ jobs: [JOB()], settings: {} });
    const del = [...cards()[0].querySelectorAll('.job-card-btn')].find(b => b.textContent === 'Delete');

    window.confirm = vi.fn(() => false);
    del.click();
    expect(send).not.toHaveBeenCalled();

    window.confirm = vi.fn(() => true);
    del.click();
    expect(send).toHaveBeenCalledWith({ type: 'job-delete', jobId: 'job-1' });
  });
});

describe('show / hide', () => {
  it('hides the board and leaves the active terminal alone', () => {
    const termEl = document.createElement('div');
    agents.set('s9', { name: 'A', state: 'WORKING', termEl, lastOutputAt: Date.now() });
    setActiveSession('s9');
    showJobBoard();
    expect(termEl.style.display).toBe('none');
    expect(document.getElementById('job-board').style.display).toBe('flex');

    hideJobBoard();
    expect(document.getElementById('job-board').style.display).toBe('none');
  });

  it('brings the board up before opening the form from the top bar', () => {
    hideJobBoard();
    // app.js wires this hook to updateTabs(). The pinned board tab has to
    // repaint as active, or the form appears under a tab strip still
    // highlighting the agent the user was looking at.
    const repaintTabs = vi.fn();
    window._onBoardVisibilityChanged = repaintTabs;
    try {
      document.getElementById('btn-new-job-shortcut').click();
      expect(document.getElementById('job-board').style.display).toBe('flex');
      expect(document.getElementById('job-form').style.display).toBe('flex');
      expect(repaintTabs).toHaveBeenCalled();
    } finally {
      delete window._onBoardVisibilityChanged;
    }
  });

  it('dismisses the agent spawn overlay before focusing the job title', () => {
    // The spawn form covers everything below the 36px header strip but leaves
    // the header buttons clickable. Opening the job form underneath it would
    // focus a title input the user cannot see, and eat what they typed next.
    const spawn = document.getElementById('spawn-form');
    spawn.style.display = 'flex';
    openJobForm();
    expect(spawn.style.display).toBe('none');
    expect(document.activeElement.id).toBe('job-title');
  });

  it('dismisses the spawn overlay from the board\'s own buttons too', () => {
    // The overlay sizes to its content instead of covering the viewport, so
    // the board's toolbar and cards stay clickable underneath it. Every door
    // into the form has to clear it, not just the top-bar shortcut.
    handleJobsList({ jobs: [JOB()], settings: {} });
    const spawn = document.getElementById('spawn-form');

    spawn.style.display = 'flex';
    document.getElementById('btn-new-job').click();
    expect(spawn.style.display).toBe('none');

    spawn.style.display = 'flex';
    const edit = [...document.querySelectorAll('.job-card button')]
      .find((b) => b.textContent === 'Edit');
    edit.click();
    expect(spawn.style.display).toBe('none');
  });

  it('opens the form even on a page with no spawn overlay', () => {
    document.getElementById('spawn-form').remove();
    expect(() => openJobForm()).not.toThrow();
    expect(document.getElementById('job-form').style.display).toBe('flex');
  });

  it('closeJobForm dismisses the form so the spawn overlay cannot hide it', () => {
    openJobForm();
    closeJobForm();
    expect(document.getElementById('job-form').style.display).toBe('none');
  });
});

describe('PR link safety', () => {
  it('renders an https PR link', () => {
    handleJobsList({ jobs: [JOB({ state: 'review', prUrl: 'https://gh/o/r/pull/3', prNumber: 3 })], settings: {} });
    expect(document.querySelector('.job-card-pr').getAttribute('href')).toBe('https://gh/o/r/pull/3');
  });

  it('refuses a non-http scheme rather than putting it in an href', () => {
    // job.prUrl comes from `gh pr list`, but a javascript: href executes on
    // click — cheap guard on a value that crosses a trust boundary.
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd']) {
      handleJobsList({ jobs: [JOB({ id: 'x', state: 'review', prUrl: bad, prNumber: 1 })], settings: {} });
      expect(document.querySelector('.job-card-pr')).toBeNull();
    }
  });
});


// --- Finished jobs ---

describe('finished jobs', () => {
  const finishedJob = (over = {}) => JOB({
    id: 'done-1', state: 'done', title: 'Shipped thing',
    branchName: 'bill/shipped', prUrl: 'https://gh/o/r/pull/12', prNumber: 12,
    reviewAt: '2026-08-28T09:00:00Z',
    prMergedAt: '2026-08-28T10:00:00Z', doneAt: '2026-08-28T10:00:01Z',
    ...over,
  });

  function finishedCards() {
    return [...document.querySelectorAll('#job-finished-cards .job-card')];
  }

  it('keeps a merged job off the board entirely', () => {
    // The point of the whole change: Review means "needs your review", so a
    // finished card must not be sitting in it.
    handleJobsList({ jobs: [finishedJob(), JOB({ id: 'r', state: 'review' })], settings: {} });
    expect(columnCards('review')).toHaveLength(1);
    expect(cards().map(c => c.dataset.jobId)).not.toContain('done-1');
  });

  it('counts the finished jobs on the toolbar button', () => {
    handleJobsList({ jobs: [finishedJob(), finishedJob({ id: 'done-2' })], settings: {} });
    expect(document.getElementById('btn-finished-jobs').textContent).toBe('View finished jobs (2)');
  });

  it('drops the count when there is nothing finished', () => {
    handleJobsList({ jobs: [JOB()], settings: {} });
    expect(document.getElementById('btn-finished-jobs').textContent).toBe('View finished jobs');
  });

  it('swaps the columns for the finished list, and back again', () => {
    handleJobsList({ jobs: [finishedJob(), JOB()], settings: {} });
    const columns = document.getElementById('job-columns');
    const panel = document.getElementById('job-finished');
    expect(panel.style.display).toBe('none');

    document.getElementById('btn-finished-jobs').click();
    expect(panel.style.display).toBe('flex');
    expect(columns.style.display).toBe('none');   // never both at once
    expect(finishedCards()).toHaveLength(1);
    expect(document.getElementById('btn-finished-jobs').textContent).toMatch(/Back to board/);

    document.getElementById('btn-finished-jobs').click();
    expect(panel.style.display).toBe('none');
    expect(columns.style.display).not.toBe('none');
    expect(columnCards('todo')).toHaveLength(1);
  });

  it('shows when the PR merged, and keeps the link to it', () => {
    handleJobsList({ jobs: [finishedJob()], settings: {} });
    document.getElementById('btn-finished-jobs').click();
    const card = finishedCards()[0];
    expect(card.querySelector('.job-card-finished').textContent).toMatch(/^merged /);
    expect(card.querySelector('.job-card-pr').getAttribute('href')).toBe('https://gh/o/r/pull/12');
  });

  it('says "finished" rather than "merged" for a job filed away by hand', () => {
    handleJobsList({ jobs: [finishedJob({ prMergedAt: null })], settings: {} });
    document.getElementById('btn-finished-jobs').click();
    expect(finishedCards()[0].querySelector('.job-card-finished').textContent).toMatch(/^finished /);
  });

  it('lists the most recently finished first', () => {
    handleJobsList({
      jobs: [
        finishedJob({ id: 'old', doneAt: '2026-08-01T10:00:00Z' }),
        finishedJob({ id: 'new', doneAt: '2026-08-27T10:00:00Z' }),
      ],
      settings: {},
    });
    document.getElementById('btn-finished-jobs').click();
    expect(finishedCards().map(c => c.dataset.jobId)).toEqual(['new', 'old']);
  });

  it('explains the empty archive rather than showing a blank pane', () => {
    handleJobsList({ jobs: [JOB()], settings: {} });
    document.getElementById('btn-finished-jobs').click();
    expect(document.querySelector('#job-finished-cards .job-column-empty').textContent).toMatch(/No finished jobs/);
  });

  it('offers no way back onto the board — only Delete', () => {
    // Done is terminal: the card is the record of what shipped, and the server
    // refuses every move out of it. Rendering a button the server would reject
    // is worse than rendering none.
    handleJobsList({ jobs: [finishedJob()], settings: {} });
    document.getElementById('btn-finished-jobs').click();
    const labels = [...finishedCards()[0].querySelectorAll('.job-card-btn')].map(b => b.textContent);
    expect(labels).toEqual(['Delete']);
  });

  it('offers Done on a review card, for a merge the board cannot see', () => {
    // It asks first, like Delete: the move cannot be undone.
    handleJobsList({ jobs: [JOB({ id: 'r', state: 'review' })], settings: {} });
    const doneBtn = [...cards()[0].querySelectorAll('.job-card-btn')]
      .find(b => b.textContent.includes('Done'));
    window.confirm = vi.fn(() => true);
    doneBtn.click();
    expect(send).toHaveBeenCalledWith({ type: 'job-move', jobId: 'r', state: 'done' });
  });

  it('does not file a card away when the confirm is declined', () => {
    handleJobsList({ jobs: [JOB({ id: 'r', state: 'review' })], settings: {} });
    const doneBtn = [...cards()[0].querySelectorAll('.job-card-btn')]
      .find(b => b.textContent.includes('Done'));
    window.confirm = vi.fn(() => false);
    doneBtn.click();
    expect(send).not.toHaveBeenCalled();
  });

  it('stays in the archive when the server broadcasts a new job list', () => {
    // The live path: the server rebroadcasts on every scan, so renderBoard runs
    // with the archive already open. Repainting the columns underneath would
    // kick the user out mid-read.
    handleJobsList({ jobs: [finishedJob()], settings: {} });
    document.getElementById('btn-finished-jobs').click();

    handleJobsList({ jobs: [finishedJob(), finishedJob({ id: 'done-2', doneAt: '2026-08-29T10:00:00Z' }), JOB()], settings: {} });
    expect(document.getElementById('job-finished').style.display).toBe('flex');
    expect(document.getElementById('job-columns').style.display).toBe('none');
    expect(finishedCards().map(c => c.dataset.jobId)).toEqual(['done-2', 'done-1']);
  });

  it('returns to the columns when a new job is posted from the archive', () => {
    // The new card lands in To do, which the archive is covering — posting from
    // here would otherwise look like nothing happened.
    handleJobsList({ jobs: [finishedJob()], settings: {} });
    document.getElementById('btn-finished-jobs').click();
    document.getElementById('btn-new-job').click();
    expect(document.getElementById('job-finished').style.display).toBe('none');
  });

  it('keeps the toggle tooltip and aria-pressed in step with its label', () => {
    handleJobsList({ jobs: [finishedJob()], settings: {} });
    const btn = document.getElementById('btn-finished-jobs');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    const boardTitle = btn.title;

    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).not.toBe(boardTitle);
    expect(btn.title).toMatch(/columns/);
  });

  it('falls back to the columns when the archive markup is missing', () => {
    // A page cached from before the upgrade has the old markup and the new
    // module; hiding the columns for an archive that has no container would
    // leave a blank board.
    handleJobsList({ jobs: [finishedJob(), JOB()], settings: {} });
    document.getElementById('btn-finished-jobs').click();
    document.getElementById('job-finished').remove();
    renderBoard();
    expect(document.getElementById('job-columns').style.display).not.toBe('none');
    expect(columnCards('todo')).toHaveLength(1);
  });

  it('reopens on the board after the tab is left and returned to', () => {
    handleJobsList({ jobs: [finishedJob()], settings: {} });
    document.getElementById('btn-finished-jobs').click();
    hideJobBoard();
    showJobBoard();
    expect(document.getElementById('job-finished').style.display).toBe('none');
  });
});

describe('a finished card still shows its record', () => {
  it('shows the branch even when the agent name was lost', () => {
    // A restart used to null agentName, and the branch was rendered inside the
    // agent block — so the card came up with nothing on it but its title.
    handleJobsList({
      jobs: [JOB({ state: 'review', agentName: null, branchName: 'bill10/add-job-button', prUrl: 'https://gh/o/r/pull/18', prNumber: 18 })],
      settings: {},
    });
    const card = document.querySelector('.job-card');
    expect(card.querySelector('.job-card-branch').textContent).toBe('bill10/add-job-button');
    expect(card.querySelector('.job-card-agent-name')).toBeNull();
    expect(card.querySelector('.job-card-pr').textContent).toBe('PR #18');
  });

  it('shows the agent name when there is no branch', () => {
    handleJobsList({ jobs: [JOB({ state: 'review', agentName: 'Phantom', branchName: null })], settings: {} });
    const card = document.querySelector('.job-card');
    expect(card.querySelector('.job-card-agent-name').textContent).toBe('Phantom');
    expect(card.querySelector('.job-card-branch')).toBeNull();
  });

  it('shows both, with when it started', () => {
    handleJobsList({
      jobs: [JOB({ state: 'review', agentName: 'Phantom', branchName: 'bill10/x', startedAt: new Date().toISOString() })],
      settings: {},
    });
    const row = document.querySelector('.job-card-agent');
    expect(row.textContent).toMatch(/Phantom/);
    expect(row.textContent).toMatch(/bill10\/x/);
    expect(row.textContent).toMatch(/started/);
  });

  it('renders no agent row at all when neither is known', () => {
    handleJobsList({ jobs: [JOB({ state: 'todo', agentName: null, branchName: null })], settings: {} });
    expect(document.querySelector('.job-card-agent')).toBeNull();
  });
});
