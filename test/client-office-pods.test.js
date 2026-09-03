// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { computePodLayout, podRugRect, computeDecorPlacement, SPRITE_PATHS, computeBookshelfRuns, computeBoardLayout, computeSpareDesks, computeConference, entryRoute, walkObstacles, corridorY } =
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

// A route leg's swept area: the walker box dragged from one end to the other.
const sweptLeg = l => ({
  x: Math.min(l.x0, l.x1), y: Math.min(l.y0, l.y1),
  w: Math.abs(l.x1 - l.x0) + 16 * 2, h: Math.abs(l.y1 - l.y0) + 32 * 2,
});

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

  it('an empty office gets a chat area in each bottom corner with the plants stacked between them', () => {
    const spots = computeDecorPlacement([], W, H);
    expect(spots.map(s => s.kind).sort()).toEqual(['cactus', 'chat', 'chat', 'plant2']);
    const [left, right] = spots.filter(s => s.kind === 'chat');
    for (const chat of [left, right]) {
      expect(chat.w).toBe(170); // two side sofas, the table, gaps and padding
      expect(chat.h).toBe(130); // front sofa above the table
      expect(chat.y + chat.h).toBe(H - 3 * Z);
    }
    expect(left.x).toBe(13 * Z);
    expect(right.x + right.w).toBe(W - 13 * Z);
    // The divider: leafy plant stacked above the cactus, centred, drawn small
    const plant = spots.find(s => s.kind === 'plant2'), cactus = spots.find(s => s.kind === 'cactus');
    for (const p of [plant, cactus]) {
      expect(p.w).toBe(20); expect(p.h).toBe(40); // 16×32 art at the divider scale
      expect(Math.abs((p.x + p.w / 2) - W / 2)).toBeLessThanOrEqual(1);
    }
    expect(cactus.y + cactus.h).toBe(H - 3 * Z);
    expect(plant.y + plant.h).toBeLessThan(cactus.y);
  });

  it('a chat area yields to a pod row that reaches down into it', () => {
    const [left] = computeDecorPlacement([], W, H).filter(s => s.kind === 'chat');
    const rug = { x: left.x, y: left.y - 6 * Z, w: left.w, h: 10 }; // just inside the margin
    const survivors = computeDecorPlacement([rug], W, H).filter(s => s.kind === 'chat');
    expect(survivors.length).toBe(1);
    expect(survivors[0].x).toBe(W - 170 - 13 * Z); // the RIGHT one survives, not the blocked left
    const clear = { ...rug, y: left.y - 6 * Z - 10 };
    expect(computeDecorPlacement([clear], W, H).filter(s => s.kind === 'chat').length).toBe(2);
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

  it('the conference table centres in the band between the desks and the chat areas', () => {
    const SET_TOP = 22, SET_BOTTOM = 32, SET_H = 240 + SET_TOP + SET_BOTTOM;
    const decor = computeDecorPlacement([], W, H);
    const conf = computeConference([], [], decor, W, H);
    expect(conf).not.toBeNull();
    expect(Math.abs((conf.table.x + conf.table.w / 2) - W / 2)).toBeLessThanOrEqual(1);
    expect(conf.seats.length).toBe(6);
    // Equal gaps above the head seat and below the foot chair
    const chatTop = decor.find(s => s.kind === 'chat').y;
    const above = (conf.table.y - SET_TOP) - (FLOOR_TOP);
    const below = chatTop - (conf.table.y + 240 + SET_BOTTOM);
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
    // Deterministic
    expect(computeConference([], [], decor, W, H)).toEqual(conf);

    // Yields when the spare-desk row leaves too little room
    const { pods } = computePodLayout(agentsOn(['a', '/r/one'], ['b', '/r/two']), W, H);
    const rugs = pods.map(podRugRect);
    const spots = computeDecorPlacement(rugs, W, H);
    const spares = computeSpareDesks(pods, spots, W, H);
    expect(spares.length).toBe(3);
    expect(computeConference(rugs, spares, spots, W, H)).toBeNull();

    // On a taller panel it returns, sitting clear below the spare row
    const TALL = 1100;
    const tallSpots = computeDecorPlacement(rugs, W, TALL);
    const tallSpares = computeSpareDesks(pods, tallSpots, W, TALL);
    const tall = computeConference(rugs, tallSpares, tallSpots, W, TALL);
    expect(tall).not.toBeNull();
    const spareBottom = tallSpares[0].y + WS_H * Z;
    expect(tall.table.y - SET_TOP).toBeGreaterThanOrEqual(spareBottom + 6 * Z);
    expect(tall.table.y + 240 + SET_BOTTOM + 6 * Z)
      .toBeLessThanOrEqual(tallSpots.find(s => s.kind === 'chat').y);
    // Chairs and seats stay inside the panel
    for (const r of [...tall.chairs, ...tall.seats]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + 16 * Z).toBeLessThanOrEqual(W);
    }
  });

  it('the conference set seats both ends, with the head chair clear of the tabletop', () => {
    const conf = computeConference([], [], [], W, H);
    const ends = conf.chairs.filter(c => c.kind === 'confchairback');
    expect(ends).toHaveLength(2);
    const head = ends.find(c => c.y < conf.table.y);
    const foot = ends.find(c => c.y > conf.table.y);
    expect(head).toBeDefined();
    expect(foot).toBeDefined();
    // Both end chairs share the table's centreline
    expect(head.x).toBe(foot.x);
    // The head chair clears the tabletop by more than its sitter does, or the
    // sitter's head hides it completely (the whole point of the head chair)
    expect(head.y).toBeLessThan(conf.seats[0].y);
    // ...and the walk route treats that extra rise as blocked floor
    const [set] = walkObstacles([], [], [], conf).slice(-1);
    expect(set.y).toBeLessThanOrEqual(head.y);
    expect(set.y + set.h).toBeGreaterThanOrEqual(foot.y + 16 * Z);
  });

  it('the conference table yields on a panel narrower than its chair overhang', () => {
    expect(computeConference([], [], [], 200, 700)).toBeNull();
  });

  it('with no chat areas the conference band runs to the panel bottom', () => {
    const SET_TOP = 22, SET_BOTTOM = 32;
    const conf = computeConference([], [], [], W, H);
    expect(conf).not.toBeNull();
    // Centred between FLOOR_TOP and the bottom margin (the empty-spread
    // Math.min must fall back to panelHeight - 3 Z, not Infinity/NaN)
    const above = (conf.table.y - SET_TOP) - FLOOR_TOP;
    const below = (H - 3 * Z) - (conf.table.y + 240 + SET_BOTTOM);
    expect(above).toBeGreaterThan(0);
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
  });

  it('the walk-in entrance stands on bare floor, clear of the decor and the conference chairs', () => {
    for (const w of [440, 458, W]) {
      const decor = computeDecorPlacement([], w, H);
      const conf = computeConference([], [], decor, w, H);
      const obstacles = walkObstacles([], decor, [], conf);
      // Wherever the route puts the entrance, the walker standing there is clear
      const e = entryRoute({ x: 200, y: FLOOR_TOP }, conf, true, H, obstacles).from;
      const walker = { x: e.x, y: e.y, w: 16 * 2, h: 32 * 2 };
      for (const s of decor) expect(overlaps(walker, s), `panel ${w}: ${s.kind}`).toBe(false);
      for (const c of conf.chairs) expect(overlaps(walker, { ...c, w: 16 * Z, h: 16 * Z }), `panel ${w}: chair`).toBe(false);
    }
  });

  it('the walk in/out route around a conference set corridors along a clear row', () => {
    // 1400px tall: the set places with room to spare, so the bands above and
    // below it are wide enough to walk
    const T = 1400;
    const { pods, positions } = computePodLayout(agentsOn(['a', '/r/one']), W, T);
    const rugs = pods.map(podRugRect);
    const decor = computeDecorPlacement(rugs, W, T);
    const spares = computeSpareDesks(pods, decor, W, T);
    const conf = computeConference(rugs, spares, decor, W, T);
    expect(conf).not.toBeNull();
    const obstacles = walkObstacles(rugs, decor, spares, conf);
    const desk = positions.get('a');
    const entry = { x: Z, y: corridorY(obstacles, T, desk.y) };
    for (const inbound of [true, false]) {
      const p = entryRoute(desk, conf, inbound, T, obstacles);
      const [start, end] = inbound ? [entry, desk] : [desk, entry];
      expect(p.from).toEqual(start);
      const last = p.legs[p.legs.length - 1];
      expect({ x: last.x1, y: last.y1 }).toEqual(end);
      for (const l of p.legs) expect(l.x0 === l.x1 || l.y0 === l.y1, 'axis-aligned leg').toBe(true);
      // The crossing leg is the clear row nearest the desk: it touches nothing
      const across = p.legs.find(l => l.y0 === l.y1 && l.x0 !== l.x1);
      expect(across.y0).toBe(corridorY(obstacles, T, desk.y));
      for (const o of obstacles) expect(overlaps(sweptLeg(across), o), `${inbound ? 'in' : 'out'}: corridor`).toBe(false);
      // The entrance is that row's left end, so nothing walks the left strip
      expect(p.legs.some(l => l.x0 === l.x1 && l.x0 === entry.x),
        `${inbound ? 'in' : 'out'}: leg on the left strip`).toBe(false);
    }
  });

  it('a walk-out from the conference foot seat steps out via the lane, never up through the table', () => {
    const T = 1400;
    const { pods } = computePodLayout(agentsOn(['a', '/r/one']), W, T);
    const rugs = pods.map(podRugRect);
    const decor = computeDecorPlacement(rugs, W, T);
    const spares = computeSpareDesks(pods, decor, W, T);
    const conf = computeConference(rugs, spares, decor, W, T);
    const obstacles = walkObstacles(rugs, decor, spares, conf);
    const foot = conf.seats[5];
    const p = entryRoute(foot, conf, false, T, obstacles);
    // The sitter steps sideways out of the table's columns first
    expect(p.legs[0].y0).toBe(p.legs[0].y1);
    for (const l of p.legs) {
      if (l.x0 !== l.x1) continue;
      const clearOfTable = l.x0 + 16 * 2 <= conf.table.x || l.x0 >= conf.table.x + conf.table.w;
      expect(clearOfTable, `vertical leg at x=${l.x0} runs through the table`).toBe(true);
    }
  });

  it('on a panel too tight for a clear row the conference route still clears the chairs', () => {
    // 1000px tall: the set places with only its 6 Z margins, so no band fits a
    // whole character and the route crosses on the widest gap it can find
    const T = 1000;
    const { pods, positions } = computePodLayout(agentsOn(['a', '/r/one']), W, T);
    const rugs = pods.map(podRugRect);
    const decor = computeDecorPlacement(rugs, W, T);
    const spares = computeSpareDesks(pods, decor, W, T);
    const conf = computeConference(rugs, spares, decor, W, T);
    const obstacles = walkObstacles(rugs, decor, spares, conf);
    const chairs = conf.chairs.map(c => ({ ...c, w: 16 * Z, h: 16 * Z }));
    for (const inbound of [true, false]) {
      const p = entryRoute(positions.get('a'), conf, inbound, T, obstacles);
      for (const l of p.legs)
        for (const c of chairs) expect(overlaps(sweptLeg(l), c), `${inbound ? 'in' : 'out'}: chair at ${c.x},${c.y}`).toBe(false);
      const across = p.legs.find(l => l.y0 === l.y1 && l.x0 !== l.x1);
      expect(across.y0).toBeLessThan(conf.table.y);
    }
  });

  it('a packed panel still keeps the crossing off the chat furniture', () => {
    // 900x700 with one agent: rug, spare row and chats leave gaps of 24, 18, 54
    // and 9px against a 64px character, so nothing fits. The old fallback put
    // the crossing on the bottom edge — straight through both sofa areas.
    const T = 700;
    const { pods, positions } = computePodLayout(agentsOn(['a', '/r/one']), W, T);
    const rugs = pods.map(podRugRect);
    const decor = computeDecorPlacement(rugs, W, T);
    const spares = computeSpareDesks(pods, decor, W, T);
    const conf = computeConference(rugs, spares, decor, W, T);
    expect(conf).toBeNull();
    const obstacles = walkObstacles(rugs, decor, spares, conf);
    const chats = decor.filter(s => s.kind === 'chat');
    expect(chats.length).toBe(2);
    for (const inbound of [true, false]) {
      const p = entryRoute(positions.get('a'), conf, inbound, T, obstacles);
      const across = p.legs.find(l => l.y0 === l.y1 && l.x0 !== l.x1);
      expect(across.y0).not.toBe(T - 32 * 2);
      for (const c of chats)
        expect(overlaps(sweptLeg(across), c), `${inbound ? 'in' : 'out'}: chat at ${c.x},${c.y}`).toBe(false);
    }
  });

  it('spare desks and the conference set keep out of the entry strip on narrow panels', () => {
    const STRIP = Z + 16 * 2;
    // Spare rows that would centre into the strip drop a desk instead of sitting on the entrance
    for (const [w, ids] of [[420, ['a', 'b', 'c']], [260, ['a']]]) {
      const { pods } = computePodLayout(agentsOn(...ids.map(id => [id, '/r/one'])), w, H);
      const spares = computeSpareDesks(pods, computeDecorPlacement(pods.map(podRugRect), w, H), w, H);
      expect(spares.length, `panel ${w}`).toBeGreaterThan(0);
      for (const d of spares) expect(d.x, `panel ${w}`).toBeGreaterThanOrEqual(STRIP);
    }
    // The set yields while its left chairs would overhang the strip, and clears it once placed
    expect(computeConference([], [], [], 297, 1100)).toBeNull();
    for (const w of [298, 320, 440]) {
      const conf = computeConference([], [], [], w, 1100);
      expect(conf, `panel ${w}`).not.toBeNull();
      for (const c of conf.chairs) expect(c.x, `panel ${w}`).toBeGreaterThanOrEqual(STRIP);
    }
  });

  it('with no conference set the walk in/out corridors along a clear row, not the chat furniture', () => {
    // 8 agents on a 700px panel: two pod rows, no room for the set
    const ids = Array.from({ length: 8 }, (_, i) => [`s${i}`, '/r/one']);
    const { pods, positions } = computePodLayout(agentsOn(...ids), 700, 800);
    const rugs = pods.map(podRugRect);
    const decor = computeDecorPlacement(rugs, 700, 800);
    const spares = computeSpareDesks(pods, decor, 700, 800);
    expect(computeConference(rugs, spares, decor, 700, 800)).toBeNull();
    const obstacles = walkObstacles(rugs, decor, spares, null);
    const desk = positions.get('s7');
    for (const inbound of [true, false]) {
      const p = entryRoute(desk, null, inbound, 800, obstacles);
      const across = p.legs.find(l => l.y0 === l.y1 && l.x0 !== l.x1);
      // The old route crossed along the bottom edge — straight through the chat rugs
      expect(across.y0).not.toBe(800 - 32 * 2);
      expect(across.y0).toBe(corridorY(obstacles, 800, desk.y));
      for (const o of obstacles) expect(overlaps(sweptLeg(across), o), `${inbound ? 'in' : 'out'}: corridor`).toBe(false);
      // Only the destination's own desk is touched: every other desk is clear of every leg
      for (const [id, d] of positions) {
        if (id === 's7') continue;
        const other = { x: d.x, y: d.y, w: WS_W * Z, h: WS_H * Z };
        for (const l of p.legs) {
          expect(overlaps(sweptLeg(l), other), `${inbound ? 'in' : 'out'}: desk ${id}`).toBe(false);
        }
      }
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
