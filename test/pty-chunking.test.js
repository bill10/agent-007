// A pty read is not a line. These tests drive the real onData handler with a
// captured AskUserQuestion frame cut at chunk boundaries, because that is the
// only thing that differs between a dialog that detects and one that does not
// -- handing detectState a tidy pre-split line (helpers.test.js) passes either
// way, which is exactly why the split-line bug shipped.

import { describe, it, expect } from 'vitest';
import { setupPtyHandlers, trackSyncFrames } from '../server/pty.js';
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
  // Codex draws its bottom pane inside DEC 2026 synchronized-output frames,
  // with cursor moves rather than newlines. What follows is the shape of a
  // real capture (codex-cli 0.153): the /permissions picker, the answer, and
  // the prompt redrawn — where the picker's lines were the newest thing the
  // five-line window ever saw, and the bubble stayed on.
  const F = (body) => `\x1b[?2026h${body}\x1b[?2026l`;
  const PICKER = F('\x1b[19;1H\x1b[K Update Model Permissions\x1b[20;1H\x1b[K › 1. Ask for approval  Codex can read and edit files in the current workspace\x1b[21;1H\x1b[K   2. Approve for me    Only ask for actions detected as potentially unsafe.\x1b[22;1H\x1b[K   3. Full Access\x1b[23;1H\x1b[K Press enter to confirm');
  const PROMPT = F('\x1b[21;1H\x1b[K › Ask Codex to do anything\x1b[23;3H\x1b[K gpt-6-astra medium · ~/wt/Vid-GTM\x1b[0 q');
  const ANSWERED = '\x1b[0 q\x1bM\x1bM• Permissions updated to Full Access\n';

  it('shows the Codex picker while it is open, and drops it once it is answered', () => {
    const { session, write } = openSession();
    write('Everything remains on one sheet.\n');
    write(PICKER);
    session.lastOutputAt = 0;
    expect(detectState(session)).toBe('MESSAGE');
    // The user picks Full Access: Codex prints the outcome as a history line
    // and repaints the pane as the bare prompt.
    write(ANSWERED + PROMPT);
    session.lastOutputAt = 0;
    expect(session.lastFrame).toContain('Ask Codex to do anything');
    expect(detectState(session)).toBe('WAITING');
  });

  it('keeps the picker across a frame split at every read boundary', () => {
    for (let at = 1; at < PICKER.length; at += 7) {
      const { session, write } = openSession();
      write(PICKER.slice(0, at));
      write(PICKER.slice(at));
      session.lastOutputAt = 0;
      expect(detectState(session), `split at ${at}`).toBe('MESSAGE');
    }
  });

  it('ignores a frame that only blinks the cursor', () => {
    const { session, write } = openSession();
    write(PICKER);
    write(F('\x1b[0 q \x1b[23;3H'));   // what Codex sends while idle, over and over
    session.lastOutputAt = 0;
    expect(session.lastFrame).toContain('Update Model Permissions');
    expect(detectState(session)).toBe('MESSAGE');
  });

  it('bounds a frame that never closes, and caps the text it keeps', () => {
    const session = { frameOpen: null, lastFrame: '' };
    trackSyncFrames(session, '\x1b[?2026h' + 'x'.repeat(100 * 1024));
    expect(session.frameOpen.length).toBe(64 * 1024);
    trackSyncFrames(session, 'y'.repeat(10) + '\x1b[?2026l');
    expect(session.frameOpen).toBeNull();
    expect(session.lastFrame.length).toBe(2000);
  });

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
