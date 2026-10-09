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

// cliReady against stand-in CLIs: a definite no is false, a check that does not
// answer is null, so the logged-out notice (server.js) only follows a real no.
describe('cliReady', () => {
  it.skipIf(process.platform === 'win32')('tells logged in, logged out and no answer apart', async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { cliReady } = await import('../server/billion-limit.js');
    const stub = (name, body) => {
      const bin = mkdtempSync(join(tmpdir(), 'a007-cliready-'));
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
      return { PATH: `${bin}:/usr/bin:/bin` };
    };
    expect(await cliReady('claude', { env: stub('claude', `echo '{"loggedIn":true}'`) })).toBe(true);
    expect(await cliReady('claude', { env: stub('claude', `echo '{"loggedIn":false}'; exit 1`) })).toBe(false);
    expect(await cliReady('claude', { env: stub('claude', 'echo not json') })).toBeNull();
    expect(await cliReady('claude', { env: stub('claude', 'exit 3') })).toBeNull();
    expect(await cliReady('codex', { env: stub('codex', 'exit 0') })).toBe(true);
    expect(await cliReady('codex', { env: stub('codex', 'exit 1') })).toBe(false);
    expect(await cliReady('claude', { env: { PATH: '/nonexistent' } })).toBe(false);
  });
});

describe('persistent account rotation before CLI fallback', () => {
  beforeEach(() => resetLimitWatch());
  const rotation = over => ({ run: vi.fn(async () => ({ ok: true })), prepare: vi.fn(async () => ({ ok: true })), fallback: () => true, ...over });
  it('keeps Codex running when CLI auto-switch is off even with account rotation enabled', async () => {
    const r = rotation(), d = deps({ rotation: r, env: { BILLION_AUTO_SWITCH: '0' } });
    const s = billion("You've hit your usage limit", { agent: 'codex' });
    expect(await limitTick(s, d)).toBeNull();
    expect(r.prepare).not.toHaveBeenCalled();
    expect(r.run).not.toHaveBeenCalled();
    expect(d.switchTo).not.toHaveBeenCalled();
    expect(d.tell).not.toHaveBeenCalled();
  });
  it('rotates Claude accounts without a handover or the CLI switch cooldown', async () => {
    const r = rotation(), d = deps({ rotation: r });
    resetLimitWatch({ switchAt: T0 - 100 });
    expect(await limitTick(billion(CLAUDE_OUT), d)).toBe('rotated');
    expect(r.run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hard' }), { limited: true });
    expect(d.switchTo).not.toHaveBeenCalled();
    expect(await limitTick(billion(CLAUDE_OUT), d)).toBe('rotated');
  });
  it('hands over to Codex only after the Claude pool is exhausted', async () => {
    const r = rotation({ run: vi.fn(async () => ({ exhausted: true, retryAt: T0 + 60_000 })) });
    const d = deps({ rotation: r });
    expect(await limitTick(billion(CLAUDE_OUT), d)).toBe('switched');
    expect(d.switchTo).toHaveBeenCalledWith('codex', expect.any(String));
  });
  it('waits for the reset with fallback off, then retries without extending the old limit', async () => {
    const r = rotation({ run: vi.fn().mockResolvedValueOnce({ exhausted: true, retryAt: T0 + 60_000 }).mockResolvedValue({ ok: true }), fallback: () => false });
    const d = deps({ rotation: r }), s = billion(CLAUDE_OUT);
    expect(await limitTick(s, d)).toBe('paused');
    expect(await limitTick(s, { ...d, now: T0 + 1000 })).toBeNull();
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(await limitTick(s, { ...d, now: T0 + 60_001 })).toBe('rotated');
    expect(r.run).toHaveBeenLastCalledWith(expect.anything(), { limited: false });
    expect(d.switchTo).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledTimes(1);
  });
  it('does not change CLI after a failed rollback and does not spin while another action is busy', async () => {
    const r = rotation({ run: vi.fn().mockResolvedValueOnce({ busy: true }).mockResolvedValue({ error: 'Restore the previous login', blocked: true }) });
    const d = deps({ rotation: r }), s = billion(CLAUDE_OUT);
    expect(await limitTick(s, d)).toBeNull();
    expect(s.rotationMarked).toBeUndefined();
    expect(await limitTick(s, d)).toBe('paused');
    expect(d.switchTo).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('Restore the previous login'));
  });
  it('selects an available Claude login before the Codex-to-Claude handover', async () => {
    const order = [], r = rotation({ prepare: vi.fn(async () => { order.push('account'); return { ok: true }; }) });
    const d = deps({ rotation: r, switchTo: vi.fn(async () => { order.push('handover'); return { session: {} }; }) });
    expect(await limitTick(billion("You've hit your usage limit", { agent: 'codex' }), d)).toBe('switched');
    expect(order).toEqual(['account', 'handover']);
  });
  it('retries an exhausted Claude pool later while Codex waits, without repeated notifications', async () => {
    const r = rotation({ prepare: vi.fn().mockResolvedValueOnce({ exhausted: true, retryAt: T0 + 1000 }).mockResolvedValue({ ok: true }) });
    const d = deps({ rotation: r }), s = billion("You've hit your usage limit", { agent: 'codex' });
    expect(await limitTick(s, d)).toBe('paused');
    expect(await limitTick(s, { ...d, now: T0 + 500 })).toBeNull();
    expect(await limitTick(s, { ...d, now: T0 + 1001 })).toBe('switched');
    expect(d.notify).toHaveBeenCalledTimes(1);
  });
});

