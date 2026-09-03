// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { entryRoute, corridorY, pointAlongPath, detectDispatches, approachX, wanderRoute } =
  await import('../public/modules/office.js');

const FLOOR_TOP = (36 * 3 + 2 * 3) + 26 * 3, CHAR_W = 32, CHAR_H = 64;
// A leg's swept area: the walker box dragged from one end to the other.
const swept = l => ({
  x: Math.min(l.x0, l.x1), y: Math.min(l.y0, l.y1),
  w: Math.abs(l.x1 - l.x0) + CHAR_W, h: Math.abs(l.y1 - l.y0) + CHAR_H,
});
// The leg that crosses the room: the horizontal one running to the entrance.
// A blocked descent adds a sidestep along the desk's own row, which is not it.
const crossingLeg = p => p.legs.find(l => l.y0 === l.y1 && (l.x0 === 3 || l.x1 === 3));

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('walk path', () => {
  it('walks from start to end, clamped at both ends', () => {
    const p = { from: { x: 100, y: 200 }, total: 180,
      legs: [{ x0: 100, y0: 200, x1: 40, y1: 200 }, { x0: 40, y0: 200, x1: 40, y1: 80 }] };
    expect(pointAlongPath(p, -5)).toMatchObject({ x: 100, y: 200 });
    expect(pointAlongPath(p, p.total + 5)).toMatchObject({ x: 40, y: 80 });
    expect(pointAlongPath(p, 30)).toMatchObject({ x: 70, y: 200, dx: -1, dy: 0 });
    expect(pointAlongPath(p, 90)).toMatchObject({ x: 40, y: 170, dx: 0, dy: -1 });
  });

  it('handles a zero-length path', () => {
    const p = { from: { x: 100, y: 200 }, legs: [], total: 0 };
    expect(pointAlongPath(p, 10)).toMatchObject({ x: 100, y: 200 });
  });
});

describe('corridor rows', () => {
  const H = 800;
  // A pod rug band and the chat furniture along the bottom: one clear row
  // between them, the slivers above and below too narrow to walk.
  const rug = { x: 100, y: 216, w: 400, h: 160 };
  const chat = { x: 60, y: 660, w: 600, h: 130 };
  const obstacles = [rug, chat];

  it('picks a row clear of every obstacle, wide enough for the character', () => {
    for (const y of [200, 300, 500, 700, 795]) {
      const c = corridorY(obstacles, H, y);
      const box = { x: 0, y: c, w: 1000, h: CHAR_H };
      for (const o of obstacles) expect(overlaps(box, o), `near ${y}`).toBe(false);
      expect(c).toBeGreaterThanOrEqual(FLOOR_TOP);
      expect(c + CHAR_H).toBeLessThanOrEqual(H);
    }
  });

  it('picks the clear row nearest the target, above or below it', () => {
    const mid = [{ x: 0, y: 300, w: 500, h: 120 }];
    expect(corridorY(mid, H, 250)).toBe(300 - CHAR_H); // the band above
    expect(corridorY(mid, H, 600)).toBe(600);          // the band below
    // A target on the furniture itself takes the nearer side of it
    expect(corridorY(mid, H, 350)).toBe(420);
  });

  it('takes the widest gap when none fits a whole character, feet on its floor', () => {
    // 40px above the chat, 54px below the rug: the walker stands in the wider
    // one with its feet at the bottom, overlapping the furniture above it.
    const tight = [{ x: 0, y: FLOOR_TOP + 40, w: 900, h: 200 },
                   { x: 0, y: FLOOR_TOP + 294, w: 900, h: H }];
    expect(corridorY(tight, H, 500)).toBe(FLOOR_TOP + 294 - CHAR_H);
    // Never the bottom edge, which is where the chat furniture lives
    expect(corridorY(tight, H, 500)).not.toBe(H - CHAR_H);
  });

  it('stands on the desk row when the floor is furniture end to end', () => {
    expect(corridorY([{ x: 0, y: 0, w: 900, h: H }], H, 400)).toBe(400);
  });
});

