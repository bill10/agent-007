// A pty read is not a line. These tests drive the real onData handler with a
// captured AskUserQuestion frame cut at chunk boundaries, because that is the
// only thing that differs between a dialog that detects and one that does not
// -- handing detectState a tidy pre-split line (helpers.test.js) passes either
// way, which is exactly why the split-line bug shipped.

import { describe, it, expect, vi } from 'vitest';
import { setupPtyHandlers, trackSyncFrames } from '../server/pty.js';
import { detectState } from '../lib/helpers.js';
import { ASK_QUESTION_FRAME, FOOTER_AT } from './fixtures/ask-user-question-frame.js';
import { BASH_DIALOG, EDIT_DIALOG } from './fixtures/claude-permission-dialogs.js';

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
    for (let at = 1; at < PICKER.length; at++) {
      const { session, write } = openSession();
      write(PICKER.slice(0, at));
      write(PICKER.slice(at));
      session.lastOutputAt = 0;
      expect(session.lastFrame, `split at ${at}`).toContain('Update Model Permissions');
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

  it('bounds a frame that never closes, and keeps the head and the tail of one too long to keep whole', () => {
    const session = { frameOpen: null, lastFrame: '' };
    trackSyncFrames(session, '\x1b[?2026h' + 'x'.repeat(100 * 1024));
    expect(session.frameOpen.length).toBe(64 * 1024);
    trackSyncFrames(session, 'y'.repeat(10) + '\x1b[?2026l');
    expect(session.frameOpen).toBeNull();
    // 2000 of head, a joiner, 2000 of tail: a dialog's question sits first and
    // its answers last, and the agent controls how long the middle runs.
    expect(session.lastFrame.length).toBe(2 * 2000 + 3);
    expect(session.lastFrame.startsWith('x'.repeat(2000))).toBe(true);
    // The cap keeps a marker's worth of bytes past it, so an end marker that
    // straddles the read after an oversized body still closes the frame.
    const big = { frameOpen: null, lastFrame: '' };
    trackSyncFrames(big, '\x1b[?2026h' + 'z'.repeat(70 * 1024) + '\x1b[?20');
    trackSyncFrames(big, '26l');
    expect(big.frameOpen).toBeNull();
    expect(big.lastFrame.startsWith('zzz')).toBe(true);
  });

  it('forgets a cancelled picker: the prompt repaint that follows carries no newline, and the carry restarts after a frame', () => {
    // Esc closes the picker without a history line, so nothing ever cuts the
    // raw carry — and the last line, checked before the frame, is the head of
    // that carry. The picker must not be it.
    const { session, write } = openSession();
    write(PICKER);
    session.lastOutputAt = 0;
    expect(detectState(session)).toBe('MESSAGE');
    write(PROMPT);
    for (let i = 0; i < 5; i++) write(F('\x1b[0 q \x1b[23;3H'));   // idle blinks
    session.lastOutputAt = 0;
    expect(session.lastStrippedLine).not.toContain('Update Model Permissions');
    expect(session.lastFrame).toContain('Ask Codex to do anything');
    expect(detectState(session)).toBe('WAITING');
  });

  it('takes the last of two frames drawn in one read', () => {
    const { session, write } = openSession();
    write(PICKER + PROMPT);
    expect(session.lastFrame).toContain('Ask Codex to do anything');
    expect(session.lastFrame).not.toContain('Update Model Permissions');
    expect(session.frameOpen).toBeNull();
    // And the other way round: the picker drawn after the prompt is what stands.
    write(PROMPT + PICKER);
    session.lastOutputAt = 0;
    expect(session.lastFrame).toContain('Update Model Permissions');
    expect(detectState(session)).toBe('MESSAGE');
  });

  it('carries a frame across a read that holds neither marker', () => {
    const { session, write } = openSession();
    const [head, rest] = cutAt(PICKER, 40);
    const [middle, tail] = cutAt(rest, 60);
    write(head);
    write(middle);
    expect(typeof session.frameOpen).toBe('string');
    expect(session.lastFrame).toBeUndefined();   // nothing complete yet
    write(tail);
    session.lastOutputAt = 0;
    expect(session.frameOpen).toBeNull();
    expect(session.lastFrame).toContain('Update Model Permissions');
    expect(session.lastFrame).toContain('Press enter to confirm');
    expect(detectState(session)).toBe('MESSAGE');
  });

  it('leaves the last frame alone when a read draws no frame', () => {
    const { session, write } = openSession();
    // Before any frame: the field is never touched, so the window still rules.
    write('Enter to select · Esc to cancel\n');
    expect(session.lastFrame).toBeUndefined();
    session.lastOutputAt = 0;
    expect(detectState(session)).toBe('MESSAGE');
    // After one: a plain history line neither opens nor replaces it.
    write(PROMPT);
    write('• Ran git status -sb\n');
    expect(session.frameOpen).toBeNull();
    expect(session.lastFrame).toContain('Ask Codex to do anything');
    session.lastOutputAt = 0;
    expect(detectState(session)).toBe('WAITING');
  });

  it('shows a Codex command approval while it is open, and drops it once answered', () => {
    const APPROVAL = F('\x1b[18;1H\x1b[K Would you like to run the following command?\x1b[19;1H\x1b[K   $ git push origin main\x1b[21;1H\x1b[K › 1. Yes, proceed\x1b[22;1H\x1b[K   2. Yes, and don\'t ask again for commands that start with `git push`\x1b[23;1H\x1b[K   3. No, and tell Codex what to do differently');
    const { session, write } = openSession();
    write('• Explored the repo and drafted the change.\n');
    write(APPROVAL);
    session.lastOutputAt = 0;
    expect(session.lastFrame).toContain('Would you like to run the following command?');
    expect(detectState(session)).toBe('MESSAGE');
    // The user approves: the command's outcome becomes a history line and the
    // pane is repainted as the bare prompt.
    write('\x1b[0 q\x1bM• Ran git push origin main\n' + PROMPT);
    session.lastOutputAt = 0;
    expect(detectState(session)).toBe('WAITING');
  });

  it('finds a begin marker cut by a read boundary, so the answered prompt is not missed', () => {
    // Codex idles by blinking the cursor in frames that say nothing, so a
    // prompt repaint lost to a split marker would leave the picker standing,
    // and the bubble lit, until the user typed something.
    for (let at = 1; at < 8; at++) {   // every cut inside "\x1b[?2026h"
      const { session, write } = openSession();
      write(PICKER);
      const [head, tail] = cutAt(PROMPT, at);
      write(ANSWERED + head);
      write(tail);
      write(F('\x1b[0 q \x1b[23;3H'));
      session.lastOutputAt = 0;
      expect(session.frameOpen, `cut at ${at}`).toBeNull();
      expect(session.lastFrame, `cut at ${at}`).toContain('Ask Codex to do anything');
      expect(detectState(session), `cut at ${at}`).toBe('WAITING');
    }
  });

  it('finds an end marker cut by a read boundary, so the picker is not glued onto the prompt', () => {
    for (let at = 1; at < 8; at++) {   // every cut inside "\x1b[?2026l"
      const { session, write } = openSession();
      const [head, tail] = cutAt(PICKER, PICKER.length - at);
      write(head);
      write(tail + ANSWERED + PROMPT);
      write(F('\x1b[0 q \x1b[23;3H'));
      session.lastOutputAt = 0;
      expect(session.lastFrame, `cut at ${at}`).not.toContain('Update Model Permissions');
      expect(detectState(session), `cut at ${at}`).toBe('WAITING');
    }
  });

  it('restarts a frame when a new begin marker arrives before the end', () => {
    // A frame that never closed is not the pane; the repaint that follows is.
    const { session, write } = openSession();
    write('\x1b[?2026h\x1b[19;1H Update Model Permissions › 1. Ask for approval');
    expect(typeof session.frameOpen).toBe('string');
    write(ANSWERED + PROMPT);
    session.lastOutputAt = 0;
    expect(session.frameOpen).toBeNull();
    expect(session.lastFrame).not.toContain('Update Model Permissions');
    expect(session.lastFrame).toContain('Ask Codex to do anything');
    expect(detectState(session)).toBe('WAITING');
    // In one read as well.
    write('\x1b[?2026h\x1b[19;1H Update Model Permissions' + PROMPT + '\x1b[?2026h stray');
    expect(session.lastFrame).not.toContain('Update Model Permissions');
    expect(session.frameOpen).toContain('stray');
  });

  it('keeps the head and the tail of a frame too long to keep whole', () => {
    // A dialog states its question first and lists its answers last; what runs
    // between them is the agent's to make as long as it likes.
    const { session, write } = openSession();
    write(F('Would you like to run the following command?' + ' x'.repeat(3000) + ' › 1. Yes, proceed'));
    session.lastOutputAt = 0;
    expect(session.lastFrame.length).toBeLessThanOrEqual(2 * 2000 + 3);
    expect(session.lastFrame.startsWith('Would you like to run the following command?')).toBe(true);
    expect(session.lastFrame.endsWith('› 1. Yes, proceed')).toBe(true);
    expect(detectState(session)).toBe('MESSAGE');
    // Under the limit, it is kept whole.
    write(F('Would you like to run the following command?' + ' x'.repeat(100) + ' › 1. Yes, proceed'));
    expect(session.lastFrame).not.toContain(' … ');
  });

  it('ignores a read that is not a string, and a frame that says nothing', () => {
    const session = { frameOpen: null, frameTail: '', lastFrame: '' };
    trackSyncFrames(session, Buffer.from('\x1b[?2026h Update Model Permissions \x1b[?2026l'));
    trackSyncFrames(session, '');
    trackSyncFrames(session, undefined);
    expect(session).toEqual({ frameOpen: null, frameTail: '', lastFrame: '' });
    // Cursor-shape remnants, whitespace, box-drawing rules and half-stripped
    // escapes are not a repaint of the pane.
    trackSyncFrames(session, F(' Update Model Permissions '), 1000);
    for (const nothing of ['\x1b[0 q \x1b[23;3H', '   ', '────────────', '\x1b[K', '12;3H', '⠋ ⠙ ⠹']) {
      trackSyncFrames(session, F(nothing), 2000);
      expect(session.lastFrame, JSON.stringify(nothing)).toBe('Update Model Permissions');
      expect(session.lastFrameAt, JSON.stringify(nothing)).toBe(1000);
    }
  });

  it('reads the window again once a program stops painting in frames', () => {
    // A shell tab: Codex ran and drew frames, then exited, then Claude Code
    // (which draws none) asked a question in plain lines. Time is the judge.
    const clock = vi.spyOn(Date, 'now');
    try {
      const { session, write } = openSession();
      clock.mockReturnValue(10_000);
      write(PROMPT);
      expect(session.lastFrameAt).toBe(10_000);
      clock.mockReturnValue(20_000);
      write('Enter to select · Esc to cancel\r\n');
      expect(detectState(session, { now: 60_000 })).toBe('MESSAGE');
      // And the other way: a stale picker frame does not outrank newer plain
      // output. (Codex exits; the shell's lines and the next program's banner
      // then push the pane's text out of the window, as any lines would.)
      clock.mockReturnValue(30_000);
      write(PICKER);
      clock.mockReturnValue(40_000);
      write('\r\n$ claude\r\n Welcome back!\r\n cwd: ~/wt\r\n Tips for getting started\r\n Run /init\r\n Use /help\r\n$ ');
      expect(session.lastFrameAt).toBe(30_000);
      expect(session.lastOutputAt).toBe(40_000);
      expect(detectState(session, { now: 60_000 })).toBe('WAITING');
    } finally {
      clock.mockRestore();
    }
  });

  // Claude Code 2.1.273's permission dialogs, replayed read for read. Its
  // answers changed ("Yes, and always allow access to …", "Yes, and switch
  // to auto mode", a "Tab to amend" footer), and the question is pushed out
  // of the five-line window by them; the one thing that used to catch it was
  // the bare "allow" this change removed.
  it('detects the Claude Code 2.1 Bash permission dialog, as captured', () => {
    const { session, write } = openSession();
    for (const chunk of BASH_DIALOG) write(chunk);
    session.lastOutputAt = 0;
    expect(session.lastFrame ?? '').toBe('');   // Claude draws no frames
    expect(detectState(session)).toBe('MESSAGE');
  });

  it('detects the Claude Code 2.1 edit permission dialog, as captured', () => {
    const { session, write } = openSession();
    for (const chunk of [...BASH_DIALOG, ...EDIT_DIALOG]) write(chunk);
    session.lastOutputAt = 0;
    expect(detectState(session)).toBe('MESSAGE');
  });

  it('keeps the picker through a resize, when Codex repaints the pane and then re-inserts history', () => {
    const { session, write } = openSession();
    write(PICKER);
    session.lastResizeAt = Date.now();
    write(F('\x1b[2J' + PICKER.slice(8, -8)));                       // the pane again, full repaint
    write(F('╭──╮ │ ✨ Update available! │ ╰──╯'));                     // then the history boxes, frame by frame
    write(F('Tip: Try the Desktop app.'));
    session.lastOutputAt = 0;
    expect(session.lastFrame).toContain('Update Model Permissions');
    expect(detectState(session)).toBe('MESSAGE');
    // Past the window a frame is the pane again.
    session.lastResizeAt = 0;
    write(PROMPT);
    session.lastOutputAt = 0;
    expect(session.lastFrame).not.toContain('Update Model Permissions');
    expect(detectState(session)).toBe('WAITING');
  });

  it('does not read frames for a session whose CLI is not Codex', () => {
    const { session, write } = openSession();
    session.framesTrusted = false;
    write(PICKER);
    expect(session.lastFrame ?? '').toBe('');
    // The bytes still reach the line stream, as they always did.
    expect(session.lastStrippedLine).toContain('Update Model Permissions');
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
