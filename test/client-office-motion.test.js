// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { entryPoint, walkPath, pointAlongPath, detectDispatches } =
  await import('../public/modules/office.js');

describe('walk path', () => {
  const from = { x: 100, y: 200 }, to = { x: 40, y: 80 };

  it('entry point sits on the left edge, halfway down the floor', () => {
    const FLOOR_TOP = (36 * 3 + 2 * 3) + 26 * 3, CHAR_H = 64;
    const e = entryPoint(600, 800);
    expect(e.x).toBeGreaterThan(0);
    expect(e.x).toBeLessThan(40);
    expect(e.y).toBe(Math.round((FLOOR_TOP + 800 - CHAR_H) / 2));
  });

  it('is L-shaped with total equal to the manhattan distance', () => {
    for (const verticalFirst of [false, true]) {
      const p = walkPath(from, to, verticalFirst);
      expect(p.legs.length).toBe(2);
      expect(p.total).toBe(60 + 120);
    }
  });

  it('horizontal-first and vertical-first bend at different corners', () => {
    const h = walkPath(from, to, false);
    const v = walkPath(from, to, true);
    expect(h.legs[0].y1).toBe(from.y); // across first
    expect(v.legs[0].x1).toBe(from.x); // down/up first
  });

  it('walks from start to end, clamped at both ends', () => {
    const p = walkPath(from, to, false);
    expect(pointAlongPath(p, -5)).toMatchObject({ x: from.x, y: from.y });
    expect(pointAlongPath(p, p.total + 5)).toMatchObject({ x: to.x, y: to.y });
    // Mid-first-leg: moving left along y=200
    const mid = pointAlongPath(p, 30);
    expect(mid).toMatchObject({ x: 70, y: 200, dx: -1, dy: 0 });
    // On the second leg: moving up along x=40
    const late = pointAlongPath(p, 60 + 30);
    expect(late).toMatchObject({ x: 40, y: 170, dx: 0, dy: -1 });
  });

  it('handles a zero-length path', () => {
    const p = walkPath(from, from, false);
    expect(p.total).toBe(0);
    expect(pointAlongPath(p, 10)).toMatchObject({ x: from.x, y: from.y });
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