describe('walk in/out routing', () => {
  const W = 900, H = 800;
  const rug = { x: 100, y: 216, w: 400, h: 160 };
  const chat = { x: 60, y: 660, w: 600, h: 130 };
  const obstacles = [rug, chat];
  const desk = { x: 300, y: 260 }; // on the rug, in the top row
  // No door: the entrance is the left end of whatever row the walker crosses.
  const entryFor = d => ({ x: 3, y: corridorY(obstacles, H, d.y) });

  for (const inbound of [true, false]) {
    it(`walk-${inbound ? 'in' : 'out'} enters on the left edge at its corridor row`, () => {
      const p = entryRoute(desk, null, inbound, H, obstacles);
      const entry = entryFor(desk);
      const [start, end] = inbound ? [entry, desk] : [desk, entry];
      expect(p.from).toEqual(start);
      const last = p.legs[p.legs.length - 1];
      expect({ x: last.x1, y: last.y1 }).toEqual(end);
      // The corridor is the clear row below the rug, not the bottom edge the
      // old route used — that one ran straight through the chat furniture.
      const across = crossingLeg(p);
      expect(across.y0).toBe(corridorY(obstacles, H, desk.y));
      expect(across.y0).not.toBe(H - CHAR_H);
      // Only the desk column leg touches anything, and only the desk's own rug
      for (const l of p.legs) {
        const isDeskColumn = l.x0 === desk.x && l.x1 === desk.x;
        for (const o of obstacles) {
          if (isDeskColumn && o === rug) continue;
          expect(overlaps(swept(l), o), `${inbound ? 'in' : 'out'} leg ${JSON.stringify(l)}`).toBe(false);
        }
      }
    });
  }

  it('has no fixed door: the entrance rides the corridor and never runs the left strip', () => {
    const below = { x: 300, y: 600 }; // a desk under the rug band, on the far row
    const [a, b] = [desk, below].map(d => entryRoute(d, null, true, H, obstacles));
    expect(a.from.x).toBe(b.from.x);            // both come in at the left edge
    expect(a.from.y).not.toBe(b.from.y);        // at their own row, not one door
    for (const p of [a, b]) {
      expect(p.from).toEqual(entryFor(p === a ? desk : below));
      // Nothing walks up or down the left edge to reach the row any more
      expect(p.legs.some(l => l.x0 === l.x1 && l.x0 === p.from.x)).toBe(false);
    }
  });

  it('drops down a clear aisle instead of stepping over the rug in between', () => {
    // Only one gap fits a character, and it is below the second rug: the old
    // route came straight down the desk column, over that rug.
    const top = { x: 100, y: 200, w: 400, h: 160 };
    const lower = { x: 60, y: 380, w: 500, h: 160 };
    const d = { x: 300, y: 240 }; // on the top rug
    for (const inbound of [true, false]) {
      const p = entryRoute(d, null, inbound, H, [top, lower]);
      for (const l of p.legs)
        expect(overlaps(swept(l), lower), `${inbound ? 'in' : 'out'} leg ${JSON.stringify(l)}`).toBe(false);
    }
  });

  it('falls back to the desk column when no aisle is clear on both legs', () => {
    // A blocker sitting on the desk's own row and in every candidate column:
    // no sidestep is clean, so the route keeps the old straight-down column.
    const dest = { x: 100, y: 200, w: 400, h: 160 };
    const across = { x: 290, y: 230, w: 60, h: 300 };
    const d = { x: 300, y: 240 };
    const p = entryRoute(d, null, false, H, [dest, across]);
    for (const l of p.legs) expect(l.x0 === d.x || l.y0 === l.y1).toBe(true);
  });

  it('approachX finds a clear aisle even when the point sits off any obstacle', () => {
    // approachX's dest lookup can come up empty (the point has no rug of its
    // own) — the candidate list is then just the blockers' edges, no dest.
    const blocker = { x: 280, y: 250, w: 60, h: 100 };
    const point = { x: 300, y: 100 };
    expect(approachX([blocker], point, 400)).toBe(340);
  });

  it('approachX never lands a candidate left of the entry edge', () => {
    // The nearest edge candidate can fall off the left of the floor (a wide
    // obstacle hugging x=0) — ENTRY_X filters it out before scoring, even
    // though it would otherwise win on distance.
    const blocker = { x: -2, y: 250, w: 100, h: 100 };
    const point = { x: 5, y: 100 };
    expect(approachX([blocker], point, 400)).toBe(98);
  });

  it('the sidestep keeps off the colleagues sharing the pod rug', () => {
    // The rug is one rect over the whole pod, so it is the walker's own floor
    // and cannot block. The desks in it can, and must: with only the rug in
    // the list the nearest clear column is 168, and stepping there sweeps the
    // pod row straight across the colleague sitting at 116.
    const rug = { x: 100, y: 200, w: 400, h: 160 };
    const mine = { x: 236, y: 216, w: 96, h: 108 };
    const mate = { x: 116, y: 216, w: 96, h: 108 };
    const lower = { x: 200, y: 380, w: 360, h: 160 };
    const d = { x: 250, y: 240 };
    const p = entryRoute(d, null, false, H, [rug, mine, mate, lower]);
    // A real detour (it goes the other way, to 560), not the straight-down
    // fallback: nothing on the route touches the colleague or the far rug.
    expect(p.legs.length).toBe(3);
    for (const l of p.legs)
      for (const [name, box] of [['colleague', mate], ['rug below', lower]])
        expect(overlaps(swept(l), box), `${name}, leg ${JSON.stringify(l)}`).toBe(false);
    // The other half of that rule: the walker's OWN desk is floor it is
    // standing on, so with the way below clear it walks straight down rather
    // than sidestepping around its own chair.
    expect(approachX([rug, mine], d, 500)).toBe(d.x);
  });

  it('never picks a column that hangs the walker off the right edge', () => {
    // The candidate edges come from the obstacles, so a rug reaching the panel
    // edge offers a column with no room for the 32px walker beside it.
    const rug = { x: 100, y: 200, w: 400, h: 160 };
    const lower = { x: 60, y: 380, w: 480, h: 160 }; // ends at 540, panel is 560
    const d = { x: 300, y: 240 };
    expect(approachX([rug, lower], d, 600, 560) + CHAR_W).toBeLessThanOrEqual(560);
    expect(approachX([rug, lower], d, 600)).toBe(540); // unclamped, for contrast
  });

  it('breaks a tie toward wherever the crossing leg is headed', () => {
    // Two clear columns the same distance out; the walker leaves at the left
    // edge, so stepping right means walking back over the same ground.
    const blocker = { x: 268, y: 300, w: 64, h: 100 };
    const d = { x: 284, y: 100 };
    expect(approachX([blocker], d, 500, Infinity, 3)).toBe(236);      // toward the entrance
    expect(approachX([blocker], d, 500, Infinity, 900)).toBe(332);    // toward a right-hand lane
  });

  it('the wander route to a conference seat takes the same clear aisle', () => {
    // The descent to the table used the desk column too, with the same result:
    // straight over whatever sat between the desk and the conference corridor.
    const conf = { table: { x: 300, y: 500, w: 200, h: 100 } };
    const blocker = { x: 60, y: 330, w: 500, h: 90 };
    const desk = { x: 300, y: 240 };
    const seat = { x: 250, y: 520, row: 99 }; // a side seat, not the head
    for (const toSeat of [true, false]) {
      const p = wanderRoute(desk, seat, conf, toSeat, [blocker]);
      for (const l of p.legs)
        expect(overlaps(swept(l), blocker), `${toSeat ? 'to' : 'from'} leg ${JSON.stringify(l)}`).toBe(false);
    }
  });

  it('crosses on the desk row, not the bottom edge, when no row is clear', () => {
    const full = [{ x: 0, y: 0, w: W, h: H }];
    const p = entryRoute(desk, null, false, H, full);
    const across = crossingLeg(p);
    expect(across.y0).toBe(desk.y);
    expect(across.y0).not.toBe(H - CHAR_H); // the chat furniture lives there
  });
});

