// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { computePodLayout, podRugRect, computeDecorPlacement, computeWallDecor } =
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

  it('an empty office never repeats a plant sprite more than twice', () => {
    const kinds = computeDecorPlacement([], W, H).map(s => s.kind);
    expect(kinds).toContain('lounge');
    expect(kinds).toContain('largeplant');
    for (const k of new Set(kinds)) expect(kinds.filter(x => x === k).length, k).toBeLessThanOrEqual(2);
  });

  it('wall hangings sit beside their board when the section has room, else above it', () => {
    // Wide panel: every hanging hangs on the plaster at window height
    const wide = computeWallDecor(W);
    expect(wide.map(h => h.key)).toEqual(['painting1', 'clock', 'painting2']);
    for (const h of wide) expect(h.y).toBe(2 * Z);
    // Default 440px panel: boards fill their sections, so hangings move above them
    const narrow = computeWallDecor(440);
    expect(narrow).toHaveLength(3);
    for (const h of narrow) expect(h.y).toBeLessThan(0);
    // Too narrow for a board: nothing hangs
    expect(computeWallDecor(120)).toEqual([]);
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
