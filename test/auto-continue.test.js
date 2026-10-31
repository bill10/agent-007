// A board worker continued after a transient API error (server/auto-continue.js).
import { describe, it, expect, vi } from 'vitest';
import { classifyTail, sinceContinue, autoContinueTick, MAX_AUTO_CONTINUES, BACKOFF_MS } from '../server/auto-continue.js';

const OVERLOADED = '  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

describe('classifyTail', () => {
  it('reads transient API errors', () => {
    for (const line of [
      OVERLOADED,
      '  ⎿  API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      '  ⎿  API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      '  ⎿  API Error: Connection error.',
      '  ⎿  API Error: fetch failed',
      '■ stream disconnected before completion: error sending request',
      '■ unexpected status 503 Service Unavailable',
    ]) expect(classifyTail(`● Working on it\n${line}\n\n> \n  ? for shortcuts`), line).toMatchObject({ kind: 'transient' });
  });

  it('leaves usage limits to billion-limit.js', () => {
    expect(classifyTail(`${OVERLOADED}\nYou've hit your session limit · resets 3pm`).kind).toBe('limit');
  });

  it('leaves logins to account rotation', () => {
    expect(classifyTail('  ⎿  API Error: 401 {"type":"error","error":{"type":"authentication_error"}}').kind).toBe('auth');
    expect(classifyTail(`${OVERLOADED}\nOAuth token has expired. Please run /login`).kind).toBe('auth');
    expect(classifyTail('  ⎿  API Error: 403 Forbidden').kind).toBe('auth');
  });

  it('ignores prose about errors', () => {
    expect(classifyTail('● The retry fixes "API Error: 529" and fetch failed cases.\n> ').kind).toBe(null);
    expect(classifyTail('● Done. PR opened.\n> ').kind).toBe(null);
    expect(classifyTail('● Handled:\n  - API Error: 529 now retries\n> ').kind).toBe(null);
  });

  it('reads only what came after our last continue', () => {
    expect(classifyTail(sinceContinue(`${OVERLOADED}\n> continue\n● Done.\n> `)).kind).toBe(null);
    expect(classifyTail(sinceContinue(`${OVERLOADED}\n> continue\n${OVERLOADED}\n> `)).kind).toBe('transient');
  });
});

describe('autoContinueTick', () => {
  const T0 = 1_000_000_000;
  const worker = (screen, over = {}) => ({
    state: 'WAITING', lastOutputAt: T0, stateChangedAt: T0, ringBuffer: { getAll: () => [screen] }, ...over,
  });

  it('waits out the backoff, then types continue and logs it', () => {
    const job = {}, send = vi.fn(() => true), s = worker(`${OVERLOADED}\n> `);
    expect(autoContinueTick(job, s, { now: T0 + BACKOFF_MS - 1, send })).toBe(null);
    expect(autoContinueTick(job, s, { now: T0 + BACKOFF_MS, send })).toBe('continued');
    expect(send).toHaveBeenCalledWith(s, 'continue', T0 + BACKOFF_MS);
    expect(job.autoContinue.log[0].text).toMatch(/Auto-continue 1\/2.*529/);
    // Not again until the worker has moved.
    expect(autoContinueTick(job, s, { now: T0 + 2 * BACKOFF_MS, send })).toBe(null);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it(`stops at ${MAX_AUTO_CONTINUES} per card and says so once`, () => {
    const job = {}, send = vi.fn(() => true);
    let t = T0;
    const failAgain = () => { t += BACKOFF_MS + 1000; return worker(`${OVERLOADED}\n> continue\n${OVERLOADED}\n> `, { lastOutputAt: t - BACKOFF_MS, stateChangedAt: t - BACKOFF_MS }); };
    expect(autoContinueTick(job, failAgain(), { now: t, send })).toBe('continued');
    expect(autoContinueTick(job, failAgain(), { now: t, send })).toBe('continued');
    expect(autoContinueTick(job, failAgain(), { now: t, send })).toBe('spent');
    expect(autoContinueTick(job, failAgain(), { now: t, send })).toBe(null);
    expect(send).toHaveBeenCalledTimes(2);
    expect(job.autoContinue.log.at(-1).text).toMatch(/Not continued/);
  });

  it('a clean turn resets the budget', () => {
    const job = { autoContinue: { count: 2, at: T0, spent: true, log: [] } }, send = vi.fn(() => true);
    expect(autoContinueTick(job, worker(`${OVERLOADED}\n> continue\n● Done.\n> `, { stateChangedAt: T0 + 5 }), { now: T0 + 10, send })).toBe('reset');
    expect(job.autoContinue).toMatchObject({ count: 0, spent: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves Billion, busy, limited and logged-out workers alone', () => {
    const send = vi.fn(() => true), now = T0 + BACKOFF_MS;
    expect(autoContinueTick({}, worker(OVERLOADED, { isBillion: true }), { now, send })).toBe(null);
    expect(autoContinueTick({}, worker(OVERLOADED, { state: 'WORKING' }), { now, send })).toBe(null);
    expect(autoContinueTick({}, worker(`${OVERLOADED}\nYou've hit your weekly limit`), { now, send })).toBe(null);
    expect(autoContinueTick({}, worker(`${OVERLOADED}\nPlease run /login`), { now, send })).toBe(null);
    expect(send).not.toHaveBeenCalled();
  });
});