describe('Codex account rotation before the handover to Claude Code', () => {
  beforeEach(() => resetLimitWatch());
  const CODEX_OUT = "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 25th, 2026 3:15 PM.";
  const pool = over => ({ run: vi.fn(async () => ({ ok: true })), prepare: vi.fn(async () => ({ ok: true })), fallback: () => true, ...over });
  // Value: protects=a handover that fails with a pool on waits the switch gap instead of retrying every tick;
  //   fails_when=the failed switchTo leaves only pausedFor, which an enabled pool lets through;
  //   why_new=no case fails the handover itself with a pool on; seam=none
  it('waits the switch gap after a failed handover with a pool on', async () => {
    const c = pool({ run: vi.fn(async () => ({ exhausted: true, retryAt: T0 + 60_000 })) });
    const d = deps({ codexRotation: c, switchTo: vi.fn(async () => ({ error: 'handover could not be written' })) }), s = billion(CODEX_OUT, { agent: 'codex' });
    expect(await limitTick(s, d)).toBeNull();
    expect(await limitTick(s, { ...d, now: T0 + 10_000 })).toBeNull();
    expect(d.switchTo).toHaveBeenCalledTimes(1);
    expect(c.run).toHaveBeenCalledTimes(1);
    expect(s.rotationRetryAt).toBe(T0 + SWITCH_GAP_MS);
  });
  // Value: protects=a pool exhausted with the other CLI unavailable pauses, retries after the gap, and tells the owner once;
  //   fails_when=the pause keeps a past retry time and re-notifies (Telegram) every tick;
  //   why_new=no case pauses on `why` with a pool on and then ticks past the gap; seam=none
  it('pauses once when the other CLI is unavailable, then retries only after the gap without telling the owner again', async () => {
    const c = pool({ run: vi.fn(async () => ({ exhausted: true, retryAt: T0 + 60_000 })) });
    const d = deps({ codexRotation: c, ready: vi.fn(async () => false) }), s = billion(CODEX_OUT, { agent: 'codex' });
    expect(await limitTick(s, d)).toBe('paused');
    expect(await limitTick(s, { ...d, now: T0 + 10_000 })).toBeNull();
    expect(await limitTick(s, { ...d, now: T0 + SWITCH_GAP_MS + 1 })).toBe('paused');
    expect(await limitTick(s, { ...d, now: T0 + SWITCH_GAP_MS + 10_001 })).toBeNull();
    expect(s.rotationRetryAt).toBe(T0 + 2 * SWITCH_GAP_MS + 1);
    expect(d.notify).toHaveBeenCalledTimes(1);
  });
  it('retries next tick when the handover only met another switch in flight', async () => {
    const c = pool({ run: vi.fn(async () => ({ exhausted: true, retryAt: T0 + 60_000 })) });
    const d = deps({ codexRotation: c, switchTo: vi.fn(async () => ({ error: 'Billion is already switching', busy: true })) }), s = billion(CODEX_OUT, { agent: 'codex' });
    expect(await limitTick(s, d)).toBeNull();
    expect(s.rotationRetryAt).toBeUndefined();
  });
  // Value: protects=with both pools on, an exhausted pool with fallback still hands over, picking the other CLI's login first;
  //   fails_when=the exhausted pool's reset wait is set before the handover and its login check returns early;
  //   why_new=every other case enables one pool only; seam=none
  it('hands over with both pools on once its own pool is exhausted, and does not wait for that pool\'s reset', async () => {
    const order = [];
    const claude = pool({ prepare: vi.fn(async () => { order.push('claude login'); return { ok: true }; }) });
    const c = pool({ run: vi.fn(async () => ({ exhausted: true, retryAt: T0 + 3 * 86_400_000 })) });
    const d = deps({ rotation: claude, codexRotation: c, switchTo: vi.fn(async () => { order.push('handover'); return { session: {} }; }) });
    expect(await limitTick(billion(CODEX_OUT, { agent: 'codex' }), d)).toBe('switched');
    expect(order).toEqual(['claude login', 'handover']);
  });
  it('rotates Codex logins with CLI auto-switch off, and passes the wrapped notice for its reset time', async () => {
    const c = pool(), d = deps({ codexRotation: c, env: { BILLION_AUTO_SWITCH: '0' } });
    const wrapped = CODEX_OUT.replace('or try again', 'or\ntry again');
    expect(await limitTick(billion(wrapped, { agent: 'codex' }), d)).toBe('rotated');
    expect(c.run.mock.calls[0][0].retry).toContain('try again at Oct 25th, 2026 3:15 PM');
    // Later screen text after a blank line is not part of the notice.
    expect(matchLimit(`${CODEX_OUT}\n\nresets in 2h`).retry).not.toContain('resets in 2h');
    expect(d.switchTo).not.toHaveBeenCalled();
  });
  it('hands over to Claude Code only once every Codex login is unavailable', async () => {
    const c = pool({ run: vi.fn(async () => ({ exhausted: true, retryAt: T0 + 60_000 })) });
    const d = deps({ codexRotation: c });
    expect(await limitTick(billion(CODEX_OUT, { agent: 'codex' }), d)).toBe('switched');
    expect(d.switchTo).toHaveBeenCalledWith('claude', expect.any(String));
  });
  it('waits for a Codex reset with fallback off, telling the owner once', async () => {
    const c = pool({ run: vi.fn(async () => ({ exhausted: true, retryAt: T0 + 60_000 })), fallback: () => false });
    const d = deps({ codexRotation: c }), s = billion(CODEX_OUT, { agent: 'codex' });
    expect(await limitTick(s, d)).toBe('paused');
    expect(await limitTick(s, { ...d, now: T0 + 1000 })).toBeNull();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('Codex accounts are unavailable'));
    expect(d.switchTo).not.toHaveBeenCalled();
  });
  it('picks an eligible Codex login before a Claude-to-Codex handover', async () => {
    const order = [], c = pool({ prepare: vi.fn(async () => { order.push('codex login'); return { ok: true }; }) });
    const d = deps({ codexRotation: c, switchTo: vi.fn(async () => { order.push('handover'); return { session: {} }; }) });
    expect(await limitTick(billion(CLAUDE_OUT), d)).toBe('switched');
    expect(order).toEqual(['codex login', 'handover']);
  });
});

describe('a Codex Billion paused with only the Claude pool enabled', () => {
  beforeEach(() => resetLimitWatch());
  // Value: protects=a Codex Billion paused at both limits retries the handover to Claude once the switch gap passes, while only the Claude account pool is on;
  //   fails_when=the pause/retry guards key on the Codex pool alone, so the Claude pool no longer re-arms the paused handover;
  //   why_new=existing Codex-side tests cover the prepare-failure path only, not the paused-by-switch-gap path; seam=none
  it('hands over to Claude after the switch gap instead of staying paused', async () => {
    const r = { run: vi.fn(), prepare: vi.fn(async () => ({ ok: true })), fallback: () => true };
    const d = deps({ rotation: r }), s = billion("You've hit your usage limit", { agent: 'codex' });
    resetLimitWatch({ switchAt: T0 - 100 });
    expect(await limitTick(s, d)).toBe('paused');
    expect(await limitTick(s, { ...d, now: T0 + SWITCH_GAP_MS + 1 })).toBe('switched');
    expect(d.switchTo).toHaveBeenCalledWith('claude', expect.any(String));
    expect(r.run).not.toHaveBeenCalled();
  });
});