describe('dispatch detection', () => {
  const prev = new Map([
    ['j1', { state: 'todo', agentSessionId: null }],
    ['j2', { state: 'review', agentSessionId: 's2' }],
    ['j3', { state: 'in-progress', agentSessionId: 's3' }],
  ]);

  it('flags a todo job dispatched to a new agent, naming its column', () => {
    const out = detectDispatches(prev, [
      { id: 'j1', state: 'in-progress', agentSessionId: 's-new' },
    ]);
    expect(out).toEqual([{ jobId: 'j1', sessionId: 's-new', fromState: 'todo' }]);
  });

  it('ignores a manual move that keeps the same agent', () => {
    const out = detectDispatches(prev, [
      { id: 'j2', state: 'in-progress', agentSessionId: 's2' },
    ]);
    expect(out).toEqual([]);
  });

  it('ignores unchanged in-progress jobs, agentless ones, and null entries', () => {
    const out = detectDispatches(prev, [
      { id: 'j3', state: 'in-progress', agentSessionId: 's3' },
      { id: 'j4', state: 'in-progress', agentSessionId: null },
      { id: 'j5', state: 'todo', agentSessionId: null },
      null,
    ]);
    expect(out).toEqual([]);
  });

  it('names the column a re-dispatched job came from', () => {
    const out = detectDispatches(prev, [
      { id: 'j2', state: 'in-progress', agentSessionId: 's-new' },
    ]);
    expect(out).toEqual([{ jobId: 'j2', sessionId: 's-new', fromState: 'review' }]);
  });

  it('treats a brand-new in-progress job as dispatched from To do', () => {
    const out = detectDispatches(prev, [
      { id: 'j9', state: 'in-progress', agentSessionId: 's9' },
    ]);
    expect(out).toEqual([{ jobId: 'j9', sessionId: 's9', fromState: 'todo' }]);
  });
});

