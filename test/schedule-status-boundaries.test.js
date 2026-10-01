// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { scheduleStatus } from '../lib/schedule-status.js';
import { DISPATCH_INTERVAL_MS } from '../lib/jobs.js';
import { renderScheduleStatus } from '../public/modules/schedule-status.js';

const now = Date.parse('2026-10-01T12:00:00Z');
const at = offset => new Date(now + offset).toISOString();
const schedule = { id: 'schedule', type: 'scheduled', state: 'todo', schedule: '@hourly',
  postedBy: 'owner', repoPath: '/synthetic', nextRunAt: at(3600000) };

describe('schedule evidence boundary coverage', () => {
  it('an expired hold resumes classification and invalid cadence uses the actual default', () => {
    for (const intervalMs of [0, -1, NaN, Infinity]) {
      const result = scheduleStatus({ ...schedule, holdUntil: at(0), nextRunAt: at(-DISPATCH_INTERVAL_MS) }, [], new Map(), { now, intervalMs });
      expect(result).toMatchObject({ code: 'due', graceMs: DISPATCH_INTERVAL_MS });
    }
    expect(scheduleStatus({ ...schedule, holdUntil: 'invalid', nextRunAt: at(-DISPATCH_INTERVAL_MS - 1) }, [], new Map(), { now }).code).toBe('overdue');
  });

  it('completed work retains factual start and finish timestamps without an active blocker', () => {
    const run = { id: 'finished', scheduleId: schedule.id, postedBy: schedule.postedBy, repoPath: schedule.repoPath,
      state: 'done', startedAt: at(-120000), doneAt: at(-60000) };
    const result = scheduleStatus({ ...schedule, lastRunJobId: run.id, lastRunAt: at(-180000) }, [run], new Map(), { now });
    expect(result).toMatchObject({ code: 'scheduled', blocker: null, lastRun: { id: 'finished', startedAt: at(-120000), doneAt: at(-60000) } });
    const el = renderScheduleStatus(result, vi.fn());
    expect(el.textContent).toContain(`Run finished: ${at(-60000)}`);
    expect(el.querySelector('button')).toBeNull();
  });

  it('a caller can preserve expanded evidence across refreshed snapshots and observe closing', () => {
    const result = scheduleStatus(schedule, [], new Map(), { now });
    const onToggle = vi.fn();
    const el = renderScheduleStatus(result, vi.fn(), { expanded: true, onToggle });
    const details = el.querySelector('details');
    expect(details.open).toBe(true);
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    expect(onToggle).toHaveBeenLastCalledWith(false);
    expect(renderScheduleStatus(result, vi.fn()).querySelector('details').open).toBe(false);
  });
});
