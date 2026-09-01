// Pixel office rendering — canvas drawing, click handling, animation
import { agents, jobs, activeSessionId, canControlAgent } from './state.js';
import { switchToSession } from './terminal.js';

const Z = 3;

const WALL_H = 36 * Z;
const WALL_BOTTOM = WALL_H + 2 * Z;
const WS_W = 32, WS_H = 36, WS_GAP_X = 12, WS_GAP_Y = 18;
// Shared by the agent name labels and the pod rug labels so they stay in step.
const LABEL_FONT = 'bold 11px monospace';

// Persistent dust mote positions (stable across frames)
const DUST_MOTES = [
  { baseX: 0.15, baseY: 0.35, phaseX: 0, phaseY: 0.5 },
  { baseX: 0.45, baseY: 0.25, phaseX: 1.2, phaseY: 2.1 },
  { baseX: 0.70, baseY: 0.40, phaseX: 2.5, phaseY: 0.8 },
  { baseX: 0.30, baseY: 0.30, phaseX: 3.8, phaseY: 3.2 },
  { baseX: 0.85, baseY: 0.20, phaseX: 5.0, phaseY: 1.5 },
];

// Book spine color palette (fixed, theme-independent)
const BOOK_COLORS = [
  '#8b4513', '#2d5a2d', '#4a3a6a', '#6a3030',
  '#2a4a6a', '#6a5a2a', '#4a4a4a', '#d4c8b0',
];

const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

// --- Furniture + character sprites ---
// Desk/Plant: Free Furniture Office Equipment Set by Antea (CC-BY 4.0)
// Characters: pixel-agents (MIT), based on JIK-A-4 "Metro City" pack (CC0).
// Each char sheet is 112×96: 7 columns × 3 rows of 16×32 frames.
// Rows: 0 = facing down (viewer), 1 = facing up (back), 2 = facing right.
// Columns: 0-2 walk cycle (1 = standing), 3-4 seated typing, 5-6 reading.
export const SPRITE_PATHS = {
  plant:   'assets/furniture/plant_big.png',        // 32×32 potted office plant (Antea CC-BY 4.0)
  desk:    'assets/furniture/desk.png',             // 32×32 computer desk with monitor
  desk2:   'assets/furniture/desk2.png',            // 32×32 alt desk layout
  // Ambient decor from pixel-agents (MIT). 16px-tile art, drawn at CHAR_SCALE
  // like the characters — except the plants, drawn at PLANT_SCALE so they read
  // as desk-side decor rather than person-sized furniture.
  cactus:     'assets/furniture/cactus.png',           // 16×32
  plant2:     'assets/furniture/plant_2.png',          // 16×32
  largeplant: 'assets/furniture/large_plant.png',      // 32×48
  sofa:       'assets/furniture/sofa_side.png',        // 16×32, side view facing right
  table:      'assets/furniture/coffee_table.png',     // 32×32
  coffee:     'assets/furniture/coffee.png',           // 16×16, art in the top-right 8×7
  char0:   'assets/characters/char_0.png',
  char1:   'assets/characters/char_1.png',
  char2:   'assets/characters/char_2.png',
  char3:   'assets/characters/char_3.png',
  char4:   'assets/characters/char_4.png',
  char5:   'assets/characters/char_5.png',
};
// Derived from the charN keys above; exported for the character-variant test.
export const CHAR_VARIANTS = Object.keys(SPRITE_PATHS).filter((k) => k.startsWith('char')).length;
const CHAR_FRAME_W = 16, CHAR_FRAME_H = 32;
const CHAR_SCALE = 2; // 16px art in a 32px-tile office — 2x keeps pixels square
const CHAR_ROW_DOWN = 0, CHAR_ROW_UP = 1, CHAR_ROW_RIGHT = 2;
const CHAR_COL_STAND = 1, CHAR_COL_TYPE = 3;
const CHAR_W = CHAR_FRAME_W * CHAR_SCALE, CHAR_H = CHAR_FRAME_H * CHAR_SCALE;

// Deterministic variant per agent id, stable across renders and reorders.
export function charVariant(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % CHAR_VARIANTS;
}
// Desk sprite: monitor part is in top 12 rows — we skip it and draw our own
const DESK_CROP_Y = 13;
// Per-desk-variant positions (in sprite pixels)
const DESK_MON_X = 3;    // Desk.png: monitor at x=3-16, center ~9
const DESK2_MON_X = 13;  // Desk-2.png: monitor at x=13-26, center ~19
const DESK_CHAR_X = 5;   // character X offset for Desk.png (centered on keyboard)
const DESK2_CHAR_X = 15; // character X offset for Desk-2.png
const DESK_CHAR_Y = 13;  // character Y offset below the workstation top (both desks)
const SPRITES = {};
let spritesLoaded = false;

function loadSprites() {
  if (spritesLoaded) return Promise.resolve();
  const promises = Object.entries(SPRITE_PATHS).map(([key, path]) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { SPRITES[key] = img; resolve(); };
      img.onerror = () => { console.warn(`office: sprite failed to load: ${path}`); resolve(); };
      img.src = path;
    });
  });
  return Promise.all(promises).then(() => { spritesLoaded = true; });
}
loadSprites();

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const get = (prop) => style.getPropertyValue(prop).trim();
  const accent = get('--accent') || '#b8bfcc';
  const bgOffice = get('--bg-office') || '#131519';
  const bgDark = get('--bg-dark') || '#090a0c';
  const border = get('--border') || '#1f2228';
  const textDim = get('--text-dim') || '#6b7280';
  const text = get('--text') || '#d8dce4';
  const ar = parseInt(accent.slice(1, 3), 16);
  const ag = parseInt(accent.slice(3, 5), 16);
  const ab = parseInt(accent.slice(5, 7), 16);
  const tr = parseInt(text.slice(1, 3), 16);
  const tg = parseInt(text.slice(3, 5), 16);
  const tb = parseInt(text.slice(5, 7), 16);
  return { accent, text, bgOffice, bgDark, border, textDim, ar, ag, ab, tr, tg, tb };
}

// --- Day/night cycle ---
function getTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 6 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 19) return 'dusk';
  return 'night';
}

function getWindowColors(tod) {
  switch (tod) {
    case 'dawn': return { glass1: '#5a4060', glass2: '#7a5080', beam: 'rgba(255, 200, 150, 0.06)', hasStars: false, hasClouds: false };
    case 'day':  return { glass1: '#7ab5e5', glass2: '#a0d0f5', beam: 'rgba(255, 240, 200, 0.08)', hasStars: false, hasClouds: true };
    case 'dusk': return { glass1: '#5a3060', glass2: '#3a1a50', beam: 'rgba(255, 180, 100, 0.06)', hasStars: false, hasClouds: false };
    default:     return { glass1: '#1a2a4a', glass2: '#2a3a5a', beam: 'rgba(180, 200, 230, 0.06)', hasStars: true, hasClouds: false };
  }
}

// --- Pod layout: per-repo desk clusters anchored near the top of the open
// floor (below the windows + job board zone). Agents on the same repo sit
// together in a pod on a shared rug; different repos are separated by extra
// gap. A single repo yields exactly the old uniform grid. ---
// The boards end well short of FLOOR_TOP (their shadows reach 8 Z below the
// baseboard); the rest is walking room before the first row of desks.
const FLOOR_TOP = WALL_BOTTOM + 26 * Z;
const POD_GAP_X = 20;      // Z units between pods in a row (vs WS_GAP_X=12 within)
const POD_GAP_Y = 26;      // Z units between pod rows (vs WS_GAP_Y=18 within)
const RUG_PAD_X = 4;       // Z units the rug extends past the desks each side
const RUG_PAD_TOP = 7;     // Z units above the desks — the repo label sits here
const RUG_PAD_BOTTOM = 12; // Z units below — covers the agent name labels
const POD_TOP_MARGIN = 8;  // Z units of bare floor between FLOOR_TOP and the first rug

