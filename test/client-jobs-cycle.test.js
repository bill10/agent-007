// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

// No mocks: load BOTH real modules to prove the terminal.js <-> jobs.js import
// cycle resolves. If either called across the cycle at module-evaluation time,
// this import would throw on a live binding that is still in the TDZ.
describe('terminal.js <-> jobs.js module cycle', () => {
  it('both modules evaluate without a TDZ error, in either import order', async () => {
    const term = await import('../public/modules/terminal.js');
    const board = await import('../public/modules/jobs.js');
    expect(typeof term.updateTabs).toBe('function');
    expect(typeof term.switchToSession).toBe('function');
    expect(typeof board.showJobBoard).toBe('function');
    expect(typeof board.renderBoard).toBe('function');
  });
});

// The Jobs tab's attention badge reads the job list, so it has to know the
// difference between a one-time job whose agent vanished (something went wrong,
// look at it) and a scheduled run whose agent has gone (it finished, and the
// board closes the card out on its next scan).
describe('the Jobs tab attention badge', () => {
  async function badgeFor(job, agent) {
    const { updateTabs } = await import('../public/modules/terminal.js');
    const { jobs, agents } = await import('../public/modules/state.js');
    document.body.innerHTML = '<div id="terminal-tabs"></div>';
    jobs.clear();
    agents.clear();
    jobs.set(job.id, job);
    if (agent) agents.set(job.agentSessionId, agent);
    updateTabs();
    const badge = document.querySelector('.board-tab-badge');
    return badge ? badge.textContent : null;
  }

  const running = { id: 'j1', state: 'in-progress', agentSessionId: 's1' };

  it('counts a one-time job whose agent is gone', async () => {
    expect(await badgeFor({ ...running, type: 'one-time' }, null)).toBe('1');
  });

  it('does not count a scheduled run whose agent is gone — that is it finishing', async () => {
    expect(await badgeFor({ ...running, type: 'scheduled' }, null)).toBeNull();
    expect(await badgeFor({ ...running, type: 'scheduled' }, { state: 'DISCONNECTED' })).toBeNull();
  });

  it('still counts a scheduled run that is actually asking a question', async () => {
    expect(await badgeFor({ ...running, type: 'scheduled' }, { state: 'MESSAGE' })).toBe('1');
  });
});
