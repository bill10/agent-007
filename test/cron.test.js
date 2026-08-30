import { describe, it, expect } from 'vitest';
import { parseCron, isValidCron, nextCronTime, nextCronIso, CRON_MACROS, MAX_SCHEDULE_LEN } from '../lib/cron.js';

// Local time throughout, because that is what the parser answers in. Building
// the reference points with `new Date(y, m, d, ...)` keeps the tests honest
// wherever the suite runs: an ISO literal would be UTC and would drift.
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
const next = (expr, from) => new Date(nextCronTime(expr, from));

describe('the day-field star rule', () => {
  const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
  const next = (expr, from) => new Date(nextCronTime(expr, from));

  it('treats a step like */2 as a star, the way Vixie cron does', () => {
    // dow begins with `*`, so BOTH day conditions must hold: the 1st of a
    // month AND an even weekday. The OR reading would return the very next
    // even weekday instead of waiting for a matching 1st.
    const d = next('0 0 1 * */2', at(2026, 5, 15));
    expect(d.getDate()).toBe(1);
    expect([0, 2, 4, 6]).toContain(d.getDay());
  });

  it('applies the same rule with the step on the day-of-month side', () => {
    const d = next('0 0 */2 * 1', at(2026, 5, 15));
    expect(d.getDay()).toBe(1);          // a Monday
    expect(d.getDate() % 2).toBe(1);     // on an odd day (*/2 from 1)
  });
});

describe('parseCron', () => {
  it('expands each field into the values it matches', () => {
    const p = parseCron('0 9 * * 1-5');
    expect(p.error).toBeUndefined();
    expect([...p.minute]).toEqual([0]);
    expect([...p.hour]).toEqual([9]);
    expect([...p.dow].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(p.domStar).toBe(true);
    expect(p.dowStar).toBe(false);
  });

  it('handles steps, ranges, lists, and a bare number with a step', () => {
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0-10/5 * * * *').minute]).toEqual([0, 5, 10]);
    expect([...parseCron('0,30 * * * *').minute]).toEqual([0, 30]);
    // "5/20" is crontab for "from 5 to the end of the field, every 20".
    expect([...parseCron('5/20 * * * *').minute]).toEqual([5, 25, 45]);
  });

  it('accepts 7 as Sunday, the same day 0 already is', () => {
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0]);
    expect([...parseCron('0 0 * * 0,7').dow]).toEqual([0]);
  });

  it('expands every documented shorthand', () => {
    for (const [macro, expanded] of Object.entries(CRON_MACROS)) {
      expect(isValidCron(macro)).toBe(true);
      expect(nextCronTime(macro, at(2026, 3, 4, 12))).toBe(nextCronTime(expanded, at(2026, 3, 4, 12)));
    }
    // Case-insensitively, since the field is free text.
    expect(isValidCron('@DAILY')).toBe(true);
  });

  it('explains what is wrong rather than just failing', () => {
    expect(parseCron('').error).toMatch(/needs a cron schedule/i);
    expect(parseCron('0 9 * *').error).toMatch(/five fields/i);
    expect(parseCron('0 9 * * * *').error).toMatch(/five fields/i);
    expect(parseCron('60 * * * *').error).toMatch(/minute must be between 0 and 59/i);
    expect(parseCron('0 24 * * *').error).toMatch(/hour must be between 0 and 23/i);
    expect(parseCron('0 0 0 * *').error).toMatch(/day of month must be between 1 and 31/i);
    expect(parseCron('0 0 * 13 *').error).toMatch(/month must be between 1 and 12/i);
    expect(parseCron('0 0 * * 8').error).toMatch(/day of week must be between 0 and 7/i);
    expect(parseCron('10-5 * * * *').error).toMatch(/backwards/i);
    expect(parseCron('*/0 * * * *').error).toMatch(/step/i);
    expect(parseCron('*/x * * * *').error).toMatch(/step/i);
    expect(parseCron('1/2/3 * * * *').error).toMatch(/not a valid/i);
    expect(parseCron('mon * * * *').error).toMatch(/not a valid minute/i);
    expect(parseCron('0,,5 * * * *').error).toMatch(/empty minute/i);
    expect(parseCron('@nightly').error).toMatch(/unknown schedule shorthand/i);
    expect(parseCron('0 '.repeat(MAX_SCHEDULE_LEN)).error).toMatch(/too long/i);
  });
});

