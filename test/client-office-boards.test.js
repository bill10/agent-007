// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { computeBoardLayout, BOARD_TITLES } = await import('../public/modules/office.js');
const { COLUMNS } = await import('../public/modules/jobs.js');
const { JOB_STATES } = await import('../lib/jobs.js');

const Z = 3;

// The board's drawn box, matching drawJobBoardEasels: the left edge is floored,
// and the drop shadow in drawWhiteboard reaches one Z-unit further right.
function drawnBox(section, board) {
  const left = section.centerX - Math.floor(board.boardW / 2);
  return { left, right: left + board.boardW, shadowRight: left + board.boardW + Z };
}

// The job boards stand in the three wall sections between the windows. Their
// geometry is pure arithmetic over the panel width, so it is checked here
// rather than by eyeballing the canvas.
describe('job board placement', () => {
  // Includes the band where the boards first appear and are at minimum size.
  const widths = [200, 240, 252, 270, 288, 306, 320, 400, 480, 640, 900, 1280, 2000];

  it('keeps every board, drop shadow included, inside its own wall section', () => {
    for (const w of widths) {
      const board = computeBoardLayout(w);
      if (!board.visible) continue;
      for (const section of board.sections) {
        const box = drawnBox(section, board);
        expect(box.left, `panel ${w}`).toBeGreaterThanOrEqual(section.left);
        expect(box.shadowRight, `panel ${w}`).toBeLessThanOrEqual(section.right);
      }
    }
  });

  it('centres the board frame on its stand', () => {
    for (const w of widths) {
      const board = computeBoardLayout(w);
      if (!board.visible) continue;
      for (const section of board.sections) {
        const box = drawnBox(section, board);
        // The stand's legs, brace and shadow are all centred on section.centerX.
        expect((box.left + box.right) / 2, `panel ${w}`).toBe(section.centerX);
      }
    }
  });

  it('stands almost against the wall, on the floor, clear of the desk grid', () => {
    for (const w of widths) {
      const board = computeBoardLayout(w);
      if (!board.visible) continue;
      // Feet on the floor (below the baseboard), no further out than the
      // plant pots' fronts (6 Z deep): the boards belong against the wall,
      // not wandering out into the room.
      expect(board.footY, `panel ${w}`).toBeGreaterThan(board.wallBottom);
      expect(board.footY - board.wallBottom, `panel ${w}`).toBeLessThanOrEqual(6 * Z);
      // The frame rises up the wall but never above the ceiling line.
      expect(board.boardTop, `panel ${w}`).toBeGreaterThanOrEqual(0);
      expect(board.footY, `panel ${w}`).toBeLessThan(board.floorTop);
      expect(board.frameBottom, `panel ${w}`).toBeLessThan(board.footY);
    }
  });

  it('draws nothing rather than smudges on a panel too narrow for a board', () => {
    expect(computeBoardLayout(160).visible).toBe(false);
    expect(computeBoardLayout(900).visible).toBe(true);
  });
});

// The three whiteboards are the real board's columns, in order. The column
// list exists three times (server states, board tab labels, canvas titles)
// and nothing imports across them, so this is what keeps them in step.
// `done` has no column (a merged card leaves the board), so no whiteboard.
describe('job board titles', () => {
  it('are the board tab column labels, shouted', () => {
    expect(BOARD_TITLES).toEqual(COLUMNS.map((c) => c.label.toUpperCase()));
  });

  it('cover every job state except done, in order', () => {
    expect(COLUMNS.map((c) => c.state)).toEqual(JOB_STATES.filter((s) => s !== 'done'));
  });
});
