// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { computePodLayout, podRugRect, computeDecorPlacement, SPRITE_PATHS, computeBookshelfRuns, computeBoardLayout, computeSpareDesks, entryPoint } =
  await import('../public/modules/office.js');

const Z = 3;
const WS_W = 32, WS_H = 36, WS_GAP_X = 12, WS_GAP_Y = 18;
const FLOOR_TOP = (36 * Z + 2 * Z) + 26 * Z; // WALL_BOTTOM + 26 Z
const TOP_MARGIN = (8 + 7) * Z; // POD_TOP_MARGIN + RUG_PAD_TOP: desk y when the floor has room

const W = 900, H = 700;

function agentsOn(...repoLists) {
  // agentsOn(['a','r1'], ['b','r1'], ['c', null]) → infos in spawn order
  return repoLists.map(([id, repo]) => ({ id, repoPath: repo, slug: repo ? repo.split('/').pop() : null }));
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('pod layout', () => {
  it('groups agents by repo into separate pods, no-repo agents in a final unlabeled pod', () => {
    const { pods, positions } = computePodLayout(agentsOn(
      ['a', '/r/one'], ['b', '/r/two'], ['c', '/r/one'], ['d', null],
    ), W, H);
    expect(pods.map(p => p.repoPath)).toEqual(['/r/one', '/r/two', null]);
    expect(pods.map(p => p.label)).toEqual(['one', 'two', null]);
    expect(positions.size).toBe(4);
    // a and c share the pod, side by side in one front-facing row
    expect(positions.get('c').y).toBe(positions.get('a').y);
    expect(positions.get('c').x - positions.get('a').x).toBe((WS_W + WS_GAP_X) * Z);
  });

  it('anchors a sparse office near the top of the floor, but still centers a full one', () => {
    const one = computePodLayout(agentsOn(['a', '/r/one']), W, H);
    expect(one.positions.get('a').y).toBe(FLOOR_TOP + TOP_MARGIN);
    expect(podRugRect(one.pods[0]).y).toBe(FLOOR_TOP + 8 * Z);
    // Floor exactly one desk-block tall plus a hair: centering offset < margin wins.
    const shortH = FLOOR_TOP + WS_H * Z + 2 * Z;
    expect(computePodLayout(agentsOn(['a', '/r/one']), W, shortH).positions.get('a').y).toBe(FLOOR_TOP + Z);
    // Overflowing floor: never above FLOOR_TOP.
    expect(computePodLayout(agentsOn(['a', '/r/one']), W, FLOOR_TOP).positions.get('a').y).toBe(FLOOR_TOP);
  });

  it('a single repo lays out as a top-anchored front-facing grid, wrapping after maxCols', () => {
    const infos = agentsOn(['a', '/r/one'], ['b', '/r/one'], ['c', '/r/one'], ['d', '/r/one'], ['e', '/r/one']);
    const { pods, positions } = computePodLayout(infos, W, H);
    expect(pods).toHaveLength(1);
    // 5 agents → 4 columns (maxCols) × 2 rows, anchored near the top of the floor
    const cols = 4, rows = 2;
    const gridW = (cols * WS_W + (cols - 1) * WS_GAP_X) * Z;
    const gridH = (rows * WS_H + (rows - 1) * WS_GAP_Y) * Z;
    const startX = Math.floor((W - gridW) / 2);
    const startY = Math.max(FLOOR_TOP, FLOOR_TOP + Math.min(TOP_MARGIN, Math.floor((H - FLOOR_TOP - gridH) / 2)));
    infos.forEach(({ id }, i) => {
      expect(positions.get(id)).toEqual({
        x: startX + (i % cols) * (WS_W + WS_GAP_X) * Z,
        y: startY + Math.floor(i / cols) * (WS_H + WS_GAP_Y) * Z,
      });
    });
  });

  it('fills exactly maxCols in one row, and sizes a wrapped pod to its full grid', () => {
    const four = agentsOn(['a', '/r/one'], ['b', '/r/one'], ['c', '/r/one'], ['d', '/r/one']);
    const full = computePodLayout(four, W, H);
    // 4 agents on a 4-col panel: one row, no empty second row reserved
    expect(full.pods[0].w).toBe((4 * WS_W + 3 * WS_GAP_X) * Z);
    expect(full.pods[0].h).toBe(WS_H * Z);
    expect(new Set(four.map(({ id }) => full.positions.get(id).y)).size).toBe(1);

    // A fifth agent wraps: the rug grows by exactly one row plus the aisle
    const { pods } = computePodLayout([...four, ...agentsOn(['e', '/r/one'])], W, H);
    expect(pods[0].w).toBe((4 * WS_W + 3 * WS_GAP_X) * Z);
    expect(pods[0].h).toBe((2 * WS_H + WS_GAP_Y) * Z);
  });

  it('a lone agent gets a single desk', () => {
    const { pods } = computePodLayout(agentsOn(['a', '/r/one']), W, H);
    expect(pods[0].w).toBe(WS_W * Z);
    expect(pods[0].h).toBe(WS_H * Z); // one desk: no aisle, no second row
  });

  it('wraps pods to a new row when they do not fit, and rugs never overlap', () => {
    const infos = agentsOn(
      ['a', '/r/1'], ['b', '/r/1'], ['c', '/r/2'], ['d', '/r/2'],
      ['e', '/r/3'], ['f', '/r/3'], ['g', '/r/4'], ['h', '/r/4'],
    );
    const { pods } = computePodLayout(infos, 400, 900);
    expect(pods.length).toBe(4);
    expect(new Set(pods.map(p => p.y)).size).toBeGreaterThan(1); // wrapped
    const rugs = pods.map(podRugRect);
    for (let i = 0; i < rugs.length; i++)
      for (let j = i + 1; j < rugs.length; j++)
        expect(overlaps(rugs[i], rugs[j]), `rug ${i} vs ${j}`).toBe(false);
    // Desks stay on the open floor
    for (const p of pods) expect(p.y).toBeGreaterThanOrEqual(FLOOR_TOP);
  });

  it('keeps within-pod desk order stable when an unrelated agent spawns or exits', () => {
    const base = agentsOn(['a', '/r/one'], ['b', '/r/one'], ['c', '/r/one']);
    const rel = (positions, pod) => base.map(({ id }) => {
      const p = positions.get(id);
      return { dx: p.x - pod.x, dy: p.y - pod.y };
    });
    const before = computePodLayout(base, W, H);
    const withStranger = computePodLayout(
      [...base, ...agentsOn(['z', '/r/other'])], W, H);
    const podBefore = before.pods[0];
    const podAfter = withStranger.pods.find(p => p.repoPath === '/r/one');
    expect(rel(withStranger.positions, podAfter)).toEqual(rel(before.positions, podBefore));
  });

  it('an empty office yields no pods and no positions, but decor still places', () => {
    const { pods, positions } = computePodLayout([], W, H);
    expect(pods).toEqual([]);
    expect(positions.size).toBe(0);
    expect(computeDecorPlacement(pods.map(podRugRect), W, H).length).toBeGreaterThan(0);
  });

  it('clamps to a single column on a narrow panel and keeps desks inside it', () => {
    const narrow = (WS_W + 4) * Z; // room for one desk, not two
    const infos = agentsOn(['a', '/r/one'], ['b', '/r/one'], ['c', '/r/one']);
    const { pods, positions } = computePodLayout(infos, narrow, 2000);
    expect(pods[0].w).toBe(WS_W * Z); // one column
    const xs = new Set(infos.map(({ id }) => positions.get(id).x));
    expect(xs.size).toBe(1); // all stacked vertically
    // One desk per row, a full aisle between rows
    expect(positions.get('b').y - positions.get('a').y).toBe((WS_H + WS_GAP_Y) * Z);
    expect(positions.get('c').y - positions.get('a').y).toBe(2 * (WS_H + WS_GAP_Y) * Z);
    // The rug ends at the last desk row
    const lastDeskBottom = Math.max(...infos.map(({ id }) => positions.get(id).y)) + WS_H * Z;
    expect(pods[0].y + pods[0].h).toBe(lastDeskBottom);
    for (const { id } of infos) {
      const p = positions.get(id);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + WS_W * Z).toBeLessThanOrEqual(narrow);
    }
  });

  it('falls back to the repo basename as the pod label when slug is missing', () => {
    const { pods } = computePodLayout([{ id: 'a', repoPath: '/r/deep/cobra', slug: null }], W, H);
    expect(pods[0].label).toBe('cobra');
    // Trailing slash must not yield an empty (hidden) label
    const trailing = computePodLayout([{ id: 'a', repoPath: '/r/deep/cobra/', slug: null }], W, H);
    expect(trailing.pods[0].label).toBe('cobra');
  });

  it('decor fills empty floor, yields to pods, and never overlaps a rug', () => {
    // Empty office: decor everywhere it fits
    expect(computeDecorPlacement([], W, H).length).toBeGreaterThan(0);

    // Crowded office: a rug covering the whole floor leaves no decor
    const floorRug = { x: 0, y: FLOOR_TOP, w: W, h: H - FLOOR_TOP };
    expect(computeDecorPlacement([floorRug], W, H)).toEqual([]);

    // Normal office: whatever is placed clears every rug and stays on the floor
    const { pods } = computePodLayout(agentsOn(['a', '/r/one'], ['b', '/r/two']), W, H);
    const rugs = pods.map(podRugRect);
    const spots = computeDecorPlacement(rugs, W, H);
    const MARGIN = 6 * Z; // decor keeps this clearance so it also clears the glow halos
    const inflate = (r) => ({ x: r.x - MARGIN, y: r.y - MARGIN, w: r.w + 2 * MARGIN, h: r.h + 2 * MARGIN });
    for (const s of spots) {
      expect(s.y).toBeGreaterThanOrEqual(FLOOR_TOP);
      expect(s.x + s.w).toBeLessThanOrEqual(W);
      expect(s.y + s.h).toBeLessThanOrEqual(H);
      for (const r of rugs) expect(overlaps(s, inflate(r))).toBe(false);
    }
    // Same inputs → same placement (deterministic)
    expect(computeDecorPlacement(rugs, W, H)).toEqual(spots);
  });

  it('an empty office gets a centred bottom chat area and a different plant in each bottom corner', () => {
    const spots = computeDecorPlacement([], W, H);
    expect(spots.map(s => s.kind).sort()).toEqual(['cactus', 'chat', 'plant2']);
    const chat = spots.find(s => s.kind === 'chat');
    expect(chat.w).toBe(170); // two side sofas, the table, gaps and padding
    expect(chat.h).toBe(130); // front sofa above the table
    expect(Math.abs((chat.x + chat.w / 2) - W / 2)).toBeLessThanOrEqual(1);
    expect(chat.y + chat.h).toBe(H - 3 * Z);
    const left = spots.find(s => s.kind === 'plant2'), right = spots.find(s => s.kind === 'cactus');
    expect(left.x).toBe(4 * Z);
    expect(right.x + right.w).toBe(W - 4 * Z);
    for (const p of [left, right]) {
      expect(p.w).toBe(16 * 2); expect(p.h).toBe(32 * 2); // CHAR_SCALE
      expect(p.y + p.h).toBe(H - 3 * Z);
    }
  });

  it('the chat area yields to a pod row that reaches down into it', () => {
    const chat = computeDecorPlacement([], W, H).find(s => s.kind === 'chat');
    const rug = { x: chat.x, y: chat.y - 6 * Z, w: chat.w, h: 10 }; // just inside the margin
    expect(computeDecorPlacement([rug], W, H).map(s => s.kind)).toEqual(['plant2', 'cactus']);
    const clear = { ...rug, y: chat.y - 6 * Z - 10 };
    expect(computeDecorPlacement([clear], W, H).map(s => s.kind)).toContain('chat');
  });

  it('every sprite path points at a file that exists (a missing one silently drops its decor group)', () => {
    for (const [key, path] of Object.entries(SPRITE_PATHS)) expect(existsSync('public/' + path), key).toBe(true);
  });

  it('a bookshelf run sits centred under each window, feet tight against the wall', () => {
    const WINDOW_W = 28 * Z;
    for (const w of [280, 440, 600, W]) {
      const board = computeBoardLayout(w);
      const runs = computeBookshelfRuns(w);
      expect(runs.length, `panel ${w}`).toBe(2);
      // Windows sit between the board sections: section i's right edge + 1Z gap
      runs.forEach((r, i) => {
        const winX = board.sections[i].right + Z;
        expect(r.w).toBe(3 * 12 * 2); // three 12px-wide units at 2x
        expect(r.x, `panel ${w}`).toBeGreaterThanOrEqual(winX);
        expect(r.x + r.w, `panel ${w}`).toBeLessThanOrEqual(winX + WINDOW_W);
        expect(Math.abs((r.x - winX) - (winX + WINDOW_W - r.x - r.w)), `panel ${w} centred`).toBeLessThanOrEqual(1);
        expect(r.y + r.h).toBe(board.wallBottom + Z);
        expect(r.y + r.h).toBeLessThan(board.footY);
      });
    }
    // Too narrow for a board: no shelves either
    expect(computeBookshelfRuns(120)).toEqual([]);
  });

  it('spare desks fill the row below a single pod row and vanish as the office fills', () => {
    const one = computePodLayout(agentsOn(['a', '/r/one'], ['b', '/r/two']), W, H);
    const decor = computeDecorPlacement(one.pods.map(podRugRect), W, H);
    const spare = computeSpareDesks(one.pods, decor, W, H);
    expect(spare.length).toBe(3);
    expect(spare.map(d => d.variant)).toEqual([0, 1, 0]);
    // One row-pitch below the real row, on the desk grid, centred
    for (const d of spare) expect(d.y).toBe(one.pods[0].y + (WS_H + WS_GAP_Y) * Z);
    expect(spare[1].x - spare[0].x).toBe((WS_W + WS_GAP_X) * Z);
    expect(Math.abs((spare[0].x + spare[2].x + WS_W * Z) / 2 - W / 2)).toBeLessThanOrEqual(1);
    // Clear of the chat area and the panel bottom
    const chat = decor.find(s => s.kind === 'chat');
    expect(spare[0].y + WS_H * Z + 6 * Z).toBeLessThanOrEqual(chat.y);
    // One pod: the spare desks share the real desks' columns
    const solo = computePodLayout(agentsOn(['a', '/r/one'], ['b', '/r/one']), W, H);
    const soloSpare = computeSpareDesks(solo.pods, [], W, H);
    const colOf = (x) => ((x - solo.pods[0].x) % ((WS_W + WS_GAP_X) * Z) + (WS_W + WS_GAP_X) * Z) % ((WS_W + WS_GAP_X) * Z);
    for (const d of soloSpare) expect(colOf(d.x)).toBe(0);

    // Two rows of real pods: none
    const two = computePodLayout(agentsOn(['a', '/r/one'], ['b', '/r/one'], ['c', '/r/one'], ['d', '/r/one'], ['e', '/r/one']), W, H);
    expect(two.pods[0].h).toBeGreaterThan(WS_H * Z);
    expect(computeSpareDesks(two.pods, computeDecorPlacement(two.pods.map(podRugRect), W, H), W, H)).toEqual([]);
    // Two pod rows (wrapped): none
    const wrapped = computePodLayout(agentsOn(['a', '/r/one'], ['b', '/r/two']), 2 * (WS_W + 4) * Z, H);
    expect(new Set(wrapped.pods.map(p => p.y)).size).toBe(2);
    expect(computeSpareDesks(wrapped.pods, [], 2 * (WS_W + 4) * Z, H)).toEqual([]);
    // Short panel: the spare row would intrude on the chat area
    const short = computePodLayout(agentsOn(['a', '/r/one']), W, 600);
    const shortDecor = computeDecorPlacement(short.pods.map(podRugRect), W, 600);
    expect(shortDecor.map(s => s.kind)).toContain('chat');
    expect(computeSpareDesks(short.pods, shortDecor, W, 600)).toEqual([]);
    // Empty office: no real row to sit below
    expect(computeSpareDesks([], computeDecorPlacement([], W, H), W, H)).toEqual([]);
    // Narrow panel: only as many spare desks as columns fit (300px → 2)
    const narrow = computePodLayout(agentsOn(['a', '/r/one']), 300, H);
    expect(computeSpareDesks(narrow.pods, [], 300, H).length).toBe(2);
    // No decor at all, but the row would run into the panel bottom: none
    const shallow = computePodLayout(agentsOn(['a', '/r/one']), W, 500);
    expect(computeSpareDesks(shallow.pods, [], W, 500)).toEqual([]);
  });

  it('the walk-in entrance stands on bare floor, clear of the bottom decor', () => {
    for (const w of [440, 458, W]) {
      const e = entryPoint(w, H);
      const walker = { x: e.x, y: e.y, w: 16 * 2, h: 32 * 2 };
      for (const s of computeDecorPlacement([], w, H)) expect(overlaps(walker, s), `panel ${w}: ${s.kind}`).toBe(false);
    }
  });

  it('decor spots never overlap each other, even on a narrow panel', () => {
    for (const w of [140, 180, 240, W]) {
      const spots = computeDecorPlacement([], w, H);
      for (let i = 0; i < spots.length; i++)
        for (let j = i + 1; j < spots.length; j++)
          expect(overlaps(spots[i], spots[j]), `panel ${w}: spot ${i} vs ${j}`).toBe(false);
    }
  });
});
