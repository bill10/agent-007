// Billion switching CLI at a usage limit (server/billion-limit.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchLimit, limitTick, resetLimitWatch, SWITCH_GAP_MS, SETTLE_MS } from '../server/billion-limit.js';

// Seen verbatim in worker screens on 2026-09-26, and read out of the CLIs.
const CLAUDE_WARN = "You've used 92% of your weekly limit · resets 10am (America/Los_Angeles)";
const CLAUDE_OUT = "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.";

describe('matchLimit', () => {
  it('reads Claude Code\'s warning with its percent and limit', () => {
    expect(matchLimit(`● Done.\n\n${CLAUDE_WARN}\n> `)).toMatchObject({ kind: 'warning', used: 92, limit: 'weeklylimit' });
    // Cursor moves stripped away can take the spaces with them.
    expect(matchLimit("You'veused80%ofyoursessionlimit·resets3pm")).toMatchObject({ kind: 'warning', used: 80, limit: 'sessionlimit' });
  });

  it('reads Codex\'s warning as the share used', () => {
    expect(matchLimit('⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.'))
      .toMatchObject({ kind: 'warning', used: 75 });
  });

  it('reads the hard limits', () => {
    for (const text of [
      CLAUDE_OUT,
      "You've hit your session limit · resets 3pm (America/Los_Angeles)",
      "You've hit your weekly limit · resets Oct 3, 10am",
      "You've hit your team's shared budget. /model to switch models.",
      "You've reached your Fable limit",
      "You're out of extra usage",
      'Claude usage limit reached. Your limit will reset at 3pm.',
      "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 4:05 PM.",
      "You're out of credits.",
      'Your workspace is out of credits. Add credits to continue.',
      'Usage limit reached. You\'ve reached your usage limit.',
    ]) expect(matchLimit(`some output\n${text}\n> `), text).toMatchObject({ kind: 'hard' });
    expect(matchLimit(`x\n${CLAUDE_OUT}`).line).toBe(CLAUDE_OUT);
    expect(matchLimit("──────You'vehityoursessionlimit·resets3pm").kind).toBe('hard');
    expect(matchLimit("You'vereachedyourFablelimit").kind).toBe('hard');
  });

  it('a hard limit wins over a warning on the same screen', () => {
    expect(matchLimit(`${CLAUDE_WARN}\n${CLAUDE_OUT}`).kind).toBe('hard');
  });

  it('leaves ordinary words about limits alone', () => {
    for (const text of [
      'The worker may hit its usage limit soon; I will check the board.',
      'I have used 92% of the context window.',
      "You've hit your fast limit · resets in 8m",
      "You'vehityourfastlimit",
      "You've used its skills recently",
      'Rate limit exceeded, retrying in 2s',
      'Posted a card: handle usage limits in the dispatcher.',
      'Approaching usage limit',
      '● Claude Code said "You\'re out of usage credits" before the switch.',
      "It said You've hit your session limit, so I moved over.",
      "The worker's screen: 'You've used 92% of your weekly limit'",
      "- You've hit your session limit (from STATE.md)",
      "> You're out of usage credits",
    ]) expect(matchLimit(text), text).toBeNull();
  });
});

const T0 = 1_000_000_000;
let ids = 0;
// Billion at rest, `screen` the last thing it printed.
const billion = (screen, over = {}) => ({
  id: `lim-${++ids}`, isBillion: true, exited: false, agent: 'claude',
  state: 'WAITING', lastOutputAt: T0 - SETTLE_MS, ringBuffer: { getAll: () => [screen] }, ...over,
});
const deps = (over = {}) => ({
  now: T0, env: {}, log: () => {},
  send: vi.fn(() => true), ready: vi.fn(async () => true),
  switchTo: vi.fn(async () => ({ session: {} })), notify: vi.fn(async () => ({})), tell: vi.fn(async () => ({})),
  ...over,
});