// Pure layout: agentInfos is [{ id, repoPath, slug }] in spawn (map) order.
// Returns { pods, positions } — positions maps id -> { x, y } (top-left px of
// its desk); pods carry the desk-block rect in px plus the repo label.
// Agents with no repo land in a final unlabeled pod. Within a pod agents keep
// their input order, so an unrelated spawn/exit never reshuffles desks inside
// a pod.
// Desks sit in a plain classroom grid, all facing front: every screen stays
// visible to the viewer and the character's facing reads as state (back to
// viewer = working). Agent i takes col i % cols, row floor(i / cols); the row
// pitch keeps a full aisle so a back row never occludes the one in front.
export function computePodLayout(agentInfos, panelWidth, panelHeight) {
  // The rug-padding allowance mirrors panelZ below, so a max-width pod's rug
  // borders don't clip at the panel edges.
  const maxCols = Math.max(1, Math.min(4, Math.floor((panelWidth / Z - 2 * RUG_PAD_X + WS_GAP_X) / (WS_W + WS_GAP_X))));

  // Group by repo, first-appearance order; no-repo pod goes last.
  const groups = new Map();
  for (const a of agentInfos) {
    const key = a.repoPath || '';
    // filter(Boolean) survives trailing slashes; slice caps fillText re-shaping cost
    if (!groups.has(key)) groups.set(key, { label: String(a.slug || (key ? key.split('/').filter(Boolean).pop() : '') || '').slice(0, 40) || null, ids: [] });
    groups.get(key).ids.push(a.id);
  }
  const keys = [...groups.keys()].filter(k => k !== '');
  if (groups.has('')) keys.push('');

  const pods = keys.map(key => {
    const g = groups.get(key);
    const cols = Math.min(g.ids.length, maxCols);
    const rows = Math.ceil(g.ids.length / cols);
    return {
      repoPath: key || null, label: key ? g.label : null, ids: g.ids, cols,
      w: cols * WS_W + (cols - 1) * WS_GAP_X,
      h: rows * WS_H + (rows - 1) * WS_GAP_Y,
    };
  });

  // Flow pods left-to-right, wrap when the row (rug padding included) would
  // overflow the panel — without the padding allowance the outermost rug
  // borders clip at the panel edges on an exactly-full row.
  const panelZ = Math.floor(panelWidth / Z) - 2 * RUG_PAD_X;
  const podRows = [[]];
  let rowW = 0;
  for (const pod of pods) {
    const need = rowW === 0 ? pod.w : rowW + POD_GAP_X + pod.w;
    if (rowW > 0 && need > panelZ) { podRows.push([pod]); rowW = pod.w; }
    else { podRows[podRows.length - 1].push(pod); rowW = need; }
  }

  // Anchor the arrangement near the top of the floor: centering is capped so a
  // sparse office leaves its empty wood at the bottom (decor lives there)
  // instead of as a dead band under the job boards. A nearly-full floor still
  // centers; never start above the floor.
  const rowHs = podRows.map(r => Math.max(0, ...r.map(p => p.h)));
  const totalH = (rowHs.reduce((a, b) => a + b, 0) + (podRows.length - 1) * POD_GAP_Y) * Z;
  const centerOff = Math.floor((panelHeight - FLOOR_TOP - totalH) / 2);
  let y = Math.max(FLOOR_TOP, FLOOR_TOP + Math.min((POD_TOP_MARGIN + RUG_PAD_TOP) * Z, centerOff));

  const outPods = [];
  const positions = new Map();
  for (let ri = 0; ri < podRows.length; ri++) {
    const rowWpx = (podRows[ri].reduce((a, p) => a + p.w, 0) + (podRows[ri].length - 1) * POD_GAP_X) * Z;
    let x = Math.floor((panelWidth - rowWpx) / 2);
    for (const pod of podRows[ri]) {
      pod.ids.forEach((id, i) => {
        positions.set(id, {
          x: x + (i % pod.cols) * (WS_W + WS_GAP_X) * Z,
          y: y + Math.floor(i / pod.cols) * (WS_H + WS_GAP_Y) * Z,
        });
      });
      outPods.push({ repoPath: pod.repoPath, label: pod.label, x, y, w: pod.w * Z, h: pod.h * Z });
      x += pod.w * Z + POD_GAP_X * Z;
    }
    y += (rowHs[ri] + POD_GAP_Y) * Z;
  }
  return { pods: outPods, positions };
}

// The rug drawn under a pod: desk block plus padding for the repo label above
// and the agent name labels below. Also the keep-out zone for ambient decor.
export function podRugRect(pod) {
  return {
    x: pod.x - RUG_PAD_X * Z,
    y: pod.y - RUG_PAD_TOP * Z,
    w: pod.w + 2 * RUG_PAD_X * Z,
    h: pod.h + (RUG_PAD_TOP + RUG_PAD_BOTTOM) * Z,
  };
}

// --- Ambient decor in leftover floor space. Fixed candidate spots (corners
// of the open floor); a spot is kept only if it clears every rug by a margin
// wide enough to also clear the monitor-glow halos (shadowBlur 15px < 6 Z).
// Pure function of the rug rects + panel size, so placement is deterministic
// for a given agent set. ---
const DECOR_MARGIN = 6 * Z;
// All decor sizes below are in px. pixel-agents decor is 16px-tile art drawn
// at DECOR_SCALE like the characters; every plant (plant_big included) is
// drawn at PLANT_SCALE, an integer so the pixels stay crisp.
const DECOR_SCALE = CHAR_SCALE;
const PLANT_SCALE = 1;
const DECOR_PLANT_W = 32 * PLANT_SCALE, DECOR_PLANT_H = 32 * PLANT_SCALE;
const LARGE_PLANT_W = 32 * PLANT_SCALE, LARGE_PLANT_H = 48 * PLANT_SCALE;
const SOFA_W = 16 * DECOR_SCALE, SOFA_H = 32 * DECOR_SCALE; // side view, as tall as the table
const TABLE_W = 32 * DECOR_SCALE, TABLE_H = 32 * DECOR_SCALE;
const LOUNGE_GAP = 4; // between sofa and table
export function computeDecorPlacement(rugRects, panelWidth, panelHeight) {
  const z = Z, pw = DECOR_PLANT_W, ph = DECOR_PLANT_H;
  const candidates = [
    // Break-room corner, bottom-left: a sofa facing a coffee table with the coffee pot on it
    { kind: 'lounge', x: 3 * z, y: panelHeight - TABLE_H - 3 * z, w: SOFA_W + LOUNGE_GAP + TABLE_W, h: TABLE_H },
    // A floor plant bottom-right, small potted plants in the top corners
    { kind: 'largeplant', x: panelWidth - LARGE_PLANT_W - 3 * z, y: panelHeight - LARGE_PLANT_H - 3 * z, w: LARGE_PLANT_W, h: LARGE_PLANT_H },
    { kind: 'plant', x: 3 * z, y: FLOOR_TOP, w: pw, h: ph },
    { kind: 'plant', x: panelWidth - pw - 3 * z, y: FLOOR_TOP, w: pw, h: ph },
  ];
  const apart = (c, r) =>
    c.x >= r.x + r.w + DECOR_MARGIN || c.x + c.w <= r.x - DECOR_MARGIN ||
    c.y >= r.y + r.h + DECOR_MARGIN || c.y + c.h <= r.y - DECOR_MARGIN;
  const placed = [];
  for (const c of candidates) {
    if (c.x >= 0 && c.y >= FLOOR_TOP && c.x + c.w <= panelWidth && c.y + c.h <= panelHeight &&
        rugRects.every(r => apart(c, r)) && placed.every(p => apart(c, p))) {
      placed.push(c);
    }
  }
  return placed;
}

// The live agents map (spawn/tab order) → pod layout for this panel size.
function computeOfficeLayout(panelWidth, panelHeight) {
  const infos = [...agents].map(([id, a]) => ({ id, repoPath: a.repoPath, slug: a.repoSlug }));
  return computePodLayout(infos, panelWidth, panelHeight);
}

// --- Wall layout: 2 windows divide wall into 3 equal bookshelf sections ---
function computeWallLayout(panelWidth) {
  const totalW = Math.floor(panelWidth / Z);
  const windowW = 28, windowH = 18, gap = 1;
  const shelfW = Math.max(4, Math.floor((totalW - 2 * windowW - 4 * gap) / 3));

  const shelf1X = 0;
  const window1X = shelfW + gap;
  const shelf2X = window1X + windowW + gap;
  const window2X = shelf2X + shelfW + gap;
  const shelf3X = window2X + windowW + gap;

  return { totalW, shelfW, windowW, windowH, gap, window1X, window2X, shelf1X, shelf2X, shelf3X };
}

// --- Floor (warm wood planks — fixed palette, independent of UI theme) ---
function drawFloor(ctx, w, h) {
  ctx.fillStyle = '#2a1e14';
  ctx.fillRect(0, 0, w, h);
  const plankH = 4 * Z;
  // Fixed warm wood base: #4a3525 = rgb(74, 53, 37)
  const br = 74, bg = 53, bb = 37;
  const offsets = [32, 24, 30, 22, 28];
  for (let py = WALL_BOTTOM; py < h; py += plankH) {
    const ci = Math.floor((py - WALL_BOTTOM) / plankH) % offsets.length;
    const o = offsets[ci];
    ctx.fillStyle = `rgb(${Math.min(255, br + Math.round(o * 1.5))}, ${Math.min(255, bg + Math.round(o * 1.15))}, ${Math.min(255, bb + Math.round(o * 0.55))})`;
    ctx.fillRect(0, py, w, plankH);
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.fillRect(0, py, w, 1);
    const stagger = (ci % 2) * 18 * Z;
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    for (let px = stagger; px < w; px += 36 * Z) {
      ctx.fillRect(px, py + 1, 1, plankH - 1);
    }
  }
}

// --- Wall texture (warm plaster — fixed palette, independent of UI theme) ---
function drawWalls(ctx, w) {
  const wallH = WALL_H;
  const topBand = Math.floor(wallH * 0.35);
  const midBand = Math.floor(wallH * 0.35);
  ctx.fillStyle = '#c8bfb0';  // warm cream plaster — top
  ctx.fillRect(0, 0, w, topBand);
  ctx.fillStyle = '#beb5a5';  // mid
  ctx.fillRect(0, topBand, w, midBand);
  ctx.fillStyle = '#b0a898';  // bottom
  ctx.fillRect(0, topBand + midBand, w, wallH - topBand - midBand);

  ctx.fillStyle = '#a89888';  // ceiling edge
  ctx.fillRect(0, 0, w, 2 * Z);

  const railY = Math.floor(wallH * 0.6);
  ctx.fillStyle = '#d4c8b8';  // wainscoting rail
  ctx.fillRect(0, railY, w, 2);
  ctx.fillStyle = 'rgba(0,0,0,0.04)';
  ctx.fillRect(0, railY + 2, w, wallH - railY - 2);

  ctx.fillStyle = '#c0b090';
  ctx.fillRect(0, wallH, w, Z);
  ctx.fillStyle = '#a09070';
  ctx.fillRect(0, wallH + Z, w, Z);
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fillRect(0, wallH + 2 * Z, w, 1);
}