describe('nextCronTime', () => {
  it('is strictly after the moment asked about, so a job cannot re-fire on itself', () => {
    // Exactly on a match: the answer is the NEXT one, not this one.
    expect(next('0 * * * *', at(2026, 6, 10, 14, 0)).getTime()).toBe(at(2026, 6, 10, 15, 0));
  });

  it('finds the next matching minute within the hour', () => {
    expect(next('*/15 * * * *', at(2026, 6, 10, 14, 3)).getTime()).toBe(at(2026, 6, 10, 14, 15));
  });

  it('rolls over the hour, the day, the month and the year', () => {
    expect(next('0 9 * * *', at(2026, 6, 10, 14, 0)).getTime()).toBe(at(2026, 6, 11, 9, 0));
    expect(next('0 0 1 * *', at(2026, 6, 10)).getTime()).toBe(at(2026, 7, 1, 0, 0));
    expect(next('0 0 1 1 *', at(2026, 6, 10)).getTime()).toBe(at(2027, 1, 1, 0, 0));
  });

  it('skips the weekend for a weekday schedule', () => {
    // 2026-08-28 is a Friday, so the next weekday 09:00 is the Monday.
    expect(next('0 9 * * 1-5', at(2026, 8, 28, 10, 0)).getTime()).toBe(at(2026, 8, 31, 9, 0));
  });

  it('ORs the two day fields when both are restricted, and ANDs nothing when one is *', () => {
    // Both restricted: the 13th OR any Friday. 2026-03-04 is a Wednesday, so
    // the Friday (the 6th) comes before the 13th.
    expect(next('0 0 13 * 5', at(2026, 3, 4, 12)).getTime()).toBe(at(2026, 3, 6, 0, 0));
    // Only day-of-month restricted: the 13th, and the weekday is irrelevant.
    expect(next('0 0 13 * *', at(2026, 3, 4, 12)).getTime()).toBe(at(2026, 3, 13, 0, 0));
  });

  it('reaches a date years away', () => {
    // 29 February: 2028 is the next leap year after 2026.
    expect(next('0 0 29 2 *', at(2026, 3, 1)).getTime()).toBe(at(2028, 2, 29, 0, 0));
  });

  it('gives up rather than looping on an expression that can never match', () => {
    // Syntactically fine, but 30 February is not a date.
    expect(nextCronTime('0 0 30 2 *', at(2026, 3, 1))).toBeNull();
    expect(nextCronIso('0 0 30 2 *', at(2026, 3, 1))).toBeNull();
  });

  it('skips an hour that does not exist on a daylight-saving day, and keeps going', () => {
    // 2027-03-14 02:30 never happens in a US spring-forward zone. Skipping it
    // is what cron does; what matters here is that the walk still terminates
    // and lands on the next real occurrence rather than spinning on local
    // arithmetic that cannot advance.
    const from = new Date(2027, 2, 13, 12, 0, 0).getTime();
    const hit = nextCronTime('30 2 * * *', from);
    expect(hit).not.toBeNull();
    expect(hit).toBeGreaterThan(from);
    // Either the 14th (in a zone with no transition) or the 15th (in one that
    // has it) — never a time before the 14th, and never a hang.
    expect(hit).toBeLessThanOrEqual(at(2027, 3, 15, 2, 30));
  });

  it('returns null for an expression it cannot parse', () => {
    expect(nextCronTime('nonsense')).toBeNull();
    expect(nextCronIso('nonsense')).toBeNull();
  });

  it('answers in ISO when asked to', () => {
    expect(nextCronIso('0 9 * * *', at(2026, 6, 10, 14))).toBe(new Date(at(2026, 6, 11, 9)).toISOString());
  });
});
