// @vitest-environment happy-dom
//
// renderCard's meta line joins postedByName, postedByAgent and the timestamp
// with ' · ', filtering out whichever facts are absent. Every existing test
// that sets postedByAgent also has a postedByName (a human-owned card), so the
// case an agent posts before anyone owns the terminal — postedByName null,
// postedByAgent set — has never run: does the join leave a stray leading
// separator ("· via Mirage · ...")?

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

import { jobs, agents, repos, setActiveSession } from '../public/modules/state.js';
import { handleJobsList, showJobBoard, setupJobBoard } from '../public/modules/jobs.js';

const BOARD_HTML = `
  <div id="terminal-viewport">
    <div id="terminal-empty"></div>
    <div class="job-board" id="job-board" style="display:none">
      <div class="job-board-toolbar">
        <button id="btn-new-job"></button>
        <button id="btn-dispatcher-toggle"></button>
        <button id="btn-dispatch-now"></button>
        <span id="job-dispatcher-status"></span>
        <input type="number" id="job-max-per-repo">
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
    </div>
  </div>`;

const JOB = (over = {}) => ({
  id: 'job-1', title: 'Add rate limiting', detail: 'Token bucket.',
  repoPath: '/repos/alpha', state: 'todo',
  postedByName: null, postedAt: new Date().toISOString(),
  agentSessionId: null, agentName: null, startedAt: null,
  branchName: null, prUrl: null, prNumber: null, lastError: null,
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

describe('board rendering: agent-posted card with no owner yet', () => {
  it('leads with "via <agent>" rather than a stray separator when no human is attributed', () => {
    handleJobsList({ jobs: [JOB({ postedByAgent: 'Mirage' })], settings: {} });
    const posted = cards()[0].querySelector('.job-card-posted');
    // The join must drop the missing postedByName cleanly, not leave
    // " · via Mirage · ..." or start with a bare separator.
    expect(posted.textContent.startsWith('via Mirage')).toBe(true);
    expect(posted.textContent).not.toMatch(/^\s*·/);
    expect(cards()[0].querySelector('.job-card-via').textContent).toBe('via Mirage');
  });
});