// --- Two windows (B) ---
function drawWindows(ctx, w, theme) {
  const z = Z;
  const layout = computeWallLayout(w);
  const tod = getTimeOfDay();
  const wc = getWindowColors(tod);
  const ww = layout.windowW * z, wh = layout.windowH * z;
  const wy = 3 * z; // 3Z from top

  const windowXs = [layout.window1X * z, layout.window2X * z];

  for (const wx of windowXs) {
    // Sill
    ctx.fillStyle = '#d4c8b0';
    ctx.fillRect(wx - z, wy + wh, ww + 2 * z, z);

    // Frame
    ctx.fillStyle = '#d4c8b0';
    ctx.fillRect(wx, wy, ww, wh);

    // Glass
    const glassX = wx + z, glassY = wy + z;
    const glassW = ww - 2 * z, glassH = wh - 2 * z;
    const grad = ctx.createLinearGradient(glassX, glassY, glassX, glassY + glassH);
    grad.addColorStop(0, wc.glass1);
    grad.addColorStop(1, wc.glass2);
    ctx.fillStyle = grad;
    ctx.fillRect(glassX, glassY, glassW, glassH);

    // Stars (night)
    if (wc.hasStars) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(glassX + 2 * z, glassY + z, z, z);
      ctx.fillRect(glassX + 6 * z, glassY + 2 * z, z, z);
      ctx.fillRect(glassX + 10 * z, glassY + z, z, z);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(glassX + 4 * z, glassY + 3 * z, z, z);
    }

    // Clouds (day)
    if (wc.hasClouds) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(glassX + 2 * z, glassY + 3 * z, 3 * z, z);
      ctx.fillRect(glassX + 3 * z, glassY + 2 * z, 2 * z, z);
      ctx.fillRect(glassX + 8 * z, glassY + 4 * z, 3 * z, z);
    }

    // Cross-bars (3w × 2h = 6 pane)
    ctx.fillStyle = '#d4c8b0';
    const colW = Math.floor(glassW / 3);
    ctx.fillRect(glassX + colW, glassY, 1, glassH);       // vertical 1/3
    ctx.fillRect(glassX + 2 * colW, glassY, 1, glassH);   // vertical 2/3
    ctx.fillRect(glassX, wy + Math.floor(wh / 2) - 1, glassW, 1); // horizontal center

  }
}

// --- Bookshelves in 3 wall sections (C) ---
function drawBookshelves(ctx, w) {
  const z = Z;
  const layout = computeWallLayout(w);
  const shelfStartY = 2 * z;   // 2Z below ceiling
  const shelfH = 24 * z;       // 24 Z-units tall (fills most of wall)
  const shelfRows = 6;         // 6 horizontal shelves
  const rowH = Math.floor(shelfH / shelfRows);

  const sections = [
    { x: layout.shelf1X, w: layout.shelfW },
    { x: layout.shelf2X, w: layout.shelfW },
    { x: layout.shelf3X, w: layout.shelfW },
  ];

  const shelfPad = 2 * z; // spacing around each bookshelf section
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const sx = sec.x * z + shelfPad;
    const sw = sec.w * z - 2 * shelfPad;
    if (sw < 4 * z) continue; // too narrow to draw

    // Back panel (slightly darker than wall for depth)
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(sx, shelfStartY, sw, shelfH);

    // Side frames
    ctx.fillStyle = '#5a4030';
    ctx.fillRect(sx, shelfStartY, z, shelfH);
    ctx.fillRect(sx + sw - z, shelfStartY, z, shelfH);

    // Shelves + books
    for (let row = 0; row < shelfRows; row++) {
      const ry = shelfStartY + row * rowH;

      // Shelf line
      ctx.fillStyle = '#5a4030';
      ctx.fillRect(sx, ry + rowH - z, sw, z);

      // Books between shelves — pack left to right with variety
      const bookAreaW = sw - 2 * z;
      const bookH = rowH - z - 1;
      let bx = sx + z;
      const seed = si * 31 + row * 7; // deterministic variety per section+row
      let bi = 0;
      while (bx < sx + sw - 2 * z) {
        const bookW = (((seed + bi * 13) % 3) + 2) * z; // 2-4 Z-units wide
        if (bx + bookW > sx + sw - z) break;
        ctx.fillStyle = BOOK_COLORS[((seed + bi * 7) % BOOK_COLORS.length)];
        ctx.fillRect(bx, ry + 1, bookW - 1, bookH);
        bx += bookW;
        bi++;
      }
    }

    // Top shelf line
    ctx.fillStyle = '#5a4030';
    ctx.fillRect(sx, shelfStartY, sw, z);
  }
}

// --- Job boards (3 freestanding whiteboards on stands, replacing the old
// seating nooks). Drawn with primitives, not sprites: the boards stand on the
// floor in front of the wall, never hang on it. ---
const BOARD_W = 26;      // Z units — outer frame width (capped to the wall section)
const BOARD_H = 19;      // Z units — outer frame height
const BOARD_LEG_H = 9;   // Z units — frame bottom down to the feet
const BOARD_FRAME = 1;   // Z units — frame thickness around the writable surface
// Z units below the baseboard where the feet land: almost against the wall,
// level with the fronts of the wall plants' pots.
const BOARD_FOOT_OFFSET = 6;
const BOARD_MIN_W = 8;   // Z units — below this the section is too narrow to draw into
const BOARD_BRACE_H = 3; // Z units — brace (and centre-post foot) above the feet

// The real board's columns: COLUMNS in jobs.js, upper-cased, which a test
// keeps in step with lib/jobs.js JOB_STATES. Not imported from jobs.js, which
// would drag the socket and auth modules into the canvas. 'IN PROGRESS' only
// fits a full-width board (panel >= 432px); narrower than that fillText's
// maxWidth condenses it, harder the narrower the panel gets.
export const BOARD_TITLES = ['TO DO', 'IN PROGRESS', 'REVIEW'];
// The job states behind each board, in the same order as BOARD_TITLES.
export const BOARD_STATES = ['todo', 'in-progress', 'review'];
const BOARD_TITLE_INK = ['#2f6fb0', '#b0392b', '#2f7a4a'];
const BOARD_TITLE_FONT = `bold ${3 * Z}px monospace`;

// Pin slots for job posts, filled left-to-right top-to-bottom, one per real
// job on that board's column. Positions are fractions of the writable surface
// so the layout survives the board being narrowed on a small panel. Slightly
// jittered so a full board reads as pinned paper, not a spreadsheet.
const POST_SLOTS = [
  { x: 0.05, y: 0.33, w: 0.28, h: 0.28, lines: 3 },
  { x: 0.37, y: 0.31, w: 0.27, h: 0.31, lines: 4 },
  { x: 0.68, y: 0.34, w: 0.27, h: 0.27, lines: 3 },
  { x: 0.06, y: 0.66, w: 0.27, h: 0.27, lines: 2 },
  { x: 0.36, y: 0.68, w: 0.28, h: 0.25, lines: 3 },
  { x: 0.67, y: 0.66, w: 0.27, h: 0.28, lines: 2 },
];

// How many posts each board shows for a given job count: one per job, capped
// at the slots that fit. The overflow beyond the cap is drawn as a "+N" note.
// Exported for the board-sync test.
export function boardPostPlan(count) {
  const shown = Math.min(count, POST_SLOTS.length);
  return { shown, overflow: count - shown };
}

// Jobs per board column, in BOARD_STATES order. `done` jobs have left the
// board and are not counted. Exported for the board-sync test.
export function countBoardJobs(jobList) {
  const counts = BOARD_STATES.map(() => 0);
  for (const job of jobList) {
    const i = BOARD_STATES.indexOf(job && job.state);
    if (i >= 0) counts[i]++;
  }
  return counts;
}
const PAPER_TINTS = ['#f6f3ea', '#eef1f7', '#fbf6e4', '#f2f4ef'];
const PIN_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#d4a847'];

// Geometry for the three boards, in screen pixels. Exported so the placement
// rules (inside its own wall section, almost against the wall, clear of the
// desk grid) can be asserted in tests without a canvas.
export function computeBoardLayout(panelWidth) {
  const z = Z;
  const layout = computeWallLayout(panelWidth);

  // Cap the board to its wall section so it can never spill under a window. On
  // a panel too narrow for even a stub board, draw nothing rather than overlap.
  // Even Z-width keeps the frame's centre exactly on the stand's centre line.
  const boardZ = Math.min(BOARD_W, layout.shelfW - 2) & ~1;
  const boardW = boardZ * z;
  const boardH = BOARD_H * z;
  const footY = WALL_BOTTOM + BOARD_FOOT_OFFSET * z;   // feet on the floor, just off the baseboard
  const frameBottom = footY - BOARD_LEG_H * z;
  const boardTop = frameBottom - boardH;

  const sections = [layout.shelf1X, layout.shelf2X, layout.shelf3X].map((secX) => {
    const centerX = Math.floor((secX + layout.shelfW / 2) * z);
    return { centerX, left: secX * z, right: (secX + layout.shelfW) * z };
  });

  return {
    visible: boardZ >= BOARD_MIN_W,
    boardW, boardH, boardTop, frameBottom, footY, sections,
    wallBottom: WALL_BOTTOM,
    floorTop: FLOOR_TOP,
  };
}

