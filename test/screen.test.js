// Regression test for "agent stuck in WAITING while a question dialog is on
// screen".
//
// The fixture is REAL captured PTY output: `claude` spawned under node-pty,
// asked to call AskUserQuestion, then three ↓ presses, with every onData chunk
// recorded in order and `mark` entries noting where each keypress landed.
// Synthetic one-liners are what let this ship — feeding detectState a single
// tidy footer string passes with or without the bug, because the bug is that
// the footer stops being in the window at all.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { detectState, stripAnsiComplete } from '../lib/helpers.js';
import { createScreen, syncScreenLines } from '../server/screen.js';

const CAPTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/askuserquestion-pty.json', import.meta.url)), 'utf8'));

// xterm parses writes off a queue, so flush before reading the screen back.
// An SGR reset paints nothing; xterm skips the callback on an empty write.
const flush = (screen) => new Promise(resolve => screen.write('\x1b[0m', resolve));

/**
 * Replay the fixture through the same steps server/pty.js takes: write every
 * chunk into the session's screen, and sync the detection window on the 1s
 * state-check tick (here: at each mark, and at the end).
 */
async function replay(upToMark) {
  const session = {
    exited: false, isTUI: true, lastOutputAt: 0,
    lastStrippedLine: '', recentStrippedLines: [],
    screen: createScreen(120, 30),
  };
  const states = {};
  for (const chunk of CAPTURE) {
    if (chunk.mark) {
      await flush(session.screen);
      syncScreenLines(session);
      // lastOutputAt stays at 0 so we are always past the WORKING window —
      // this asks "what does an idle session look like right now".
      states[chunk.mark] = detectState(session, { now: 1e9 });
      if (chunk.mark === upToMark) break;
      continue;
    }
    session.screen.write(chunk.d);
  }
  await flush(session.screen);
  syncScreenLines(session);
  return { session, states, final: detectState(session, { now: 1e9 }) };
}

describe('state detection reads the current screen', () => {
  it('stays MESSAGE while the question dialog is redrawn by arrow keys', async () => {
    const { states, final } = await replay();
    expect(states['dialog-drawn']).toBe('MESSAGE');
    // Each ↓ repaints only the two changed option rows. Under the old 5-line
    // rolling window over writes, three of those evicted the footer and the
    // state latched at WAITING — which reads as "resting" and walks the agent
    // off to a conference seat with the question still unanswered.
    expect(states['arrow-down-0']).toBe('MESSAGE');
    expect(states['arrow-down-1']).toBe('MESSAGE');
    expect(states['arrow-down-2']).toBe('MESSAGE');
    expect(states['after-arrows']).toBe('MESSAGE');
    expect(final).toBe('MESSAGE');
  });

  it('the old rolling-window scheme fails the same replay', async () => {
    // Guards the test itself: if this ever passes, the replay stopped
    // exercising the bug and the test above proves nothing.
    const cap = l => l.trim().slice(0, 400);
    let last = '', recent = [];
    for (const chunk of CAPTURE) {
      if (chunk.mark) continue;
      const lines = stripAnsiComplete(chunk.d).split('\n').filter(l => l.trim().length > 0);
      if (lines.length === 0) continue;
      last = cap(lines[lines.length - 1]);
      recent = [...recent, ...lines.map(cap)].slice(-5);
    }
    const stale = { exited: false, isTUI: true, lastOutputAt: 0, lastStrippedLine: last, recentStrippedLines: recent };
    expect(detectState(stale, { now: 1e9 })).toBe('WAITING');
  });

  it('serves detectState properly spaced lines from the bottom of the screen', async () => {
    const { session } = await replay();
    expect(session.lastStrippedLine).toMatch(/^Enter to select · .* · Esc to cancel$/);
    expect(session.recentStrippedLines.length).toBeLessThanOrEqual(10);
    expect(session.recentStrippedLines).toContain('2. Green');
  });
});

describe('syncScreenLines', () => {
  it('leaves a screenless session alone', () => {
    // Belt and braces for a session object built before the screen exists
    // (test fakes, and the orphan re-adopt path).
    const session = { recentStrippedLines: ['keep me'], lastStrippedLine: 'keep me' };
    syncScreenLines(session);
    expect(session.recentStrippedLines).toEqual(['keep me']);
    expect(session.lastStrippedLine).toBe('keep me');
  });
});

describe('createScreen', () => {
  it('reports the bottom-most non-empty rows in order', async () => {
    const screen = createScreen(20, 5);
    screen.write('one\r\ntwo\r\nthree\r\n');
    await flush(screen);
    expect(screen.lines()).toEqual(['one', 'two', 'three']);
    expect(screen.lines(2)).toEqual(['two', 'three']);
    screen.dispose();
  });

  it('drops scrolled-off rows instead of accumulating them', async () => {
    const screen = createScreen(20, 3);
    screen.write('a\r\nb\r\nc\r\nd\r\ne\r\n');
    await flush(screen);
    expect(screen.lines()).toEqual(['d', 'e']);
    screen.dispose();
  });

  it('follows a client resize, so lines stay bounded by the new width', async () => {
    const screen = createScreen(20, 3);
    screen.resize(10, 6);
    screen.write('x'.repeat(25) + '\r\n');
    await flush(screen);
    // 25 chars at width 10 wrap onto three rows, all of which are on screen.
    expect(screen.lines()).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
    screen.dispose();
  });

  it('caps a line so a wide client cannot feed the patterns a huge string', async () => {
    // Several MESSAGE patterns are quadratic on a long line, and `cols` comes
    // from the client — see the note in server/screen.js.
    const screen = createScreen(4000, 3);
    screen.write('allow ' + 'a'.repeat(3000) + '\r\n');
    await flush(screen);
    expect(screen.lines()[0]).toHaveLength(400);
    screen.dispose();
  });

  it('ignores nonsense dimensions rather than throwing', async () => {
    const screen = createScreen(20, 3);
    expect(() => screen.resize(0, 0)).not.toThrow();
    expect(() => screen.resize(NaN, 10)).not.toThrow();
    // Unlike a PTY winsize, xterm allocates per cell — a client asking for a
    // million columns must not turn into a million columns of memory.
    expect(() => screen.resize(1_000_000, 1_000_000)).not.toThrow();
    screen.write('hi\r\n');
    await flush(screen);
    expect(screen.lines()).toEqual(['hi']);
    screen.dispose();
  });
});
