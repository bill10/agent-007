// A headless terminal per session, so state detection can read what is
// CURRENTLY ON SCREEN rather than the last few things written to the PTY.
//
// The old scheme kept a 5-line rolling window over incremental writes. A TUI
// dialog is painted once and then only partially redrawn — three arrow-key
// presses in an AskUserQuestion prompt emit three chunks that contain only the
// two changed option rows, and those evict the "Enter to select … Esc to
// cancel" footer from the window. Nothing ever repaints the footer, so the
// session fell through to WAITING and stayed there while the dialog was still
// on screen, which sent the agent wandering off to a conference seat
// mid-question. (Also triggered by a stray BEL, a spinner tick, or a resize.)
//
// Feeding the same bytes the browser's xterm gets into @xterm/headless — its
// server-side sibling — makes the window a real screen model instead: the
// footer stays until the dialog is actually dismissed, and the text arrives
// properly spaced and bounded by the terminal width.

// CommonJS package: the named import works under Vite's interop but throws
// "does not provide an export named 'Terminal'" in plain Node ESM, which is
// how the server actually runs.
import xterm from '@xterm/headless';
const { Terminal } = xterm;

// Bottom-most non-empty rows handed to detectState. Dialog footers and shell
// prompts live at the bottom of the screen, so this always catches them, while
// keeping the broader MESSAGE patterns (/approve|deny|allow|reject/) away from
// the scrollback of an agent's own prose further up the screen.
const SCAN_LINES = 10;

export function createScreen(cols = 120, rows = 30) {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  return {
    // The callback is xterm's write-drained signal — unused in production
    // (the 1s tick is long past any flush), used by the tests to read the
    // screen back deterministically.
    write: (data, done) => term.write(data, done),
    resize: (cols, rows) => {
      // A client picks these. xterm throws on non-positive dimensions, and it
      // allocates real memory per cell — unlike the PTY, where the numbers are
      // just a winsize. Bounded well above any real terminal.
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
      term.resize(Math.min(cols, 1000), Math.min(rows, 500));
    },
    lines(limit = SCAN_LINES) {
      const buf = term.buffer.active;
      const out = [];
      for (let i = term.rows - 1; i >= 0 && out.length < limit; i--) {
        // Sliced because a client picks its own `cols`, and several MESSAGE
        // patterns are quadratic on a long line (`/Allow .+ to (read|edit|…)/`
        // measured 2s on one 180KB line, pegging the event loop for every
        // session). No prompt footer is 400 chars wide.
        const text = buf.getLine(buf.viewportY + i)?.translateToString(true).trim().slice(0, 400);
        if (text) out.push(text);
      }
      return out.reverse();
    },
    dispose: () => term.dispose(),
  };
}

/**
 * Point the session's detection window at the current screen. Called on the
 * 1s state-check tick, never per chunk — writes into the emulator are cheap,
 * reading 30 rows back out on every keystroke of every session is not.
 */
export function syncScreenLines(session) {
  if (!session.screen) return;
  const lines = session.screen.lines();
  session.recentStrippedLines = lines;
  session.lastStrippedLine = lines[lines.length - 1] || '';
}