// The note* functions keep module-level state (sync flag, anim queues), so
// each test re-imports office.js fresh; the terminal.js mock above survives
// vi.resetModules.
async function freshMotion() {
  vi.resetModules();
  const office = await import('../public/modules/office.js');
  const state = await import('../public/modules/state.js');
  return { office, state };
}

describe('motion state', () => {
  it('starts idle and ignores arrivals during the connect sync', async () => {
    const { office } = await freshMotion();
    expect(office.hasMotion()).toBe(false);
    office.noteAgentArrival('s1'); // before the first jobs-list
    expect(office.hasMotion()).toBe(false);
  });

  it('queues a walk-in for an arrival after the first jobs-list', async () => {
    const { office } = await freshMotion();
    office.noteJobsUpdate(); // connect sync complete
    expect(office.hasMotion()).toBe(false);
    office.noteAgentArrival('s1');
    expect(office.hasMotion()).toBe(true);
  });

  it('treats the first jobs update as a baseline and a later dispatch as motion', async () => {
    const { office, state } = await freshMotion();
    state.jobs.set('j1', { id: 'j1', state: 'todo', agentSessionId: null });
    office.noteJobsUpdate();
    expect(office.hasMotion()).toBe(false); // pre-existing jobs don't animate
    state.jobs.set('j1', { id: 'j1', state: 'in-progress', agentSessionId: 's1' });
    office.noteJobsUpdate();
    expect(office.hasMotion()).toBe(true); // dispatch paper queued
  });

  it('ignores departures for unknown or disconnected agents, or with no panel', async () => {
    const { office, state } = await freshMotion();
    office.noteAgentDeparture('ghost'); // not in the agent map
    state.agents.set('sd', { state: 'DISCONNECTED' });
    office.noteAgentDeparture('sd'); // already gone from the floor
    state.agents.set('sa', { state: 'WORKING' });
    office.noteAgentDeparture('sa'); // no #office-canvas in this DOM
    expect(office.hasMotion()).toBe(false);
  });
});

// The panel is a flex column with .office-header above the canvas, so a
// panel-sized canvas overflowed the bottom and clipped the sofa and plants.
// Both sizing paths must read the canvas's own CSS box, never the panel's.
function canvasDom(w = 600, h = 400) {
  document.body.innerHTML =
    '<div id="office-panel"><div class="office-header"></div><canvas id="office-canvas"></canvas></div>';
  const panel = document.getElementById('office-panel');
  const canvas = document.getElementById('office-canvas');
  const dim = (el, props) => {
    for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { value: v, configurable: true });
  };
  dim(panel, { offsetWidth: 900, offsetHeight: 700 });
  dim(canvas, { clientWidth: w, clientHeight: h });
  // happy-dom has no 2D context; every call is a no-op that returns the ctx
  // (so chained results like createLinearGradient().addColorStop still work).
  const ctx = new Proxy({}, { get: () => () => ctx, set: () => true });
  canvas.getContext = () => ctx;
  return { panel, canvas };
}