function drawJobBoardEasels(ctx, w) {
  const board = computeBoardLayout(w);
  if (!board.visible) return;

  const counts = countBoardJobs(jobs.values());
  board.sections.forEach(({ centerX }, i) => {
    drawBoardStand(ctx, centerX, board.frameBottom, board.footY, board.boardW);
    drawWhiteboard(ctx, centerX - Math.floor(board.boardW / 2), board.boardTop, board.boardW, board.boardH, i, counts[i]);
  });
}

// A-frame metal stand: two splayed legs, a brace, and a contact shadow.
function drawBoardStand(ctx, centerX, topY, footY, boardW) {
  const z = Z;
  const legTop = Math.round(boardW * 0.18);
  const legFoot = Math.round(boardW * 0.42);
  const lw = Math.max(2, Math.round(z * 0.8));

  // Contact shadow on the floor — stacked rects, not an ellipse: everything
  // else in the room is hard-edged and a path fill would be antialiased.
  ctx.fillStyle = 'rgba(0,0,0,0.13)';
  ctx.fillRect(centerX - Math.round(boardW * 0.36), footY, Math.round(boardW * 0.72), z);
  ctx.fillStyle = 'rgba(0,0,0,0.09)';
  ctx.fillRect(centerX - Math.round(boardW * 0.22), footY + z, Math.round(boardW * 0.44), z);

  const leg = (dir) => {
    ctx.beginPath();
    ctx.moveTo(centerX + dir * legTop - lw / 2, topY);
    ctx.lineTo(centerX + dir * legTop + lw / 2, topY);
    ctx.lineTo(centerX + dir * legFoot + lw / 2, footY);
    ctx.lineTo(centerX + dir * legFoot - lw / 2, footY);
    ctx.closePath();
    ctx.fill();
  };

  ctx.fillStyle = '#9aa1ab';
  leg(-1);
  leg(1);

  // Centre post from the frame down to the brace
  ctx.fillRect(centerX - lw / 2, topY, lw, Math.max(0, footY - BOARD_BRACE_H * z - topY));

  // Shaded inner edge of each leg
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(centerX - legFoot - lw / 2, footY - z, lw, z);
  ctx.fillRect(centerX + legFoot - lw / 2, footY - z, lw, z);

  // Cross brace
  const braceY = footY - BOARD_BRACE_H * z;
  ctx.fillStyle = '#8b929c';
  ctx.fillRect(centerX - Math.round(boardW * 0.34), braceY, Math.round(boardW * 0.68), Math.max(1, Math.round(z * 0.6)));

  // Feet caps
  ctx.fillStyle = '#5a6068';
  ctx.fillRect(centerX - legFoot - lw, footY - 1, lw * 2, Math.max(1, Math.round(z * 0.7)));
  ctx.fillRect(centerX + legFoot - lw, footY - 1, lw * 2, Math.max(1, Math.round(z * 0.7)));
}

function drawWhiteboard(ctx, x, y, w, h, idx, jobCount) {
  const z = Z;
  const fb = BOARD_FRAME * z;

  // Drop shadow against the wall
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(x + z, y + z, w, h);

  // Aluminium frame
  ctx.fillStyle = '#b9c0c9';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#d5dae1';
  ctx.fillRect(x, y, w, Math.max(1, Math.round(fb / 2)));
  ctx.fillStyle = '#8d949d';
  ctx.fillRect(x, y + h - Math.max(1, Math.round(fb / 2)), w, Math.max(1, Math.round(fb / 2)));

  // Writable surface
  const sx = x + fb, sy = y + fb;
  const sw = w - 2 * fb, sh = h - 2 * fb;
  ctx.fillStyle = '#f7f8f5';
  ctx.fillRect(sx, sy, sw, sh);
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(sx, sy + sh - z, sw, z);          // soft shading along the bottom
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(sx, sy, sw, Math.max(1, Math.round(z / 2)));

  // Marker-written heading
  const title = BOARD_TITLES[idx % BOARD_TITLES.length];
  ctx.save();
  ctx.fillStyle = BOARD_TITLE_INK[idx % BOARD_TITLE_INK.length];
  ctx.font = BOARD_TITLE_FONT;
  ctx.textAlign = 'center';
  const maxW = sw - 2 * z;
  ctx.fillText(title, sx + sw / 2, sy + 3 * z, maxW);
  // Underline as wide as the heading actually came out (condensed or not).
  const titleW = Math.min(maxW, Math.round(ctx.measureText(title).width));
  ctx.fillRect(Math.round(sx + (sw - titleW) / 2), sy + 4 * z, titleW, 1);
  ctx.restore();

  // Pinned job posts — one per real job in this board's column
  const { shown, overflow } = boardPostPlan(jobCount);
  for (let pi = 0; pi < shown; pi++) {
    const post = POST_SLOTS[pi];
    const px = Math.round(sx + post.x * sw);
    const py = Math.round(sy + post.y * sh);
    const pw = Math.max(4, Math.round(post.w * sw));
    const ph = Math.max(4, Math.round(post.h * sh));
    // Offset by board so the three boards don't repeat the same colour run
    // (stride 3 stays coprime-ish with the 4-colour palettes; a stride of
    // POST_SLOTS.length would give boards 0 and 2 identical runs).
    drawJobPost(ctx, px, py, pw, ph, post.lines, idx * 3 + pi);
  }
  if (overflow > 0) {
    // Marker note in the bottom-right corner for the jobs that don't fit,
    // on a paper chip so it stays legible over the post pinned beneath it.
    ctx.save();
    ctx.font = BOARD_TITLE_FONT;
    ctx.textAlign = 'right';
    const label = `+${overflow}`;
    const maxW = Math.round(sw / 2);
    const labelW = Math.min(maxW, Math.ceil(ctx.measureText(label).width));
    ctx.fillStyle = '#f7f8f5';
    ctx.fillRect(sx + sw - labelW - 2 * z, sy + sh - 4 * z, labelW + 2 * z, 4 * z);
    ctx.fillStyle = BOARD_TITLE_INK[idx % BOARD_TITLE_INK.length];
    ctx.fillText(label, sx + sw - z, sy + sh - z, maxW);
    ctx.restore();
  }

  // Marker tray with two markers
  const trayW = Math.round(w * 0.5);
  const trayX = x + Math.round((w - trayW) / 2);
  ctx.fillStyle = '#a7aeb8';
  ctx.fillRect(trayX, y + h, trayW, z);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(trayX, y + h + z, trayW, 1);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(trayX + z, y + h, Math.round(trayW * 0.28), Math.max(1, Math.round(z * 0.7)));
  ctx.fillStyle = '#2980b9';
  ctx.fillRect(trayX + Math.round(trayW * 0.5), y + h, Math.round(trayW * 0.28), Math.max(1, Math.round(z * 0.7)));
}

// One sheet of paper: drop shadow, tinted stock, ruled "text", and a pin.
function drawJobPost(ctx, x, y, w, h, lines, idx) {
  const z = Z;
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fillRect(x + 1, y + 1, w, h);
  ctx.fillStyle = PAPER_TINTS[idx % PAPER_TINTS.length];
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ctx.fillRect(x, y + h - 1, w, 1);

  // Headline bar, then thinner body lines
  const pad = Math.max(2, Math.round(w * 0.12));
  let ly = y + Math.max(2, Math.round(h * 0.22));
  ctx.fillStyle = 'rgba(45, 50, 58, 0.75)';
  ctx.fillRect(x + pad, ly, Math.max(2, Math.round((w - 2 * pad) * 0.7)), 2);

  ctx.fillStyle = 'rgba(70, 76, 86, 0.45)';
  const gap = Math.max(2, Math.floor((h - (ly - y) - 4) / Math.max(1, lines - 1)));
  for (let i = 1; i < lines; i++) {
    ly += gap;
    if (ly + 1 > y + h - 2) break;
    const lw = Math.round((w - 2 * pad) * (i === lines - 1 ? 0.55 : 0.9));
    ctx.fillRect(x + pad, ly, Math.max(2, lw), 1);
  }

  // Push pin
  ctx.fillStyle = PIN_COLORS[idx % PIN_COLORS.length];
  const pinS = Math.max(2, Math.round(z * 0.7));
  ctx.fillRect(x + Math.round(w / 2) - Math.round(pinS / 2), y - Math.round(pinS / 2), pinS, pinS);
}

// Draw a sprite at an integer scale; no-op if its PNG failed to load.
function drawSprite(ctx, key, x, y, scale = DECOR_SCALE) {
  const img = SPRITES[key];
  if (img) ctx.drawImage(img, x, y, img.naturalWidth * scale, img.naturalHeight * scale);
}

