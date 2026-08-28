// @vitest-environment happy-dom
//
// A card an agent posted has to be distinguishable at a glance from one a
// person typed into the form — that is the whole point of storing postedByAgent
// separately from postedByName. The meta line joins up to three facts with
// ' · ', and any of the first two can be missing.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

import { jobs, agents, repos, setActiveSession } from '../public/modules/state.js';
import { handleJobsList, showJobBoard, setupJobBoard } from '../public/modules/jobs.js';

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
      </div>
      <div class="job-form" id="job-form" style="display:none">
        <input type="text" id="job-title">
        <select id="job-repo"></select>
        <select id="job-type">
          <option value="one-time">One-time</option>
          <option value="scheduled">Scheduled</option>
        </select>
        <div id="job-schedule-field" style="display:none">
          <input type="text" id="job-schedule">
        </div>
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
  postedByName: null, postedByAgent: null, postedAt: new Date().toISOString(),
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

const postedLine = () => document.querySelector('.job-card-posted');

describe('a card an agent posted', () => {
  it('names the person and the agent, in that order', () => {
    handleJobsList({ jobs: [JOB({ postedByName: 'Bill', postedByAgent: 'Onyx' })], settings: {} });
    const text = postedLine().textContent;
    expect(text).toContain('Bill');
    expect(text).toContain('via Onyx');
    expect(text.indexOf('Bill')).toBeLessThan(text.indexOf('via Onyx'));
  });

  it('tints the agent so a machine-queued card reads differently', () => {
    handleJobsList({ jobs: [JOB({ postedByName: 'Bill', postedByAgent: 'Onyx' })], settings: {} });
    expect(postedLine().querySelector('.job-card-via').textContent).toBe('via Onyx');
  });

  it('leads with the agent when no human owns the terminal yet', () => {
    // Auth is off by default, so a session has no owner and postedByName is
    // null. A naive join would leave a stray leading separator: "· via Mirage".
    handleJobsList({ jobs: [JOB({ postedByAgent: 'Mirage' })], settings: {} });
    const text = postedLine().textContent;
    expect(text.startsWith('via Mirage')).toBe(true);
    expect(text).not.toContain('· via Mirage');
  });

  it('escapes an agent name rather than rendering it as markup', () => {
    handleJobsList({ jobs: [JOB({ postedByAgent: '<img src=x onerror=alert(1)>' })], settings: {} });
    expect(postedLine().querySelector('img')).toBeNull();
    expect(postedLine().textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('a card a person typed', () => {
  it('is unchanged — no "via", no stray separator', () => {
    handleJobsList({ jobs: [JOB({ postedByName: 'Bill' })], settings: {} });
    const text = postedLine().textContent;
    expect(text).toContain('Bill');
    expect(text).not.toContain('via');
    expect(postedLine().querySelector('.job-card-via')).toBeNull();
  });

  it('shows only the time when nothing else is known', () => {
    handleJobsList({ jobs: [JOB()], settings: {} });
    expect(postedLine().textContent).not.toContain('·');
  });
});