describe('canvas sizing', () => {
  it('renderOffice sizes the backing store from the canvas box, not the panel', async () => {
    const { office } = await freshMotion();
    const { canvas } = canvasDom();
    window.devicePixelRatio = 2;
    office.renderOffice();
    expect(canvas.width).toBe(600 * 2);
    expect(canvas.height).toBe(400 * 2);
    expect(canvas.style.width).toBe('');
    expect(canvas.style.height).toBe('');
  });

  it('noteAgentDeparture lays out from the canvas box and queues a walk-out', async () => {
    const { office, state } = await freshMotion();
    canvasDom();
    state.agents.set('sa', { state: 'WORKING', repoPath: '/r', repoSlug: 'r' });
    office.noteAgentDeparture('sa');
    expect(office.hasMotion()).toBe(true);
  });

  it('keeps the last real size while the canvas is hidden (diff viewer)', async () => {
    const { office, state } = await freshMotion();
    const { canvas } = canvasDom();
    window.devicePixelRatio = 1;
    office.renderOffice(); // learns 600x400
    Object.defineProperty(canvas, 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 0, configurable: true });
    office.renderOffice();
    expect(canvas.width).toBe(600); // not collapsed to 0x0
    state.agents.set('sa', { state: 'WORKING', repoPath: '/r', repoSlug: 'r' });
    office.noteAgentDeparture('sa');
    expect(office.hasMotion()).toBe(true); // walk-out captured from the remembered room
  });

  it('renders nothing before the first layout', async () => {
    const { office } = await freshMotion();
    const { canvas } = canvasDom();
    Object.defineProperty(canvas, 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 0, configurable: true });
    office.renderOffice();
    expect(canvas.width).toBe(300); // untouched default
  });
});