// --- One plant per board gap: a cactus between TO DO and IN PROGRESS, a leafy
// plant between IN PROGRESS and REVIEW, each centred in the gap so neither
// overlaps a board at any panel width. All three boards share one width, so
// the gap's midpoint is the midpoint of the two board centres. Pots stand just
// off the baseboard, a hair above the board feet. No boards, no plants.
// Pure; exported for the placement test. ---
const WALL_PLANT_W = 16 * PLANT_SCALE, WALL_PLANT_H = 32 * PLANT_SCALE;
export function computeWallPlants(panelWidth) {
  const board = computeBoardLayout(panelWidth);
  if (!board.visible) return [];
  const [s1, s2, s3] = board.sections;
  const y = WALL_BOTTOM + 5 * Z - WALL_PLANT_H;
  const between = (a, b) => Math.floor((a.centerX + b.centerX) / 2 - WALL_PLANT_W / 2);
  return [
    { key: 'cactus', x: between(s1, s2), y, w: WALL_PLANT_W, h: WALL_PLANT_H },
    { key: 'plant2', x: between(s2, s3), y, w: WALL_PLANT_W, h: WALL_PLANT_H },
  ];
}

function drawPlants(ctx, w) {
  for (const p of computeWallPlants(w)) drawSprite(ctx, p.key, p.x, p.y, PLANT_SCALE);
}

// Brand gold (#d4a847) as an rgb triple for rgba() tints on the canvas.
const GOLD_RGB = '212, 168, 71';

// --- Per-pod rug + repo label ---
// The rug is a fixed gold, independent of the UI theme like the wood floor,
// desks and sofa it sits among: the light-theme accent is nearly the same
// colour as the floor, so a theme-tinted rug vanished in light mode. The
// repo label keeps the theme text colour.
function drawPodRug(ctx, pod, theme) {
  const z = Z;
  const r = podRugRect(pod);

  ctx.fillStyle = `rgba(${GOLD_RGB}, 0.10)`;
  roundRect(ctx, r.x, r.y, r.w, r.h, 3 * z);
  ctx.fill();
  ctx.strokeStyle = `rgba(${GOLD_RGB}, 0.32)`;
  ctx.lineWidth = 1;
  roundRect(ctx, r.x, r.y, r.w, r.h, 3 * z);
  ctx.stroke();
  // Inner border (double-border rug pattern)
  ctx.strokeStyle = `rgba(${GOLD_RGB}, 0.16)`;
  roundRect(ctx, r.x + 2 * z, r.y + 2 * z, r.w - 4 * z, r.h - 4 * z, 2 * z);
  ctx.stroke();

  if (pod.label) {
    // Styled like the agent name labels below the desks.
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(${theme.tr}, ${theme.tg}, ${theme.tb}, 0.7)`;
    ctx.fillText(pod.label, r.x + r.w / 2, r.y + 5 * z, r.w - 4 * z);
    ctx.textAlign = 'start';
  }
}

function drawDecor(ctx, spots) {
  for (const spot of spots) {
    if (spot.kind === 'lounge') {
      // Sofa (side view, facing right) and table share a floor line; the coffee pot sits on the table top.
      // Skip the whole group rather than draw a pot floating over a missing table.
      if (!SPRITES.sofa || !SPRITES.table) continue;
      // The sofa's feet fill its last art row while the table's stop one row
      // short, so lift the sofa one art pixel to share the table's floor line.
      drawSprite(ctx, 'sofa', spot.x, spot.y + TABLE_H - SOFA_H - DECOR_SCALE);
      const tx = spot.x + SOFA_W + LOUNGE_GAP;
      drawSprite(ctx, 'table', tx, spot.y);
      drawSprite(ctx, 'coffee', tx + 8 * DECOR_SCALE, spot.y + 7 * DECOR_SCALE);
    } else {
      drawSprite(ctx, spot.kind, spot.x, spot.y, PLANT_SCALE);  // 'plant' or 'largeplant'
    }
  }
}

// --- Ambient dust motes (E) ---
function drawParticles(ctx, w, h) {
  if (prefersReducedMotion) return;
  const t = Date.now();
  for (const mote of DUST_MOTES) {
    const x = mote.baseX * w + Math.sin(t * 0.0003 + mote.phaseX) * 15;
    const y = WALL_BOTTOM * 0.5 + mote.baseY * (WALL_BOTTOM * 1.5) + Math.cos(t * 0.0005 + mote.phaseY) * 8;
    if (y > WALL_BOTTOM + 20 * Z) continue;
    const alpha = 0.06 + Math.sin(t * 0.001 + mote.phaseX) * 0.04;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.fillRect(Math.floor(x), Math.floor(y), Z, Z);
  }
}

// --- Desk items (mug, papers, lamp) ---
function drawDeskItems(ctx, sx, sy) {
  const z = Z;
  const deskY = sy + 12 * z;

  // Coffee mug
  const mugX = sx + 4 * z, mugY = deskY + z;
  ctx.fillStyle = '#c0a080';
  ctx.fillRect(mugX, mugY - z, 2 * z, 2 * z);
  ctx.fillStyle = '#d4b890';
  ctx.fillRect(mugX, mugY - z, 2 * z, z);
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(mugX, mugY - z, z, z);

  // Paper stack
  const papX = sx + 23 * z, papY = deskY;
  ctx.fillStyle = '#e8e4dc';
  ctx.fillRect(papX, papY, 4 * z, z);
  ctx.fillStyle = '#ddd8d0';
  ctx.fillRect(papX, papY + z, 4 * z, z);
  ctx.fillStyle = '#c44040';
  ctx.fillRect(papX + z, papY, 2 * z, z);

  // Desk lamp
  const lampX = sx + z, lampY = deskY - 3 * z;
  ctx.fillStyle = '#808890';
  ctx.fillRect(lampX, deskY, 2 * z, z);
  ctx.fillStyle = '#909090';
  ctx.fillRect(lampX + z, lampY + z, z, deskY - lampY - z);
  ctx.fillStyle = '#d4c8b0';
  ctx.fillRect(lampX, lampY, 3 * z, z);
  ctx.fillStyle = 'rgba(255, 220, 180, 0.06)';
  ctx.fillRect(lampX - z, deskY - z, 5 * z, 2 * z);
}

// --- Sprite-based workstation (edgeless monitor + desk sprite bottom half) ---
function drawWorkstation(ctx, sx, sy, state, theme, variant, agent) {
  const z = Z;
  const deskSprite = variant === 0 ? SPRITES.desk : SPRITES.desk2;

  if (!deskSprite) {
    drawMonitor(ctx, sx + 9 * z, sy, state, theme);
    drawDesk(ctx, sx + z, sy + 12 * z);
    drawDeskItems(ctx, sx, sy);
    return;
  }

  // --- Desk sprite (bottom half only — skip baked-in monitor) ---
  const cropH = 32 - DESK_CROP_Y; // sprite rows to draw
  ctx.drawImage(
    deskSprite,
    0, DESK_CROP_Y, 32, cropH,           // source: skip top 12 rows
    sx, sy + DESK_CROP_Y * z, 32 * z, cropH * z  // dest: position below monitor
  );

  const monX = variant === 0 ? DESK_MON_X : DESK2_MON_X;

  // --- Modern edgeless monitor (procedural, positioned where sprite monitor was) ---
  const mw = 14, mh = 9;  // monitor outer size in Z-units
  const mx = sx + monX * z;  // align with sprite's original monitor position
  const my = sy + 3 * z;     // above desk surface

  // Thin dark frame (1px bezel)
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(mx, my, mw * z, mh * z);

  // Screen (fills almost entire monitor — 1Z bezel all around)
  const scrX = mx + z, scrY = my + z;
  const scrW = (mw - 2) * z, scrH = (mh - 2) * z;

  if (state === 'DISCONNECTED') {
    ctx.fillStyle = '#111';
    ctx.fillRect(scrX, scrY, scrW, scrH);
  } else if (state === 'WORKING') {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(scrX, scrY, scrW, scrH);
    const t = Math.floor(Date.now() / 400);
    const lc = [theme.accent, '#f0c040', '#4a90d9', '#e06c75', '#98c379'];
    for (let line = 0; line < Math.min(5, mh - 2); line++) {
      ctx.fillStyle = lc[(line + t) % lc.length] + '90';
      const lw = (2 + ((line + t) % 4)) * z;
      ctx.fillRect(scrX + z, scrY + line * z, Math.min(lw, scrW - z), z - 1);
    }
    ctx.shadowColor = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.35)`;
    ctx.shadowBlur = 10;
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.03)`;
    ctx.fillRect(scrX, scrY, scrW, scrH);
    ctx.shadowBlur = 0;
  } else if (state === 'MESSAGE') {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(scrX, scrY, scrW, scrH);
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.5)`;
    for (let line = 0; line < 3; line++) {
      const lw = (3 + (line % 3)) * z;
      ctx.fillRect(scrX + z, scrY + line * z, Math.min(lw, scrW - z), z - 1);
    }
    ctx.shadowColor = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.3)`;
    ctx.shadowBlur = 6;
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.03)`;
    ctx.fillRect(scrX, scrY, scrW, scrH);
    ctx.shadowBlur = 0;
  } else if (state === 'WAITING') {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(scrX, scrY, scrW, scrH);
    const adds = agent && agent.additions || 0;
    const dels = agent && agent.removals || 0;
    if (adds > 0 || dels > 0) {
      // Show +additions / -removals
      ctx.font = `bold ${z * 2.5}px monospace`;
      ctx.textAlign = 'center';
      const centerX = scrX + scrW / 2;
      if (adds > 0) {
        ctx.fillStyle = '#3fb950';
        ctx.fillText(`+${adds}`, centerX, scrY + 3 * z);
      }
      if (dels > 0) {
        ctx.fillStyle = '#f85149';
        ctx.fillText(`-${dels}`, centerX, scrY + 5.5 * z);
      }
      ctx.textAlign = 'start';
    } else {
      // No changes: show prompt chevron with blinking cursor
      ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.7)`;
      ctx.fillRect(scrX + z,     scrY + 2 * z, z, z - 1);
      ctx.fillRect(scrX + 2 * z, scrY + 3 * z, z, z - 1);
      ctx.fillRect(scrX + z,     scrY + 4 * z, z, z - 1);
      const blink = Math.floor(Date.now() / 600) % 2;
      if (blink) {
        ctx.fillStyle = theme.accent;
        ctx.fillRect(scrX + 4 * z, scrY + 3 * z, 2 * z, z);
      }
    }
    ctx.shadowColor = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.3)`;
    ctx.shadowBlur = 8;
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.03)`;
    ctx.fillRect(scrX, scrY, scrW, scrH);
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(scrX, scrY, scrW, scrH);
    const adds = agent && agent.additions || 0;
    const dels = agent && agent.removals || 0;
    if (adds > 0 || dels > 0) {
      // Show +additions / -removals as pixel text
      ctx.font = `bold ${z * 2.5}px monospace`;
      ctx.textAlign = 'center';
      const centerX = scrX + scrW / 2;
      if (adds > 0) {
        ctx.fillStyle = '#3fb950';
        ctx.fillText(`+${adds}`, centerX, scrY + 3 * z);
      }
      if (dels > 0) {
        ctx.fillStyle = '#f85149';
        ctx.fillText(`-${dels}`, centerX, scrY + 5.5 * z);
      }
      ctx.textAlign = 'start';
    } else {
      // No changes: dim dot
      const t = Date.now() / 2000;
      const dotX = scrX + z + Math.floor((Math.sin(t) * 0.5 + 0.5) * (scrW - 3 * z));
      const dotY = scrY + z + Math.floor((Math.cos(t * 0.7) * 0.5 + 0.5) * (scrH - 3 * z));
      ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.3)`;
      ctx.fillRect(dotX, dotY, z, z);
    }
  }

  // Monitor stand — thin neck + slim base
  const standX = mx + Math.floor(mw / 2) * z - z;
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(standX, my + mh * z, 2 * z, z);             // neck (1Z tall)
  ctx.fillStyle = '#222';
  ctx.fillRect(standX - z, my + mh * z + z, 4 * z, z);     // base
}

