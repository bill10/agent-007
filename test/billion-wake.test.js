// The server's operating loop for Billion (server/billion-wake.js).
import { describe, it, expect, vi } from 'vitest';
import { wakeTick, setNextWake, nextWakeAt, WAKE_PROMPT, WAKE_QUIET_MIN, WAKE_BUSY_MIN, OWNER_QUIET_MS } from '../server/billion-wake.js';
import { sendText, dropMessages } from '../server/messages.js';

const MIN = 60_000;
const T0 = 1_000_000_000;
let ids = 0;
// A Billion resting at its prompt, inbox open, started at T0.
const billion = (over = {}) => ({
  id: `wake-${++ids}`, isBillion: true, exited: false, messagesHeld: false, createdAt: T0,
  state: 'WAITING', stateChangedAt: T0, lastOutputAt: T0, isTUI: true,
  lastStrippedLine: '>', recentStrippedLines: ['>'], ringBuffer: { getAll: () => [] },
  pty: { write: vi.fn() }, ...over,
});
const tick = (s, at, busy = false) => { const send = vi.fn(() => true); return { woke: wakeTick(s, { now: at, busy, send }), send }; };

describe('wakeTick', () => {
  it('wakes every 30 minutes when quiet, typing the cycle prompt', () => {
    const s = billion();
    expect(tick(s, T0 + (WAKE_QUIET_MIN - 1) * MIN).woke).toBe(false);
    const { woke, send } = tick(s, T0 + WAKE_QUIET_MIN * MIN);
    expect(woke).toBe(true);
    expect(send).toHaveBeenCalledWith(s, WAKE_PROMPT, T0 + WAKE_QUIET_MIN * MIN);
    // Measured from that wake now.
    expect(nextWakeAt(s, false)).toBe(T0 + 2 * WAKE_QUIET_MIN * MIN);
  });

  it('wakes every 3 minutes while its cards are in progress or in Review', () => {
    expect(tick(billion(), T0 + WAKE_BUSY_MIN * MIN, true).woke).toBe(true);
  });

  it('never mid-turn, at a dialog, or with its inbox closed', () => {
    const due = T0 + WAKE_QUIET_MIN * MIN;
    expect(tick(billion({ state: 'WORKING' }), due).woke).toBe(false);
    expect(tick(billion({ state: 'MESSAGE' }), due).woke).toBe(false);
    expect(tick(billion({ messagesHeld: true }), due).woke).toBe(false);
    expect(tick(billion({ exited: true }), due).woke).toBe(false);
  });

  it('not within two minutes of the owner typing there', () => {
    const due = T0 + WAKE_QUIET_MIN * MIN;
    const s = billion({ lastUserInputAt: due - OWNER_QUIET_MS + 1000 });
    expect(tick(s, due).woke).toBe(false);
    expect(tick(s, due + 1000).woke).toBe(true);
  });

  it('lets waiting mail go first', () => {
    const s = billion({ messagesHeld: true });
    sendText(s, 'a notice');
    s.messagesHeld = false;
    expect(tick(s, T0 + WAKE_QUIET_MIN * MIN).woke).toBe(false);
    dropMessages(s.id);
  });
});

describe('set_next_wake', () => {
  it('sets the next wake only, then the pace comes back', () => {
    const s = billion();
    expect(setNextWake(s, 10, T0)).toEqual({ at: T0 + 10 * MIN });
    expect(tick(s, T0 + 9 * MIN, true).woke).toBe(false);   // later than the busy pace
    expect(tick(s, T0 + 10 * MIN, true).woke).toBe(true);
    expect(s.wakeAt).toBeNull();
    expect(nextWakeAt(s, true)).toBe(T0 + (10 + WAKE_BUSY_MIN) * MIN);
  });

  it('takes 3 to 60 whole minutes', () => {
    const s = billion();
    for (const bad of [2, 61, 4.5, '10', undefined]) expect(setNextWake(s, bad).error).toMatch(/3 to 60/);
    expect(setNextWake(s, 3).at).toBeGreaterThan(0);
    expect(setNextWake(s, 60).at).toBeGreaterThan(0);
  });
});

describe('the set_next_wake tool', async () => {
  const { handleMcpMessage, toolsFor } = await import('../server/mcp.js');
  const call = (ctx, minutes) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_next_wake', arguments: { minutes } } }, ctx);

  it('is Billion\'s alone', () => {
    expect(toolsFor({ isBillion: true }).some(t => t.name === 'set_next_wake')).toBe(true);
    expect(toolsFor({}).some(t => t.name === 'set_next_wake')).toBe(false);
    expect(call({ session: {} }, 10).error.message).toMatch(/Unknown tool/);
  });

  it('sets the wake and says when, or why not', () => {
    const s = billion();
    const ctx = { session: s, setNextWake: (m) => setNextWake(s, m) };
    expect(call(ctx, 15).result.isError).toBe(false);
    expect(s.wakeAt).toBeGreaterThan(Date.now());
    expect(call(ctx, 90).result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/3 to 60/) }] });
  });
});

describe('billionBusy', async () => {
  const { billionBusy } = await import('../server/billion-wake.js');
  const NOW = T0 + 60 * MIN;
  const since = T0;
  const card = (over) => ({ postedByBillion: true, state: 'in-progress', agentSessionId: 'w', ...over });
  const worker = (over) => ({ exited: false, state: 'WORKING', lastOutputAt: NOW, ...over });
  const busy = (jobs, session) => billionBusy(jobs, () => session, since, NOW);

  it('counts a Billion card whose worker is running', () => {
    expect(busy([card()], worker())).toBe(true);
    expect(busy([card({ postedByBillion: false })], worker())).toBe(false);
  });

  it('not a stalled, needs-you or gone worker: a stalled In-progress card keeps the quiet pace', () => {
    expect(busy([card()], worker({ state: 'WAITING', lastOutputAt: NOW - 60 * MIN }))).toBe(false);
    expect(busy([card()], worker({ state: 'MESSAGE' }))).toBe(false);
    expect(busy([card()], null)).toBe(false);
    const s = billion();
    const stalled = billionBusy([card()], () => worker({ state: 'WAITING', lastOutputAt: NOW - 60 * MIN }), since, NOW);
    expect(tick(s, T0 + WAKE_BUSY_MIN * MIN, stalled).woke).toBe(false);
    expect(tick(s, T0 + WAKE_QUIET_MIN * MIN, stalled).woke).toBe(true);
  });

  it('counts a card that reached Review or finished CI since the last wake, not one sitting there', () => {
    const iso = (t) => new Date(t).toISOString();
    expect(busy([card({ state: 'review', reviewAt: iso(since + MIN) })])).toBe(true);
    expect(busy([card({ state: 'review', reviewAt: iso(since - MIN), ciNotifiedAt: iso(since + MIN) })])).toBe(true);
    expect(busy([card({ state: 'review', reviewAt: iso(since - MIN) })])).toBe(false);
    expect(busy([card({ state: 'done', reviewAt: iso(since + MIN) })])).toBe(false);
  });
});