describe('limitTick', () => {
  beforeEach(() => resetLimitWatch());

  it('nudges once per threshold at a warning', async () => {
    const s = billion(`${CLAUDE_WARN}\n> `);
    const d = deps();
    expect(await limitTick(s, d)).toBe('warned');
    expect(d.send).toHaveBeenCalledWith(s, "Your Claude Code usage is at 92%; bring STATE.md up to date and commit now, in case you're switched.", T0);
    expect(await limitTick(s, d)).toBeNull();
    s.ringBuffer = { getAll: () => ["You've used 93% of your weekly limit"] };
    expect(await limitTick(s, d)).toBeNull();                 // same threshold
    s.ringBuffer = { getAll: () => ["You've used 60% of your weekly limit"] };
    expect(await limitTick(s, d)).toBeNull();                 // under any threshold
    expect(d.send).toHaveBeenCalledTimes(1);
    const early = billion("You've used 76% of your weekly limit");
    await limitTick(early, d);
    early.ringBuffer = { getAll: () => ["You've used 91% of your weekly limit"] };
    expect(await limitTick(early, d)).toBe('warned');          // crossed 90 as well
    expect(d.switchTo).not.toHaveBeenCalled();
  });

  it('switches at the hard limit once Billion is quiet, and tells the owner', async () => {
    const d = deps();
    expect(await limitTick(billion(CLAUDE_OUT, { state: 'WORKING' }), d)).toBeNull();
    expect(await limitTick(billion(CLAUDE_OUT, { lastOutputAt: T0 - 1000 }), d)).toBeNull();
    expect(d.switchTo).not.toHaveBeenCalled();
    expect(await limitTick(billion(CLAUDE_OUT), d)).toBe('switched');
    expect(d.ready).toHaveBeenCalledWith('codex', expect.anything());
    expect(d.switchTo).toHaveBeenCalledWith('codex', 'Claude Code hit its limit');
    expect(d.tell).toHaveBeenCalledWith('Switched Billion to Codex: Claude Code hit its limit. HANDOVER.md written.');
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('never flaps: a limit on the new CLI soon after pauses and tells the owner once', async () => {
    const d = deps();
    await limitTick(billion(CLAUDE_OUT), d);
    const codex = billion("■ You've hit your usage limit. Try again at 4:05 PM.", { agent: 'codex' });
    const later = { ...d, now: T0 + SWITCH_GAP_MS - 1 };
    expect(await limitTick(codex, later)).toBe('paused');
    expect(await limitTick(codex, later)).toBeNull();
    expect(d.switchTo).toHaveBeenCalledTimes(1);
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toMatch(/^Billion paused: both Claude Code and Codex are at their limits/);
    // After the window it may switch again.
    expect(await limitTick(billion(codex.ringBuffer.getAll()[0], { agent: 'codex' }), { ...d, now: T0 + SWITCH_GAP_MS })).toBe('switched');
    expect(d.switchTo).toHaveBeenLastCalledWith('claude', 'Codex hit its limit');
  });

  it('pauses when the other CLI is missing or logged out, without switching', async () => {
    const d = deps({ ready: vi.fn(async () => false) });
    const s = billion(CLAUDE_OUT);
    expect(await limitTick(s, d)).toBe('paused');
    expect(await limitTick(s, d)).toBeNull();
    expect(d.switchTo).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toMatch(/Codex is not installed or not logged in/);
    // A new Billion (the owner pressed Start) is watched again.
    expect(await limitTick(billion(CLAUDE_OUT), d)).toBe('paused');
  });

  it('reads Billion only, and nothing with BILLION_AUTO_SWITCH=0', async () => {
    const d = deps();
    expect(await limitTick(billion(CLAUDE_OUT, { isBillion: false }), d)).toBeNull();
    expect(await limitTick(billion(CLAUDE_WARN, { isBillion: false }), d)).toBeNull();
    const off = { ...d, env: { BILLION_AUTO_SWITCH: '0' } };
    expect(await limitTick(billion(CLAUDE_OUT), off)).toBeNull();
    expect(await limitTick(billion(CLAUDE_WARN), off)).toBeNull();
    expect(d.send).not.toHaveBeenCalled();
    expect(d.switchTo).not.toHaveBeenCalled();
  });

  it('a limit scrolled above the bottom of the screen is old news', async () => {
    const d = deps();
    const screen = [CLAUDE_OUT, ...Array.from({ length: 20 }, (_, i) => `line ${i} of Billion's own work`)].join('\n');
    expect(await limitTick(billion(screen), d)).toBeNull();
  });
});

describe('saveBillionAgent', async () => {
  const { saveBillionAgent } = await import('../server/billion.js');
  const { mkdtempSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  it('keeps the reason for a switch the server made', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'limit-')), 'billion-agent.json');
    saveBillionAgent('codex', {}, file, 'Claude Code hit its limit');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ agent: 'codex', reason: 'Claude Code hit its limit', at: expect.any(String) });
    saveBillionAgent('claude', {}, file);
    expect(JSON.parse(readFileSync(file, 'utf8')).reason).toBeUndefined();
  });
});