// --- Monitor glow (A) ---
function drawMonitorGlow(ctx, sx, sy, state, theme) {
  if (state === 'IDLE' || state === 'DISCONNECTED') return;
  const z = Z;
  const deskY = sy + 12 * z;
  const floorY = deskY + 10 * z;
  const glowX = sx + 5 * z;
  const glowW = 22 * z;

  let glowR, glowG, glowB, deskAlpha, floorAlpha;
  if (state === 'WORKING') {
    glowR = theme.ar; glowG = theme.ag; glowB = theme.ab;
    const pulse = prefersReducedMotion ? 0 : Math.sin(Date.now() / 800) * 0.02;
    deskAlpha = 0.10 + pulse;
    floorAlpha = 0.04 + pulse * 0.5;
  } else if (state === 'MESSAGE') {
    glowR = theme.ar; glowG = theme.ag; glowB = theme.ab;
    deskAlpha = 0.08;
    floorAlpha = 0.03;
  } else {
    glowR = theme.ar; glowG = theme.ag; glowB = theme.ab;
    deskAlpha = 0.05;
    floorAlpha = 0.02;
  }

  ctx.shadowColor = `rgba(${glowR}, ${glowG}, ${glowB}, ${deskAlpha * 2})`;
  ctx.shadowBlur = 15;
  ctx.fillStyle = `rgba(${glowR}, ${glowG}, ${glowB}, ${deskAlpha})`;
  ctx.fillRect(glowX, deskY, glowW, 3 * z);
  ctx.shadowBlur = 0;

  ctx.fillStyle = `rgba(${glowR}, ${glowG}, ${glowB}, ${floorAlpha})`;
  ctx.beginPath();
  ctx.ellipse(sx + 16 * z, floorY + 3 * z, glowW / 2.2, 4 * z, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawMonitor(ctx, x, y, state, theme) {
  const z = Z, mw = 14, mh = 10;
  ctx.fillStyle = '#c0c0c0';
  ctx.fillRect(x, y, mw * z, mh * z);
  const sx = x + z, sy = y + z, sw = (mw - 2) * z, sh = (mh - 2) * z;

  if (state === 'DISCONNECTED') {
    ctx.fillStyle = '#111';
    ctx.fillRect(sx, sy, sw, sh);
  } else if (state === 'WORKING') {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(sx, sy, sw, sh);
    const t = Math.floor(Date.now() / 400);
    const lc = [theme.accent, '#f0c040', '#4a90d9', '#e06c75', '#98c379'];
    for (let line = 0; line < 4; line++) {
      ctx.fillStyle = lc[(line + t) % lc.length] + '90';
      const lw = (3 + ((line + t) % 5)) * z;
      ctx.fillRect(sx + z, sy + line * z, Math.min(lw, sw - z), z - 1);
    }
    ctx.shadowColor = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.35)`;
    ctx.shadowBlur = 10;
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.03)`;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.shadowBlur = 0;
  } else if (state === 'MESSAGE') {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.5)`;
    for (let line = 0; line < 3; line++) {
      const lw = (4 + (line % 3)) * z;
      ctx.fillRect(sx + z, sy + line * z, Math.min(lw, sw - z), z - 1);
    }
    ctx.shadowColor = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.3)`;
    ctx.shadowBlur = 6;
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.03)`;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.shadowBlur = 0;
  } else if (state === 'WAITING') {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.6)`;
    ctx.fillRect(sx + z, sy + z, 2 * z, z - 1);
    if (Math.floor(Date.now() / 500) % 2) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(sx + 4 * z, sy + z, z, z);
    }
    ctx.shadowColor = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.2)`;
    ctx.shadowBlur = 6;
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.02)`;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(sx, sy, sw, sh);
    const t = Date.now() / 2000;
    const dotX = sx + z + Math.floor((Math.sin(t) * 0.5 + 0.5) * (sw - 3 * z));
    const dotY = sy + z + Math.floor((Math.cos(t * 0.7) * 0.5 + 0.5) * (sh - 3 * z));
    ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.3)`;
    ctx.fillRect(dotX, dotY, z, z);
  }

  // Monitor stand
  ctx.fillStyle = '#aaa';
  ctx.fillRect(x + 5 * z, y + mh * z, 4 * z, 2 * z);
  ctx.fillRect(x + 4 * z, y + (mh + 2) * z, 6 * z, z);
}

function drawDesk(ctx, x, y) {
  const z = Z, dw = 30;
  ctx.fillStyle = '#7a6550';
  ctx.fillRect(x, y, dw * z, 3 * z);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x + z, y + z, (dw - 2) * z, z);
  ctx.fillStyle = '#4a3828';
  ctx.fillRect(x, y, z, 3 * z);
  ctx.fillRect(x + (dw - 1) * z, y, z, 3 * z);
  ctx.fillStyle = '#5a4838';
  ctx.fillRect(x, y + 3 * z, dw * z, 4 * z);
  ctx.fillStyle = '#4a3828';
  ctx.fillRect(x, y + 3 * z, dw * z, z);
  ctx.fillStyle = '#8a7a68';
  ctx.fillRect(x + 4 * z, y + 5 * z, 3 * z, z);
  ctx.fillRect(x + (dw - 7) * z, y + 5 * z, 3 * z, z);
  ctx.fillStyle = '#4a3828';
  ctx.fillRect(x + z, y + 7 * z, 2 * z, 3 * z);
  ctx.fillRect(x + (dw - 3) * z, y + 7 * z, 2 * z, 3 * z);
  ctx.fillStyle = '#d0d0d0';
  ctx.fillRect(x + 11 * z, y + z, 8 * z, 2 * z);
  ctx.fillStyle = '#eee';
  for (let k = 0; k < 3; k++) {
    for (let r = 0; r < 2; r++) {
      ctx.fillRect(x + (12 + k * 2) * z, y + (z + r * z), z, z - 1);
    }
  }
}


function drawMessageBubble(ctx, x, y, theme) {
  const z = Z;
  const bw = 10 * z, bh = 7 * z;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  roundRect(ctx, x, y, bw, bh, 4);
  ctx.fill();
  // Tail dots pointing down toward the character
  ctx.beginPath();
  ctx.arc(x + 2 * z, y + bh + 2 * z, z * 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + z, y + bh + 4 * z, z * 0.8, 0, Math.PI * 2);
  ctx.fill();
  // Three dots in accent color
  ctx.fillStyle = theme.accent;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x + (3 + i * 2) * z, y + bh / 2, z, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWaitingBubble(ctx, x, y, theme) {
  const z = Z;
  const bw = 10 * z, bh = 8 * z;
  const pulse = 0.85 + Math.sin(Date.now() / 400) * 0.15;
  ctx.fillStyle = `rgba(255, 255, 255, ${pulse})`;
  roundRect(ctx, x, y, bw, bh, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 2 * z, y + bh + 2 * z, z * 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + z, y + bh + 4 * z, z * 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, ${pulse})`;
  ctx.font = `bold ${z * 5}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('?', x + bw / 2, y + bh - 2 * z);
  ctx.textAlign = 'start';
}

function drawChangeBadge(ctx, x, y, count, color) {
  if (count <= 0) return;
  const z = Z;
  const text = String(count);
  const bw = Math.max(4, text.length * 3 + 2) * z;
  const bh = 4 * z;
  const bx = x + WS_W * z - bw - z;
  const by = y;
  ctx.fillStyle = color;
  roundRect(ctx, bx, by, bw, bh, 3);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${z * 3}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(text, bx + bw / 2, by + bh - z);
  ctx.textAlign = 'start';
}

function drawConflictBadge(ctx, x, y) {
  const z = Z;
  const bx = x + WS_W * z - 5 * z;
  const by = y + 5 * z;
  ctx.fillStyle = '#f0c040';
  ctx.font = `bold ${z * 4}px monospace`;
  ctx.fillText('\u26a0', bx, by + 3 * z);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// --- Transient motion: dispatch papers and walk in/out ---
// Purely client-side, time-based state. Every animation self-expires on its
// start timestamp, so a backgrounded tab (where rAF pauses) wakes up to find
// them finished rather than replaying a queued burst.
const WALK_SPEED = 130;       // px/s along the walk path
const WALK_FRAME_MS = 150;    // walk-cycle frame time
const PAPER_MS = 900;         // paper flight time
const PAPER_FADE_MS = 250;    // fade-out after landing

// null until the first jobs-list, which the server sends last in the initial
// connect sync — session-created replays before it are pre-existing agents
// and must render seated, not walk in.
let prevJobStates = null;     // jobId -> { state, agentSessionId }
const paperAnims = [];        // { sessionId, col, start }
const walkAnims = new Map();  // sessionId -> { dir: 'in'|'out', start, queuedAt, fromX, fromY, variant }

function motionEnabled() {
  // Live query (not the module-load const): flipping the OS reduce-motion
  // setting mid-session should affect the next animation, not the next reload.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  return !reduced && !document.hidden;
}

export function hasMotion() {
  return paperAnims.length > 0 || walkAnims.size > 0;
}

// Entrance: the middle of the bottom edge — the character appears there,
// walks across to its desk column, then up to the chair.
export function entryPoint(w, h) {
  return { x: Math.round(w / 2 - CHAR_W / 2), y: h - CHAR_H };
}

// L-shaped route between two points. Walking in goes across first, then up to
// the desk; walking out goes down from the desk first, then across to the
// entrance — verticalFirst picks which.
export function walkPath(from, to, verticalFirst) {
  const legs = [];
  const bend = verticalFirst ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
  for (const [a, b] of [[from, bend], [bend, to]]) {
    if (a.x !== b.x || a.y !== b.y) legs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  }
  const total = legs.reduce((s, l) => s + Math.abs(l.x1 - l.x0) + Math.abs(l.y1 - l.y0), 0);
  return { from, legs, total };
}

// Point and heading a given distance along the path. Clamps to the endpoints.
export function pointAlongPath(path, dist) {
  let d = Math.max(0, Math.min(dist, path.total));
  for (let i = 0; i < path.legs.length; i++) {
    const l = path.legs[i];
    const len = Math.abs(l.x1 - l.x0) + Math.abs(l.y1 - l.y0);
    if (d <= len || i === path.legs.length - 1) {
      const t = len ? Math.min(1, d / len) : 1;
      return {
        x: Math.round(l.x0 + (l.x1 - l.x0) * t),
        y: Math.round(l.y0 + (l.y1 - l.y0) * t),
        dx: Math.sign(l.x1 - l.x0),
        dy: Math.sign(l.y1 - l.y0),
      };
    }
    d -= len;
  }
  return { x: path.from.x, y: path.from.y, dx: 0, dy: 0 };
}

// Jobs that just moved into in-progress under a fresh agent — the dispatches.
// A manual review -> in-progress move keeps its agentSessionId, so it does not
// register. fromState names the column the paper launches from.
export function detectDispatches(prev, jobList) {
  const out = [];
  for (const job of jobList) {
    if (!job || job.state !== 'in-progress' || !job.agentSessionId) continue;
    const p = prev.get(job.id);
    if (p && p.agentSessionId === job.agentSessionId) continue;
    out.push({ jobId: job.id, sessionId: job.agentSessionId, fromState: p ? p.state : 'todo' });
  }
  return out;
}

// Called after every jobs-list broadcast. The first call is the baseline (and
// marks the connect sync complete); later calls diff against it for dispatches.
export function noteJobsUpdate() {
  const list = [...jobs.values()];
  if (prevJobStates !== null && motionEnabled()) {
    for (const d of detectDispatches(prevJobStates, list)) {
      const col = Math.max(0, BOARD_STATES.indexOf(d.fromState));
      paperAnims.push({ sessionId: d.sessionId, col, start: performance.now() });
    }
  }
  prevJobStates = new Map(list.map(j => [j.id, { state: j.state, agentSessionId: j.agentSessionId || null }]));
}

// A session-created for a session not yet in the agent map. Ignored during the
// initial connect sync: those agents already existed and render seated.
export function noteAgentArrival(sessionId) {
  if (prevJobStates === null || !motionEnabled()) return;
  walkAnims.set(sessionId, {
    dir: 'in', start: null, queuedAt: performance.now(), variant: charVariant(sessionId),
  });
}

// An agent is about to leave (session-ended, or the user closing the tab).
// Captures the desk position now — the tile may be gone next frame.
export function noteAgentDeparture(sessionId) {
  if (!motionEnabled()) return;
  const agent = agents.get(sessionId);
  if (!agent || agent.state === 'DISCONNECTED') return;
  const canvas = document.getElementById('office-canvas');
  if (!canvas) return;
  const { w, h } = canvasSize(canvas);
  if (!w || !h) return;
  const layout = computeOfficeLayout(w, h);
  const pos = deskCharPos(sessionId, layout);
  if (!pos) return;
  walkAnims.set(sessionId, {
    dir: 'out', start: performance.now(),
    fromX: pos.x, fromY: pos.y,
    variant: charVariant(sessionId),
  });
}

function deskCharPos(sessionId, layout) {
  const pos = layout.positions.get(sessionId);
  if (!pos) return null;
  // Same variant rule as the seated pass: desk style keys on the agent id.
  const deskVariant = charVariant(sessionId) % 2;
  return {
    x: pos.x + (deskVariant === 0 ? DESK_CHAR_X : DESK2_CHAR_X) * Z - 1,
    y: pos.y + DESK_CHAR_Y * Z,
  };
}

function drawWalker(ctx, variant, pt, now) {
  const sheet = SPRITES['char' + variant] || SPRITES.char0;
  if (!sheet) return;
  const col = Math.floor(now / WALK_FRAME_MS) % 3;
  let row = CHAR_ROW_RIGHT, mirror = false;
  if (pt.dy < 0) row = CHAR_ROW_UP;
  else if (pt.dy > 0) row = CHAR_ROW_DOWN;
  else if (pt.dx < 0) mirror = true; // sheet has no left row — mirror the right one
  ctx.save();
  if (mirror) {
    ctx.translate(pt.x + CHAR_W, pt.y);
    ctx.scale(-1, 1);
    ctx.drawImage(sheet, col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H, 0, 0, CHAR_W, CHAR_H);
  } else {
    ctx.drawImage(sheet, col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H, pt.x, pt.y, CHAR_W, CHAR_H);
  }
  ctx.restore();
}

// A small flying job sheet, drawn like the pinned posts on the boards.
function drawFlyingPaper(ctx, x, y, alpha) {
  const z = Z;
  const pw = 4 * z, ph = 5 * z;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fillRect(x + 1, y + 1, pw, ph);
  ctx.fillStyle = '#f6f3ea';
  ctx.fillRect(x, y, pw, ph);
  ctx.fillStyle = 'rgba(45, 50, 58, 0.75)';
  ctx.fillRect(x + z, y + z, 2 * z, 2);
  ctx.fillStyle = 'rgba(70, 76, 86, 0.45)';
  ctx.fillRect(x + z, y + Math.round(2.5 * z), Math.round(2.5 * z), 1);
  ctx.fillRect(x + z, y + Math.round(3.5 * z), 2 * z, 1);
  ctx.restore();
}

// Drawn on top of everything each frame. Targets resolve fresh from the
// current layout, so a grid reflow retargets mid-flight instead of leaving an
// animation aimed at a stale desk.
function drawMotion(ctx, w, h, layout) {
  if (!hasMotion()) return;
  const now = performance.now();

  const board = paperAnims.length ? computeBoardLayout(w) : null;
  for (let i = paperAnims.length - 1; i >= 0; i--) {
    const p = paperAnims[i];
    const elapsed = now - p.start;
    if (elapsed > PAPER_MS + PAPER_FADE_MS || !board.visible) { paperAnims.splice(i, 1); continue; }
    const sec = board.sections[p.col] || board.sections[0];
    const from = { x: sec.centerX, y: board.boardTop + Math.round(board.boardH / 2) };
    const to = deskCharPos(p.sessionId, layout)
      || { x: Math.round(w / 2), y: Math.round((FLOOR_TOP + h) / 2) };
    const t = Math.min(1, elapsed / PAPER_MS);
    const e = t * t * (3 - 2 * t); // smoothstep ease
    // Quadratic arc with the control point lifted above the launch
    const cx = (from.x + to.x) / 2, cy = Math.min(from.y, to.y) - 12 * Z;
    const u = 1 - e;
    const x = u * u * from.x + 2 * u * e * cx + e * e * to.x;
    const y = u * u * from.y + 2 * u * e * cy + e * e * to.y;
    const alpha = elapsed <= PAPER_MS ? 1 : 1 - (elapsed - PAPER_MS) / PAPER_FADE_MS;
    drawFlyingPaper(ctx, Math.round(x), Math.round(y), alpha);
  }

  const entry = entryPoint(w, h);
  for (const [sid, anim] of walkAnims) {
    let path;
    if (anim.dir === 'in') {
      const to = deskCharPos(sid, layout);
      if (!to) {
        // session-created seen, but the async terminal handler hasn't put the
        // agent in the map yet — wait briefly, then give up.
        if (now - anim.queuedAt > 4000) walkAnims.delete(sid);
        continue;
      }
      if (anim.start === null) anim.start = now;
      path = walkPath(entry, to, false);
    } else {
      path = walkPath({ x: anim.fromX, y: anim.fromY }, entry, true);
    }
    const dist = ((now - anim.start) / 1000) * WALK_SPEED;
    if (dist >= path.total) {
      // The seated pass already skipped this frame, so hold the walker on its
      // endpoint once more or the character blinks out for a frame on arrival.
      if (anim.dir === 'in') drawWalker(ctx, anim.variant, pointAlongPath(path, path.total), now);
      walkAnims.delete(sid);
      continue;
    }
    drawWalker(ctx, anim.variant, pointAlongPath(path, dist), now);
  }
}

// Size from the canvas's own CSS box (flex:1 below .office-header), not the
// panel's — the panel height includes the header, so a panel-sized canvas
// overflowed the bottom and clipped the sofa and corner plants. The diff
// viewer hides the canvas (display:none → 0x0 client box), so remember the
// last real size: renders and walk-outs captured while hidden still lay out
// against the room the user will see when it comes back.
let lastCanvasSize = { w: 0, h: 0 };
function canvasSize(canvas) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w && h) lastCanvasSize = { w, h };
  return lastCanvasSize;
}

export function renderOffice() {
  const canvas = document.getElementById('office-canvas');
  const { w, h } = canvasSize(canvas);
  if (!w || !h) return; // no layout yet — nothing to draw into
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
  const theme = getThemeColors();

  // Layer 1: Floor (warm wood planks)
  drawFloor(ctx, w, h);
  // Layer 2: Walls (warm plaster)
  drawWalls(ctx, w);
  // Layer 3: Windows (2 windows with day/night + light beams)
  drawWindows(ctx, w, theme);
  // Layer 5: Potted plants (against the wall, in the gaps between the boards)
  drawPlants(ctx, w);
  // Layer 5b: Job boards
  drawJobBoardEasels(ctx, w);
  // Layer 6: Ambient particles
  drawParticles(ctx, w, h);

  // Per-repo pod layout, then ambient decor in whatever floor is left over
  const layout = computeOfficeLayout(w, h);
  drawDecor(ctx, computeDecorPlacement(layout.pods.map(podRugRect), w, h));
  for (const pod of layout.pods) drawPodRug(ctx, pod, theme);

  for (const [sessionId, agent] of agents) {
    const pos = layout.positions.get(sessionId);
    if (!pos) continue;  // never let one miss blank the office every frame
    const { x: sx, y: sy } = pos;
    const isActive = sessionId === activeSessionId;
    const state = agent.state;
    const alive = state !== 'DISCONNECTED';
    // Colleague agents (you don't own them) render dimmed with an owner label (phase 3).
    const readOnly = !canControlAgent(agent);
    if (readOnly) ctx.globalAlpha = 0.5;

    // Desk variant keys on the agent id (like the character sprite), not the
    // iteration index, so an unrelated exit never restyles later desks.
    const deskVariant = charVariant(sessionId) % 2;
    const charX = sx + (deskVariant === 0 ? DESK_CHAR_X : DESK2_CHAR_X) * Z;
    // Fall back to sheet 0 if this variant's PNG failed to load
    const sheet = SPRITES['char' + charVariant(sessionId)] || SPRITES.char0;
    // While a walk anim exists, the overlay pass draws the character instead —
    // covers walk-ins, and a session re-emitted while its walk-out still plays.
    const walking = walkAnims.has(sessionId);
    drawWorkstation(ctx, sx, sy, state, theme, deskVariant, agent);
    drawMonitorGlow(ctx, sx, sy, state, theme);
    if (alive && sheet && !walking) {
      let row, col;
      if (state === 'WORKING') {
        // Seated at the keyboard, typing (2-frame cycle), back to the viewer.
        row = CHAR_ROW_UP;
        col = CHAR_COL_TYPE + (prefersReducedMotion ? 0 : Math.floor(Date.now() / 300) % 2);
      } else if (state === 'IDLE') {
        row = CHAR_ROW_DOWN;
        col = CHAR_COL_STAND;
      } else {
        // WAITING / MESSAGE: chair turned around, facing the viewer
        row = CHAR_ROW_DOWN;
        col = CHAR_COL_TYPE;
      }
      ctx.drawImage(
        sheet,
        col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H,
        charX - 1, sy + DESK_CHAR_Y * Z,
        CHAR_FRAME_W * CHAR_SCALE, CHAR_FRAME_H * CHAR_SCALE
      );
    }

    if (agent.name) {
      const nameY = sy + 37 * Z;
      const nameX = sx + (WS_W / 2) * Z;
      ctx.textAlign = 'center';

      if (!isActive) {
        ctx.font = LABEL_FONT;
        ctx.fillStyle = `rgba(${theme.tr}, ${theme.tg}, ${theme.tb}, 0.7)`;
        ctx.fillText(agent.name, nameX, nameY);
      } else {
        // Pulsing glow
        const pulse = Math.sin(Date.now() / 600) * 0.5 + 0.5;
        ctx.font = LABEL_FONT;
        ctx.shadowColor = `rgba(${GOLD_RGB}, ${0.4 + pulse * 0.5})`;
        ctx.shadowBlur = 6 + pulse * 8;
        ctx.fillStyle = '#d4a847';
        ctx.fillText(agent.name, nameX, nameY);
        ctx.fillText(agent.name, nameX, nameY);
        ctx.shadowBlur = 0;
      }
      ctx.textAlign = 'start';
    }

    if (state === 'MESSAGE') {
      // Beside the character's head.
      drawMessageBubble(ctx, charX + 5 * Z, sy + 5 * Z, theme);
    }
    if (state === 'DISCONNECTED') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(sx, sy, WS_W * Z, WS_H * Z);
      const cx = sx + Math.floor(WS_W / 2) * Z;
      const cy = sy + Math.floor(WS_H / 2) * Z - 2 * Z;
      ctx.fillStyle = '#ff4444';
      for (let i = -3; i <= 3; i++) {
        ctx.fillRect(cx + i * Z, cy + i * Z, Z, Z);
        ctx.fillRect(cx + i * Z, cy - i * Z, Z, Z);
      }
    }

    if (agent.conflicts && agent.conflicts.length > 0) {
      drawConflictBadge(ctx, sx, sy);
    }

    // Owner label (full opacity) under the dimmed colleague tile.
    if (readOnly && agent.ownerName) {
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';
      ctx.font = '9px monospace';
      // Concrete fallback (canvas fillStyle ignores invalid colors like CSS vars).
      ctx.fillStyle = /^#[0-9a-fA-F]{3,8}$/.test(String(agent.ownerColor)) ? agent.ownerColor : '#9ca3af';
      // maxWidth clamps a long owner name to the tile so it can't overflow onto neighbors.
      ctx.fillText(agent.ownerName, sx + (WS_W / 2) * Z, sy + 46 * Z, WS_W * Z);
      ctx.textAlign = 'start';
    }
    ctx.globalAlpha = 1;
  }

  // Transient overlays: flying dispatch papers, characters walking in/out
  drawMotion(ctx, w, h, layout);
}

export function setupOfficeClick() {
  const canvas = document.getElementById('office-canvas');
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const layout = computeOfficeLayout(rect.width, rect.height);
    for (const [sessionId] of agents) {
      const pos = layout.positions.get(sessionId);
      if (!pos) continue;
      const sw = WS_W * Z, sh = (WS_H + 6) * Z;
      if (x >= pos.x - Z && x <= pos.x + sw + Z &&
          y >= pos.y - Z && y <= pos.y + sh + Z) {
        switchToSession(sessionId);
        return;
      }
    }
  });
}

export function startAnimationLoop() {
  function loop() {
    const hasLiving = [...agents.values()].some(a => a.state !== 'DISCONNECTED');
    // hasMotion keeps the walk-out of the last departing agent rendering
    if (hasLiving || hasMotion()) renderOffice();
    requestAnimationFrame(loop);
  }
  loop();
}