// Idle wander: driven entirely through renderOffice on a canvas tall enough
// for the conference set to place (one pod row + spares end at y≈507; the
// set needs 326px of band above the chat areas, so 1000px works).
describe('idle wander', () => {
  const seatIdle = async () => {
    const ctx = await freshMotion();
    canvasDom(600, 1000);
    ctx.office.noteJobsUpdate(); // connect sync complete — anims may play
    ctx.state.agents.set('si', { state: 'IDLE', repoPath: '/r', repoSlug: 'r' });
    ctx.office.renderOffice();
    return ctx;
  };

  it('does not animate pre-existing idle agents during the connect replay', async () => {
    const { office, state } = await freshMotion();
    canvasDom(600, 1000);
    state.agents.set('si', { state: 'IDLE', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice(); // before the first jobs-list: seat claimed silently
    expect(office.hasMotion()).toBe(false);
  });

  it('walks an idle agent toward a conference seat after the sync', async () => {
    const { office } = await seatIdle();
    expect(office.hasMotion()).toBe(true); // wander anim keeps the loop alive
  });

  it('snaps back without a return walk when a job lands mid-walk', async () => {
    const { office, state } = await seatIdle();
    state.agents.set('si', { state: 'WORKING', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice();
    expect(office.hasMotion()).toBe(false); // no teleport-to-seat-then-walk
  });

  it('walks a seated agent back to its desk when its state changes', async () => {
    const { office, state } = await seatIdle();
    const t0 = performance.now();
    const spy = vi.spyOn(performance, 'now').mockReturnValue(t0 + 60000);
    office.renderOffice(); // walk completes — agent is now seated
    expect(office.hasMotion()).toBe(false);
    state.agents.set('si', { state: 'WORKING', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice();
    expect(office.hasMotion()).toBe(true); // walk back to the desk
    spy.mockRestore();
  });

  it('queues a walk-out for a departing sitter', async () => {
    const { office, state } = await seatIdle();
    const t0 = performance.now();
    const spy = vi.spyOn(performance, 'now').mockReturnValue(t0 + 60000);
    office.renderOffice(); // seated
    spy.mockRestore();
    state.agents.set('si', { state: 'IDLE', repoPath: '/r', repoSlug: 'r' });
    office.noteAgentDeparture('si');
    expect(office.hasMotion()).toBe(true); // walk-out, from the seat
  });
});

// Walk in/out: drawn through renderOffice on the same 1000px-tall canvas as
// the wander, so the route bends around a placed conference set.
describe('walk in/out', () => {
  const later = (ms) => { const t0 = performance.now(); return vi.spyOn(performance, 'now').mockReturnValue(t0 + ms); };

  it('walks a new agent in to its desk, and gives up on one that never reaches the floor', async () => {
    const { office, state } = await freshMotion();
    canvasDom(600, 1000);
    office.noteJobsUpdate(); // connect sync complete
    office.noteAgentArrival('s1');
    office.noteAgentArrival('ghost');
    office.renderOffice(); // no desks yet — both walks wait for the agent map
    expect(office.hasMotion()).toBe(true);
    state.agents.set('s1', { state: 'WORKING', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice(); // s1's route resolves and the walk starts
    expect(office.hasMotion()).toBe(true);
    const spy = later(60000);
    office.renderOffice(); // s1 arrived; ghost waited past its 4s grace
    spy.mockRestore();
    expect(office.hasMotion()).toBe(false);
  });

  it('walks a departing agent out to the entrance and clears the floor', async () => {
    const { office, state } = await freshMotion();
    canvasDom(600, 1000);
    office.noteJobsUpdate();
    state.agents.set('sa', { state: 'WORKING', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice(); // seated at its desk, conference set placed
    office.noteAgentDeparture('sa');
    state.agents.delete('sa'); // desk gone; the walk-out keeps its captured start
    office.renderOffice();
    expect(office.hasMotion()).toBe(true);
    const spy = later(60000);
    office.renderOffice();
    spy.mockRestore();
    expect(office.hasMotion()).toBe(false);
  });
});

// A walk's route is frozen when it starts: an unrelated agent spawning
// mid-stride changes the obstacles, and recomputing the path every frame
// re-projected the walker (distance advances on wall-clock time, so a longer
// route moves it a desk over) instead of leaving it where it was walking.
describe('frozen walk routes', () => {
  // drawWalker bails without a loaded sheet, so make sprites load instantly
  // and read the walker's position back off drawImage.
  const walkingOffice = async () => {
    vi.resetModules();
    vi.stubGlobal('Image', class { set src(v) { this.src_ = v; this.onload?.(); } });
    const office = await import('../public/modules/office.js');
    const state = await import('../public/modules/state.js');
    const { canvas } = canvasDom(900, 800);
    const drawn = [];
    const ctx = new Proxy({}, {
      get: (_t, k) => k === 'drawImage'
        ? (img, ...a) => { if (String(img.src_).includes('char')) drawn.push({ x: a[4], y: a[5] }); }
        : () => ctx,
      set: () => true,
    });
    canvas.getContext = () => ctx;
    // The walker is drawn last (the overlay pass runs after the seated one),
    // so the final char sprite of a frame is the one walking.
    const frameAt = (ms) => {
      drawn.length = 0;
      const spy = vi.spyOn(performance, 'now').mockReturnValue(ms);
      office.renderOffice();
      spy.mockRestore();
      return drawn.at(-1);
    };
    return { office, state, frameAt };
  };

  it('keeps a walker on its route when other agents spawn mid-walk', async () => {
    const { office, state, frameAt } = await walkingOffice();
    office.noteJobsUpdate(); // connect sync complete
    office.noteAgentArrival('a2');
    state.agents.set('a1', { state: 'WORKING', repoPath: '/r1', repoSlug: 'r1' });
    state.agents.set('a2', { state: 'WORKING', repoPath: '/r2', repoSlug: 'r2' });
    frameAt(0); // the route resolves and the walk starts
    const before = frameAt(1000);
    expect(before).toBeDefined();

    // Six more agents across both repos: the pods reflow, the obstacle set
    // grows and the corridor row and approach column both move.
    for (let i = 3; i <= 8; i++) {
      state.agents.set('a' + i, { state: 'WORKING', repoPath: i % 2 ? '/r1' : '/r2', repoSlug: i % 2 ? 'r1' : 'r2' });
    }
    expect(frameAt(1000)).toEqual(before); // same elapsed time, same spot
    expect(office.hasMotion()).toBe(true); // still mid-walk, not clamped at the end
  });

  it('rebuilds the route when the canvas resizes mid-walk', async () => {
    const { office, state, frameAt } = await walkingOffice();
    office.noteJobsUpdate();
    office.noteAgentArrival('a2');
    state.agents.set('a1', { state: 'WORKING', repoPath: '/r1', repoSlug: 'r1' });
    state.agents.set('a2', { state: 'WORKING', repoPath: '/r2', repoSlug: 'r2' });
    frameAt(0);
    const before = frameAt(1000);

    const canvas = document.getElementById('office-canvas');
    Object.defineProperty(canvas, 'clientHeight', { value: 1000, configurable: true });
    const after = frameAt(1000);
    expect(after).toBeDefined();
    expect(after).not.toEqual(before); // the room really did change — relay out
  });
});
