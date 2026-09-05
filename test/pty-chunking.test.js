// A pty read is not a line. These tests drive the real onData handler with a
// captured AskUserQuestion frame cut at chunk boundaries, because that is the
// only thing that differs between a dialog that detects and one that does not
// -- handing detectState a tidy pre-split line (helpers.test.js) passes either
// way, which is exactly why the split-line bug shipped.

import { describe, it, expect } from 'vitest';
import { setupPtyHandlers } from '../server/pty.js';
import { detectState } from '../lib/helpers.js';
import { ASK_QUESTION_FRAME, FOOTER_AT } from './fixtures/ask-user-question-frame.js';

// Split out from feed() so a test can drive chunks one at a time and inspect
// the session between them, which is what the lastOutputAt case below needs.
function openSession() {
  let onData;
  const session = {
    id: 's1',
    pty: { onData: (cb) => { onData = cb; }, onExit: () => {} },
    ringBuffer: { push: () => {} },
    state: 'WORKING',
    lastOutputAt: Date.now(),
    lastResizeAt: 0,
    lastStrippedLine: '',
    recentStrippedLines: [],
    pendingRaw: '',
    isTUI: true,
    exited: false,
  };
  setupPtyHandlers(session, 's1', () => {});
  clearInterval(session.stateCheckInterval);
  return { session, write: (chunk) => onData(chunk) };
}

function feed(chunks) {
  const { session, write } = openSession();
  for (const chunk of chunks) write(chunk);
  // The dialog is parked: nothing more arrives, so the WORKING window lapses.
  session.lastOutputAt = 0;
  return session;
}

const cutAt = (s, at) => [s.slice(0, at), s.slice(at)];

describe('PTY line reassembly across chunk boundaries', () => {
  it('detects the question dialog when the footer is cut in half', () => {
    expect(detectState(feed(cutAt(ASK_QUESTION_FRAME, FOOTER_AT + 20)))).toBe('MESSAGE');
  });

  it('detects it at every other split offset too', () => {
    // Half-done carry-over (say, dropping the tail rather than prepending it)
    // still passes the one cut above; it does not survive all of these.
    for (let at = 1; at < ASK_QUESTION_FRAME.length; at += 7) {
      expect(detectState(feed(cutAt(ASK_QUESTION_FRAME, at))), `split at ${at}`).toBe('MESSAGE');
    }
  });

  it('detects it when the footer is the last row and gets no trailing newline', () => {
    const noNewline = ASK_QUESTION_FRAME.slice(0, ASK_QUESTION_FRAME.lastIndexOf('\r\r\n'));
    expect(detectState(feed(cutAt(noNewline, FOOTER_AT + 20)))).toBe('MESSAGE');
  });

  it('bounds the carried-over tail when a line never gets a newline', () => {
    // An agent controls this text, so an unterminated row must not grow the
    // carry forever. Trimming from the left keeps the join with the next
    // chunk intact: the footer that follows still detects.
    const session = feed(['x'.repeat(3000), 'x\r\nEnter to select · Esc to cancel']);
    expect(session.pendingRaw.length).toBeLessThanOrEqual(2000);
    expect(detectState(session)).toBe('MESSAGE');
  });

  it('does not count carried-over text as new output', () => {
    // hasContent was read off the accumulated carry, so once an unterminated
    // line sat in it, ANY later chunk -- a bare cursor move, a bell --
    // re-counted that same text as fresh output and bumped lastOutputAt.
    // detectState returns WORKING while that window is open, so a TUI emitting
    // periodic control sequences masks the dialog indefinitely: exactly the
    // failure this file exists to stop, reached through another door.
    const { session, write } = openSession();
    write('Enter to select \u00b7 Esc to cancel');   // footer, no trailing newline
    session.lastOutputAt = 0;                         // let the WORKING window lapse
    expect(detectState(session)).toBe('MESSAGE');

    write('\u001b[18A');                             // pure cursor move: nothing visible
    expect(session.lastOutputAt).toBe(0);
    expect(detectState(session)).toBe('MESSAGE');
  });

  it('does not park an unterminated fragment in the five-line window', () => {
    // Otherwise a frame whose last row never gets a newline latches a fragment
    // into the window, and every later state check keeps matching against it.
    const session = feed(['done.\r\n', 'Allow claude to read x']);
    expect(session.recentStrippedLines).toEqual(['done.']);
    // Still scanned, though -- via lastStrippedLine, which is overwritten.
    expect(detectState(session)).toBe('MESSAGE');
  });
});
