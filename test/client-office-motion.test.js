// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';

// canvasDom() writes document.body and the sprite harnesses stubGlobal('Image');
// neither is undone, so a test that needs NO #office-canvas (or unloaded
// sprites) passes in file order and fails under --sequence.shuffle.tests.
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { entryRoute, corridorY, pointAlongPath, detectDispatches, approachX, wanderRoute, wanderSeats, chatSeats, computeDecorPlacement, computePodLayout, podRugRect, computeSpareDesks, computeConference, walkObstacles, CHAR_COL_SIT, CHAR_FRAME_W } =
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

  it('walks a WAITING agent too, not just an IDLE one', async () => {
    // Every TUI agent short-circuits to WAITING in detectState, so gating the
    // wander on IDLE alone meant it never fired for the agents this board
    // actually spawns.
    const { office, state } = await freshMotion();
    canvasDom(600, 1000);
    office.noteJobsUpdate();
    state.agents.set('si', { state: 'WAITING', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice();
    expect(office.hasMotion()).toBe(true);
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

describe('sofa seats', () => {
  // 1440x900 is an ordinary laptop canvas: the band between the desks and the
  // chat areas is too short for the conference set (it needs ~972px), so the
  // sofas are the only place an idle agent has to go.
  const W = 1440, H = 900;

  it('offers the sofas when the canvas is too short for a conference table', () => {
    const decor = computeDecorPlacement([], W, H);
    const chats = decor.filter(d => d.kind === 'chat');
    expect(chats.length).toBe(2);
    const seats = wanderSeats(null, decor);
    expect(seats.length).toBe(6); // three per chat area
    expect(seats.every(s => s.kind === 'chat')).toBe(true);
  });

  it('pools the sofas with the conference seats when both are there', () => {
    const decor = computeDecorPlacement([], W, H);
    const conf = { seats: [{ x: 1, y: 2, row: 0 }, { x: 3, y: 4, row: 2 }] };
    const seats = wanderSeats(conf, decor);
    expect(seats.map(s => s.kind)).toEqual(['conf', 'conf', ...Array(6).fill('chat')]);
  });

  it('sits each sitter on a sofa, not on the rug or the coffee table', () => {
    // drawDecor's own layout math, repeated here so a change to it that moves
    // the sofas out from under the sitters fails rather than silently drifts.
    const D = 2, SOFA_W = 16 * D, SOFA_H = 32 * D, SOFA_FRONT_H = 16 * D, TABLE_W = 32 * D, TABLE_H = 32 * D;
    const PAD_X = 13, PAD_TOP = 14, GAP = 8;
    const spot = computeDecorPlacement([], W, H).find(d => d.kind === 'chat');
    const tx = spot.x + PAD_X + SOFA_W + GAP, ty = spot.y + PAD_TOP + SOFA_FRONT_H + GAP;
    const sy = ty + TABLE_H - SOFA_H - D;
    const sofas = [
      { x: tx, y: spot.y + PAD_TOP, w: TABLE_W, h: SOFA_FRONT_H },   // front, far side
      { x: spot.x + PAD_X, y: sy, w: SOFA_W, h: SOFA_H },            // left
      { x: tx + TABLE_W + GAP, y: sy, w: SOFA_W, h: SOFA_H },        // right
    ];
    const seats = chatSeats(spot);
    seats.forEach((seat, i) => {
      const body = { x: seat.x, y: seat.y, w: CHAR_W, h: CHAR_H };
      expect(overlaps(body, sofas[i]), `sitter ${i} is not on its sofa`).toBe(true);
      // Centred on it horizontally, so nobody perches on an armrest.
      expect(seat.x + CHAR_W / 2).toBe(sofas[i].x + sofas[i].w / 2);
    });
    expect(seats[2].mirror).toBe(true);              // right sofa faces back in
    expect(seats[0].y).toBeLessThan(seats[1].y);     // front sofa is the far one
    // ...and sits high enough on it to clear the coffee table below. The
    // seated frame's art starts 4px lower in its box than the standing one's,
    // so reusing the side sofas' offset dropped this body onto the tabletop.
    expect(seats[0].y + CHAR_H, 'the front sitter spills onto the coffee table').toBeLessThanOrEqual(ty);
  });

  // Built the way renderOffice builds them: pod rugs, spare desks, occupied
  // desks and the conference bbox, not just the chat rugs. The earlier version
  // of this test passed `decor` alone and omitted panelHeight, so it never
  // routed past a rug and never exercised corridorY's clamp -- far narrower
  // than its name. Both canvas sizes matter: at 900 there is no conference set
  // and the sofas are the only seats, at 1000 a sofa route has to cross the
  // whole room above a conference set that is in the way.
  for (const [w, h] of [[600, 900], [600, 1000]]) {
    it(`routes to a sofa without walking over the furniture at ${w}x${h}`, () => {
      const { pods, positions } = computePodLayout([{ id: 'a', repoPath: '/r', slug: 'r' }], w, h);
      const rugs = pods.map(podRugRect);
      const decor = computeDecorPlacement(rugs, w, h);
      const spares = computeSpareDesks(pods, decor, w, h);
      const conf = computeConference(rugs, spares, decor, w, h);
      const obstacles = walkObstacles(rugs, decor, spares, conf, [...positions.values()]);
      const chats = decor.filter(d => d.kind === 'chat');
      const sofas = wanderSeats(conf, decor).filter(s => s.kind === 'chat');
      expect(sofas.length).toBeGreaterThan(0);
      const desk = positions.get('a');
      for (const seat of sofas) {
        // The seat's own chat area is the destination: the descent lands in it
        // and, when corridorY can only find a standable row above the
        // conference set, that descent is a long one that finishes inside the
        // rug. Every OTHER chat area is furniture and must stay unswept.
        const own = chats.find(c => seat.x >= c.x && seat.x < c.x + c.w);
        const others = chats.filter(c => c !== own);
        expect(own, 'every sofa seat belongs to a chat area').toBeTruthy();
        const p = wanderRoute(desk, seat, conf, true, obstacles, w, h);
        for (const l of p.legs)
          for (const o of others)
            expect(overlaps(swept(l), o),
              `${w}x${h} leg ${l.x0},${l.y0}-${l.x1},${l.y1} crosses the other chat area`).toBe(false);
      }
    });
  }

  it('walks a resting agent to a sofa at a canvas with no conference table', async () => {
    const { office, state } = await freshMotion();
    canvasDom(W, H);
    office.noteJobsUpdate();
    state.agents.set('si', { state: 'WAITING', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice();
    expect(office.hasMotion()).toBe(true);
  });
});

// The sofas are the seats that always exist (the conference set needs ~972px
// of canvas height), so these drive the wander on an ordinary 1440x900 laptop
// canvas where computeConference returns null.
describe('sofa wander', () => {
  const W = 1440, H = 900;

  // Like the frozen-route harness above, but the recorded draws are read as a
  // whole frame rather than just its last walker: sofa sitters go down before
  // the desk pass. The filter is the characters/ folder, not 'char' — the
  // conference CHAIR sprites match that too. Mirrored sitters draw through a
  // canvas transform, so they land at 0,0: count them, never place them.
  const sofaOffice = async (w = W, h = H) => {
    vi.resetModules();
    vi.stubGlobal('Image', class { set src(v) { this.src_ = v; this.onload?.(); } });
    const office = await import('../public/modules/office.js');
    const state = await import('../public/modules/state.js');
    const { canvas } = canvasDom(w, h);
    const drawn = [];
    const ctx = new Proxy({}, {
      get: (_t, k) => k === 'drawImage'
        ? (img, ...a) => { if (String(img.src_).includes('characters/')) drawn.push({ x: a[4], y: a[5], col: a[0] / CHAR_FRAME_W }); }
        : () => ctx,
      set: () => true,
    });
    canvas.getContext = () => ctx;
    const at = (ms, fn) => {
      const spy = vi.spyOn(performance, 'now').mockReturnValue(ms);
      try { return fn(); } finally { spy.mockRestore(); }
    };
    const frameAt = (ms) => at(ms, () => { drawn.length = 0; office.renderOffice(); return drawn.slice(); });
    return { office, state, canvas, at, frameAt };
  };

  // The seat pool renderOffice will build for a given set of agents, from the
  // same exported pieces it uses — so a layout change moves the expectations
  // with it instead of stranding a hardcoded coordinate.
  // Position of a recorded draw. The recorder also carries the sprite-sheet
  // column, which animates between frames, so comparing whole records across
  // frames is brittle — compare this instead.
  const posOf = d => ({ x: d.x, y: d.y });
  const seatsFor = (ids, w = W, h = H) => {
    const layout = computePodLayout(ids.map(id => ({ id, repoPath: '/r', slug: 'r' })), w, h);
    const decor = computeDecorPlacement(layout.pods.map(podRugRect), w, h);
    return { layout, decor, seats: wanderSeats(null, decor) };
  };

  it('drops in-flight claims when the seat list changes shape', async () => {
    // Seat indices address the pool, so the conference set vanishing on a
    // resize (12 seats -> the 6 sofas) must not leave a claim pointing at a
    // seat that is now someone else's. The walker restarts from its desk.
    const { office, state, frameAt } = await sofaOffice(600, 1000);
    office.noteJobsUpdate();
    state.agents.set('si', { state: 'WAITING', repoPath: '/r', repoSlug: 'r' });
    const desk = frameAt(0).at(-1);       // route resolves; walker still at the desk
    const moved = frameAt(3000);
    expect(posOf(moved.at(-1))).not.toEqual(posOf(desk)); // genuinely mid-walk to a conference seat

    const canvas = document.getElementById('office-canvas');
    Object.defineProperty(canvas, 'clientHeight', { value: 900, configurable: true });
    // Same wall clock as the mid-walk frame: only a cleared claim (and the
    // fresh anim that replaces it) puts the walker back at its desk.
    expect(posOf(frameAt(3000).at(-1))).toEqual(posOf(desk));
  });

  it('waits for an agent to be quiet a while before sending it off', async () => {
    // WAITING is not "at rest": detectState flips WORKING -> WAITING after 3s
    // of silence, and a walk to a seat takes 7-11s at WALK_SPEED. Without a
    // dwell window an agent that paused to think starts a walk, gets output,
    // and snaps back to its desk -- jittering forever and never arriving.
    const { office, state, frameAt } = await sofaOffice();
    office.noteJobsUpdate();
    state.agents.set('si', { state: 'WAITING', repoPath: '/r', repoSlug: 'r', lastOutputAt: Date.now() });
    frameAt(0);
    expect(office.hasMotion(), 'a briefly-quiet agent left its desk').toBe(false);

    // Quiet past the window the board already calls "stalled": now it goes.
    state.agents.get('si').lastOutputAt = Date.now() - 4 * 60 * 1000;
    frameAt(0);
    expect(office.hasMotion(), 'a long-quiet agent stayed put').toBe(true);
  });

  it('leaves an agent blocked on a question, or gone, at its desk', async () => {
    // The whole reason lib/helpers.js widens MESSAGE_PATTERNS in this same
    // change: a question-blocked agent must read MESSAGE, not WAITING, or it
    // strolls off to a sofa while its desk stands empty. Pin both non-resting
    // states out of the gate, or that pairing can silently come apart.
    for (const state_ of ['MESSAGE', 'DISCONNECTED']) {
      const { seats } = seatsFor(['si']);
      const { office, state, frameAt } = await sofaOffice();
      office.noteJobsUpdate();
      state.agents.set('si', { state: state_, repoPath: '/r', repoSlug: 'r' });
      const frame = frameAt(0);
      expect(office.hasMotion(), `${state_} started a wander`).toBe(false);
      for (const seat of seats)
        expect(frame.some(d => d.x === seat.x && d.y === seat.y),
          `${state_} agent drawn on a sofa`).toBe(false);
    }
  });

  it('seats as many agents as there are sofas and leaves the rest at their desks', async () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    const { layout, seats } = seatsFor(ids);
    expect(seats).toHaveLength(6); // six sofas, seven agents

    const { office, state, at, frameAt } = await sofaOffice();
    for (const id of ids) state.agents.set(id, { state: 'IDLE', repoPath: '/r', repoSlug: 'r' });
    frameAt(0); // connect replay: claims are silent, everyone is already in place
    expect(office.hasMotion()).toBe(false);

    // The seventh never got a seat, so its walk-out starts at its own desk.
    at(5000, () => office.noteAgentDeparture('a7'));
    state.agents.delete('a7');
    const start = frameAt(5000).at(-1);
    const pos = layout.positions.get('a7');
    expect(start.x).toBeGreaterThanOrEqual(pos.x);
    expect(start.x).toBeLessThan(pos.x + 32 * 3);
    expect(start.y).toBeGreaterThanOrEqual(pos.y);
    expect(start.y).toBeLessThan(pos.y + 36 * 3);
    expect(seats.some(s => s.x === start.x && s.y === start.y)).toBe(false);
  });

  it('walks a departing sitter out from the sofa it is on', async () => {
    const ids = ['a1', 'a2'];
    const { seats } = seatsFor(ids);
    const { office, state, at, frameAt } = await sofaOffice();
    for (const id of ids) state.agents.set(id, { state: 'IDLE', repoPath: '/r', repoSlug: 'r' });
    frameAt(0); // seated on the first two sofas

    at(5000, () => office.noteAgentDeparture('a1'));
    state.agents.delete('a1');
    expect(posOf(frameAt(5000).at(-1))).toEqual({ x: seats[0].x, y: seats[0].y });
  });

  it('draws an arrived sitter on its sofa, and nothing there while it walks over', async () => {
    const { seats } = seatsFor(['si']);
    const onSofa = f => f.some(d => d.x === seats[0].x && d.y === seats[0].y);

    const seated = await sofaOffice();
    seated.state.agents.set('si', { state: 'WAITING', repoPath: '/r', repoSlug: 'r' });
    expect(onSofa(seated.frameAt(0))).toBe(true);  // connect replay: straight to the sofa
    expect(seated.office.hasMotion()).toBe(false);

    const walking = await sofaOffice();
    walking.office.noteJobsUpdate();
    walking.state.agents.set('si', { state: 'WAITING', repoPath: '/r', repoSlug: 'r' });
    const frame = walking.frameAt(0);
    expect(walking.office.hasMotion()).toBe(true);
    expect(onSofa(frame)).toBe(false); // still mid-wander — only the walker draws
    expect(frame).toHaveLength(1);
  });

  it('walks back from a sofa along the same route, reversed', async () => {
    // The walk back rebuilds from a synthetic seat carrying the sofa's own
    // lane and crossing row. Without them there is nothing to fall back on:
    // the conference table it would derive them from is null at this size.
    const decor = computeDecorPlacement([], W, H);
    const seats = wanderSeats(null, decor);
    const desk = { x: 300, y: FLOOR_TOP + 20 };
    for (const seat of seats) {
      const there = wanderRoute(desk, seat, null, true, decor, W, H);
      const from = { x: seat.x, y: seat.y, row: seat.row, lane: seat.lane, yPref: seat.yPref };
      const back = wanderRoute(desk, from, null, false, decor, W, H);
      expect(back.from).toEqual({ x: seat.x, y: seat.y });
      expect(back.legs).toEqual(
        [...there.legs].reverse().map(l => ({ x0: l.x1, y0: l.y1, x1: l.x0, y1: l.y0 })));
      // Load-bearing, not decoration: strip them and the route changes. It must
      // NOT throw, though — wanderRoute is called from inside the rAF loop, so
      // a TypeError here takes the whole office render down, not one walker.
      const stripped = wanderRoute(desk, { x: seat.x, y: seat.y, row: seat.row }, null, false, decor, W, H);
      expect(stripped.legs).not.toEqual(back.legs);
    }
  });

  it('draws an arrived sitter in the seated frame, not the standing one', async () => {
    // The standing frame (col 1) has legs and feet, so a sitter drawn with it
    // reads as standing ON the sofa. Columns 3-6 are the seated frames — torso
    // only, flat bottom — which is what the desk pass already uses for a
    // seated agent. Nothing asserted the frame before, so the wrong one shipped.
    const { seats } = seatsFor(['si']);
    const { office, state, frameAt } = await sofaOffice();
    office.noteJobsUpdate();
    state.agents.set('si', { state: 'WAITING', repoPath: '/r', repoSlug: 'r', lastOutputAt: 0 });
    frameAt(0);
    frameAt(60000);                // the frame the walk completes on
    const seated = frameAt(60000); // drawChatSitters runs before drawMotion, so
                                   // the sitter first appears the frame after
    const onSeat = seated.filter(d => seats.some(s => s.x === d.x && s.y === d.y));
    expect(onSeat.length, 'nobody drawn on a sofa').toBeGreaterThan(0);
    for (const d of onSeat)
      expect(d.col, `sitter drawn with frame column ${d.col}, wanted the seated one`).toBe(3);
  });

  it('walks a sofa sitter back to its desk when it starts working', async () => {
    const { office, state } = await freshMotion();
    canvasDom(W, H);
    office.noteJobsUpdate();
    state.agents.set('si', { state: 'WAITING', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice();
    const t0 = performance.now();
    let spy = vi.spyOn(performance, 'now').mockReturnValue(t0 + 60000);
    office.renderOffice(); // arrived on the sofa
    spy.mockRestore();
    expect(office.hasMotion()).toBe(false);

    state.agents.set('si', { state: 'WORKING', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice();
    expect(office.hasMotion()).toBe(true); // no conference table needed to route home
    spy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60000);
    office.renderOffice();
    spy.mockRestore();
    expect(office.hasMotion()).toBe(false); // and it gets there
  });

  it('leaves everyone at their desks when the room fits no seat at all', async () => {
    expect(wanderSeats(null, [])).toEqual([]);
    expect(wanderSeats(null, [{ kind: 'cactus', x: 0, y: 0 }])).toEqual([]);
    const { office, state } = await freshMotion();
    canvasDom(300, 300); // one tall rug, no chat areas, no conference set
    office.noteJobsUpdate();
    state.agents.set('si', { state: 'IDLE', repoPath: '/r', repoSlug: 'r' });
    office.renderOffice();
    expect(office.hasMotion()).toBe(false);
  });

  it('carries each sofa its own approach, and keeps the conference seats indexed', () => {
    const spot = computeDecorPlacement([], W, H).find(d => d.kind === 'chat');
    for (const s of chatSeats(spot)) {
      expect(s.kind).toBe('chat');
      expect(s.lane).toBe(s.x);        // the seat's own column — nothing stands over it
      expect(s.yPref).toBe(spot.y - 24); // cross just above the rug, not through it
    }
    const conf = { seats: [{ x: 1, y: 2, row: 0 }, { x: 3, y: 4, row: 2 }] };
    const pooled = wanderSeats(conf, [spot]);
    expect(pooled.slice(0, 2)).toEqual([
      { x: 1, y: 2, row: 0, kind: 'conf', confIndex: 0 },
      { x: 3, y: 4, row: 2, kind: 'conf', confIndex: 1 },
    ]);
    // Conference seats stay first, so drawConference's index-keyed draw passes
    // still address conf.seats[i] with the same i.
    expect(pooled.slice(2).every(s => s.kind === 'chat')).toBe(true);
  });

  // The conference set needs ~972px of height, so these use a taller canvas
  // than the sofa tests above — the sofaOffice harness is the same one.
  it('draws the side sitters in the seated frame and the end sitters standing', async () => {
    // Columns 3-6 are the seated frames: torso only, no legs, built for a desk
    // to occlude the lower body. A side sitter needs one — its legs would hang
    // beside the chair otherwise. The head and foot sitters must NOT get one:
    // the tabletop covers the head's legs and the chair-back covers the foot's,
    // and a legless torso there floats.
    const CW = 1440, CH = 1100;
    const ids = ['s0', 's1', 's2', 's3', 's4', 's5'];
    const infos = ids.map(id => ({ id, repoPath: '/r', slug: 'r' }));
    const layout = computePodLayout(infos, CW, CH);
    const rugs = layout.pods.map(podRugRect);
    const decor = computeDecorPlacement(rugs, CW, CH);
    const conf = computeConference(rugs, computeSpareDesks(layout.pods, decor, CW, CH), decor, CW, CH);
    expect(conf, 'no conference set on this canvas').not.toBeNull();

    const { office, state, frameAt } = await sofaOffice(CW, CH);
    office.noteJobsUpdate();
    // Seats fill in index order, so agent i takes conference seat i.
    for (const id of ids) state.agents.set(id, { state: 'WAITING', repoPath: '/r', repoSlug: 'r', lastOutputAt: 0 });
    frameAt(0);
    frameAt(60000);
    const seated = frameAt(60000);

    // Head (0) and foot (5) face the viewer/away and keep the standing frame;
    // the unmirrored side seats (1, 3) take the seated one.
    for (const [i, col] of [[0, 1], [1, 3], [3, 3], [5, 1]]) {
      const drawn = seated.filter(d => d.x === conf.seats[i].x && d.y === conf.seats[i].y);
      expect(drawn.length, `nobody drawn on conference seat ${i}`).toBe(1);
      expect(drawn[0].col, `seat ${i} drawn with frame column ${drawn[0].col}`).toBe(col);
    }
    // Seats 2 and 4 are mirrored, so they draw through a canvas transform at
    // 0,0 — their column is still recorded, and it is the seated one.
    const mirrored = seated.filter(d => d.x === 0 && d.y === 0);
    expect(mirrored.length, 'the mirrored side sitters are missing').toBe(2);
    for (const d of mirrored) expect(d.col).toBe(3);
  });
});
