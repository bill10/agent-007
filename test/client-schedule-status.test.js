// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { renderScheduleStatus } from '../public/modules/schedule-status.js';

const status = { label: 'Held: prior worker gone', attention: true, reason: 'Prior run holds the schedule.', action: 'Inspect the blocking run.',
  blocker: { id: 'original', agentName: 'Shadow', status: 'gone' }, lastExpectedAt: '2026-10-01T09:00:00Z', observedAt: '2026-10-01T09:07:00Z', outcome: 'held',
  lastRunAt: '2026-09-30T09:00:00Z', lastRun: { id: 'original', state: 'in-progress', status: 'gone', startedAt: '2026-09-30T09:02:00Z' },
  nextDueAt: '2026-10-02T09:00:00Z', timeZone: 'America/Los_Angeles', graceMs: 300000, checkedAt: '2026-10-01T09:07:00Z' };

describe('existing schedule-card evidence', () => {
  it('shows actionable status and factual posting/start evidence with server timezone', () => {
    const open = vi.fn();
    const el = renderScheduleStatus(status, open);
    expect(el.textContent).toContain('Held: prior worker gone');
    expect(el.textContent).toContain('Last expected (saved due): 2026-10-01T09:00:00Z');
    expect(el.textContent).toContain('Last run posted: 2026-09-30T09:00:00Z');
    expect(el.textContent).toContain('Worker started: 2026-09-30T09:02:00Z');
    expect(el.textContent).toContain('America/Los_Angeles · scan interval 300s');
    el.querySelector('button').click();
    expect(open).toHaveBeenCalledWith('original');
  });
  it('renders injected text as text and does not offer retry or other mutations', () => {
    const el = renderScheduleStatus({ ...status, label: '<img src=x>', blocker: { id: '<script>x</script>', state: 'todo' } }, vi.fn());
    expect(el.querySelector('img,script')).toBeNull();
    expect(el.querySelectorAll('button')).toHaveLength(1);
    expect(el.textContent).not.toMatch(/Retry|Requeue|Retire/);
  });
  it('keeps unavailable legacy evidence explicit and non-attention states quiet', () => {
    expect(renderScheduleStatus(null)).toBeNull();
    const el = renderScheduleStatus({ ...status, attention: false, blocker: null, lastRun: null, lastRunAt: null, lastExpectedAt: null, observedAt: null, nextDueAt: null, outcome: null }, vi.fn());
    expect(el.classList.contains('job-schedule-attention')).toBe(false);
    expect(el.querySelector('button')).toBeNull();
    expect(el.textContent).toContain('Last expected (saved due): not recorded');
    expect(el.textContent).toContain('Observed: not recorded');
  });
});
