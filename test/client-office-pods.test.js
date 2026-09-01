// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { computePodLayout, podRugRect, computeDecorPlacement } =
  await import('../public/modules/office.js');

const Z = 3;
const WS_W = 32, WS_H = 36, WS_GAP_X = 12, WS_GAP_Y = 18;
const FLOOR_TOP = (36 * Z + 2 * Z) + 26 * Z; // WALL_BOTTOM + 26 Z

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
    // a and c share the pod as a facing pair: same column, one desk row apart,
    // the top desk flipped toward the aisle and the bottom one default
    expect(positions.get('c').x).toBe(positions.get('a').x);
    expect(positions.get('c').y - positions.get('a').y).toBe((WS_H + WS_GAP_Y) * Z);
    expect(positions.get('a').flip).toBe(true);
    expect(positions.get('c').flip).toBe(false);
  });

  it('a single repo lays out as centered facing pairs, unpaired last desk default', () => {
    const infos = agentsOn(['a', '/r/one'], ['b', '/r/one'], ['c', '/r/one'], ['d', '/r/one'], ['e', '/r/one']);
    const { pods, positions } = computePodLayout(infos, W, H);
    expect(pods).toHaveLength(1);
    // 5 agents → 3 pair columns × 2 rows, centered in [FLOOR_TOP, H]
    const cols = 3, rows = 2;
    const gridW = (cols * WS_W + (cols - 1) * WS_GAP_X) * Z;
    const gridH = (rows * WS_H + (rows - 1) * WS_GAP_Y) * Z;
    const startX = Math.floor((W - gridW) / 2);
    const startY = Math.max(FLOOR_TOP, Math.floor(FLOOR_TOP + (H - FLOOR_TOP - gridH) / 2));
    infos.forEach(({ id }, i) => {
      const pair = i >> 1;
      expect(positions.get(id)).toEqual({
        x: startX + (pair % cols) * (WS_W + WS_GAP_X) * Z,
        y: startY + (i % 2) * (WS_H + WS_GAP_Y) * Z,
        // even index = top desk of a pair, flipped — except 'e', the unpaired
        // last desk, which keeps the default orientation
        flip: i % 2 === 0 && i < 4,
      });
    });
  });

  it('a lone agent gets a single desk in the default orientation', () => {
    const { pods, positions } = computePodLayout(agentsOn(['a', '/r/one']), W, H);
    expect(pods[0].w).toBe(WS_W * Z);
    expect(pods[0].h).toBe(WS_H * Z); // one desk: no aisle, no second row
    expect(positions.get('a').flip).toBe(false);
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

  it('decor spots never overlap each other, even on a narrow panel', () => {
    for (const w of [140, 180, 240, W]) {
      const spots = computeDecorPlacement([], w, H);
      for (let i = 0; i < spots.length; i++)
        for (let j = i + 1; j < spots.length; j++)
          expect(overlaps(spots[i], spots[j]), `panel ${w}: spot ${i} vs ${j}`).toBe(false);
    }
  });
});
