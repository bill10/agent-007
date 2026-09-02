// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { entryRoute, corridorY, pointAlongPath, detectDispatches } =
  await import('../public/modules/office.js');

const FLOOR_TOP = (36 * 3 + 2 * 3) + 26 * 3, CHAR_W = 32, CHAR_H = 64;
// A leg's swept area: the walker box dragged from one end to the other.
const swept = l => ({
  x: Math.min(l.x0, l.x1), y: Math.min(l.y0, l.y1),
  w: Math.abs(l.x1 - l.x0) + CHAR_W, h: Math.abs(l.y1 - l.y0) + CHAR_H,
});
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

  it('has no row to offer on a floor with no gaps', () => {
    expect(corridorY([{ x: 0, y: 0, w: 900, h: H }], H, 400)).toBeNull();
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
      const across = p.legs.find(l => l.y0 === l.y1 && l.x0 !== l.x1);
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

  it('falls back to the old corridor when no row is clear', () => {
    const full = [{ x: 0, y: 0, w: W, h: H }];
    const p = entryRoute(desk, null, false, H, full);
    expect(p.legs.find(l => l.y0 === l.y1 && l.x0 !== l.x1).y0).toBe(H - CHAR_H);
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
