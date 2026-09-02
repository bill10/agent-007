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

const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

// --- Furniture + character sprites ---
// Desks/bookshelf: Free Furniture Office Equipment Set by Antea (CC-BY 4.0)
// Characters: pixel-agents (MIT), based on JIK-A-4 "Metro City" pack (CC0).
// Each char sheet is 112×96: 7 columns × 3 rows of 16×32 frames.
// Rows: 0 = facing down (viewer), 1 = facing up (back), 2 = facing right.
// Columns: 0-2 walk cycle (1 = standing), 3-4 seated typing, 5-6 reading.
export const SPRITE_PATHS = {
  desk:    'assets/furniture/desk.png',             // 32×32 computer desk with monitor
  desk2:   'assets/furniture/desk2.png',            // 32×32 alt desk layout
  bookshelf: 'assets/furniture/bookshelf.png',      // 16×16 short bookcase, art in x 2–14 (Antea CC-BY 4.0)
  // Ambient decor from pixel-agents (MIT). 16px-tile art, drawn at CHAR_SCALE
  // like the characters.
  cactus:     'assets/furniture/cactus.png',           // 16×32
  plant2:     'assets/furniture/plant_2.png',          // 16×32
  sofa:       'assets/furniture/sofa_side.png',        // 16×32, side view facing right
  sofafront:  'assets/furniture/sofa_front.png',       // 32×16, front view facing down
  table:      'assets/furniture/coffee_table.png',     // 32×32
  coffee:     'assets/furniture/coffee.png',           // 16×16, art in the top-right 8×7
  conftable:  'assets/furniture/table_front.png',      // 48×64 wooden table, art in rows 11–63
  confchair:  'assets/furniture/chair_side.png',       // 16×16 cushioned chair facing right, art in x 0–11
  confchairback: 'assets/furniture/chair_back.png',    // 16×16 cushioned chair seen from behind, art in x 2–13
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
// The left-edge lane the walk in/out entrance and its strip occupy: furniture
// that can yield (spare desks, the conference set) keeps out of it.
const ENTRY_STRIP_W = Z + CHAR_W;

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
// The rug-padding allowance mirrors panelZ in computePodLayout, so a
// max-width pod's rug borders don't clip at the panel edges.
function maxColsFor(panelWidth) {
  return Math.max(1, Math.min(4, Math.floor((panelWidth / Z - 2 * RUG_PAD_X + WS_GAP_X) / (WS_W + WS_GAP_X))));
}

export function computePodLayout(agentInfos, panelWidth, panelHeight) {
  const maxCols = maxColsFor(panelWidth);

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

// --- Ambient decor along the bottom of the floor: a chat area in each bottom
// corner with the two plants stacked between them as a divider. A spot is kept
// only if it clears every rug by a margin wide enough to also clear the
// monitor-glow halos (shadowBlur 15px < 6 Z), so the decor simply disappears
// as pod rows grow downward. Pure function of the rug rects + panel size, so
// placement is deterministic for a given agent set. ---
const DECOR_MARGIN = 6 * Z;
// True when rect c clears rect r by DECOR_MARGIN on some side.
const apart = (c, r) =>
  c.x >= r.x + r.w + DECOR_MARGIN || c.x + c.w <= r.x - DECOR_MARGIN ||
  c.y >= r.y + r.h + DECOR_MARGIN || c.y + c.h <= r.y - DECOR_MARGIN;
// All decor sizes below are in px: 16px-tile pixel-agents art drawn at
// DECOR_SCALE like the characters.
const DECOR_SCALE = CHAR_SCALE;
const SOFA_W = 16 * DECOR_SCALE, SOFA_H = 32 * DECOR_SCALE; // side view, as tall as the table
const TABLE_W = 32 * DECOR_SCALE, TABLE_H = 32 * DECOR_SCALE;
const SOFA_FRONT_H = 16 * DECOR_SCALE;
// Chat area: a pod-style rug holding a side sofa each side of the coffee
// table (the right one mirrored to face it) and a front-facing sofa above it.
const CHAT_PAD_X = 13, CHAT_PAD_TOP = 14, CHAT_PAD_BOTTOM = 12, CHAT_GAP = 8;
const CHAT_W = 2 * CHAT_PAD_X + 2 * SOFA_W + 2 * CHAT_GAP + TABLE_W;             // 170
const CHAT_H = CHAT_PAD_TOP + SOFA_FRONT_H + CHAT_GAP + TABLE_H + CHAT_PAD_BOTTOM; // 130
const CHAT_MARGIN_X = 13 * Z;  // chat areas sit in from the panel edges, leaving the entry corner clear
// The divider plants between the chat areas draw smaller than the 16px decor
// grid so they read as a low hedge, not sentinels towering over the sofas.
const PLANT_MID_SCALE = 1.25;
const PLANT_MID_W = Math.round(16 * PLANT_MID_SCALE), PLANT_MID_H = Math.round(32 * PLANT_MID_SCALE);
const PLANT_MID_GAP = DECOR_MARGIN; // floor between the leafy plant's pot and the cactus
export function computeDecorPlacement(rugRects, panelWidth, panelHeight) {
  const z = Z;
  const midX = Math.floor((panelWidth - PLANT_MID_W) / 2);
  const cactusY = panelHeight - PLANT_MID_H - 3 * z;
  const candidates = [
    { kind: 'chat', x: CHAT_MARGIN_X, y: panelHeight - CHAT_H - 3 * z, w: CHAT_W, h: CHAT_H },
    { kind: 'chat', x: panelWidth - CHAT_W - CHAT_MARGIN_X, y: panelHeight - CHAT_H - 3 * z, w: CHAT_W, h: CHAT_H },
    { kind: 'cactus', x: midX, y: cactusY, w: PLANT_MID_W, h: PLANT_MID_H, scale: PLANT_MID_SCALE },
    { kind: 'plant2', x: midX, y: cactusY - PLANT_MID_GAP - PLANT_MID_H, w: PLANT_MID_W, h: PLANT_MID_H, scale: PLANT_MID_SCALE },
  ];
  const placed = [];
  for (const c of candidates) {
    if (c.x >= 0 && c.y >= FLOOR_TOP && c.x + c.w <= panelWidth && c.y + c.h <= panelHeight &&
        rugRects.every(r => apart(c, r)) && placed.every(p => apart(c, p))) {
      placed.push(c);
    }
  }
  return placed;
}

// --- Conference table: a vertical boardroom table centred in the open band
// between the desks (rugs + spare desks) and the chat areas, with cushioned
// chairs down both sides, one at the foot, and a free seat at the head. Idle
// agents wander over and sit (see the wander section below). Pure function of
// the obstructions + panel size; null when the band is too small. ---
const CONF_TABLE_W = 48 * Z;   // sprite width at the desk scale
const CONF_TABLE_H = 240;      // the 48×64 sprite stretched taller so it reads as a boardroom table
const CONF_CHAIR = 16 * Z;
// Set bbox: side chairs overhang the table 42px each side; the head seat's
// character rises 18px above the tabletop and the foot chair hangs 32px below.
const CONF_SET_W = CONF_TABLE_W + 2 * 42;
const CONF_SET_H = CONF_TABLE_H + 18 + 32;
export function computeConference(rugRects, spareDesks, decorSpots, panelWidth, panelHeight) {
  const bandTop = Math.max(FLOOR_TOP,
    ...rugRects.map(r => r.y + r.h),
    ...spareDesks.map(d => d.y + WS_H * Z));
  // Every decor spot bounds the band, not just the chats: today the divider
  // plants sit below the chat tops so this changes nothing, but if the chats
  // ever yield while the plants place, the set must not land on the plants.
  const bandBottom = Math.min(panelHeight - 3 * Z, ...decorSpots.map(s => s.y));
  // The chair overhang must also clear the entry strip on the left.
  if (panelWidth < CONF_SET_W + 2 * ENTRY_STRIP_W || bandBottom - bandTop < CONF_SET_H + 2 * DECOR_MARGIN) return null;
  const tx = Math.floor((panelWidth - CONF_TABLE_W) / 2);
  const ty = bandTop + Math.floor((bandBottom - bandTop - CONF_SET_H) / 2) + 18;
  const chairs = [
    { x: tx - 42, y: ty + 70, kind: 'confchair' },
    { x: tx - 42, y: ty + 145, kind: 'confchair' },
    { x: tx + CONF_TABLE_W - 6, y: ty + 70, kind: 'confchair', mirror: true },
    { x: tx + CONF_TABLE_W - 6, y: ty + 145, kind: 'confchair', mirror: true },
    { x: tx + Math.floor((CONF_TABLE_W - CONF_CHAIR) / 2), y: ty + CONF_TABLE_H - 16, kind: 'confchairback' },
  ];
  // Seats in fill order: head, then alternating sides top-down, foot last.
  // Head and foot sit on the table's centreline; side sitters centre on their
  // chairs. drawConference picks its draw passes by seat index (0 = head,
  // 5 = foot), so this order is load-bearing.
  const cx = tx + Math.floor((CONF_TABLE_W - CHAR_W) / 2);
  const seats = [
    { x: cx, y: ty - 18, row: CHAR_ROW_DOWN },
    { x: chairs[0].x + 8, y: chairs[0].y - 12, row: CHAR_ROW_RIGHT },
    { x: chairs[2].x + 8, y: chairs[2].y - 12, row: CHAR_ROW_RIGHT, mirror: true },
    { x: chairs[1].x + 8, y: chairs[1].y - 12, row: CHAR_ROW_RIGHT },
    { x: chairs[3].x + 8, y: chairs[3].y - 12, row: CHAR_ROW_RIGHT, mirror: true },
    { x: cx, y: ty + CONF_TABLE_H - 38, row: CHAR_ROW_UP },
  ];
  return { table: { x: tx, y: ty, w: CONF_TABLE_W, h: CONF_TABLE_H }, chairs, seats };
}

// --- Spare desks: when the office has a single row of real pods, one row of
// empty workstations sits on the pod grid one row-pitch below it, so a sparse
// office reads as unassigned seats rather than bare floor. Like the decor they
// vanish as the office fills: only while every pod is on one row and the spare
// row clears the placed decor and the panel bottom by DECOR_MARGIN. Pure;
// returns [{ x, y, variant }] top-left px per desk. ---
const SPARE_DESKS = 3;
export function computeSpareDesks(pods, decorSpots, panelWidth, panelHeight) {
  if (!pods.length || pods.some(p => p.y !== pods[0].y || p.h !== WS_H * Z)) return [];
  const pitch = (WS_W + WS_GAP_X) * Z;
  const cols = Math.round((pods[0].w + WS_GAP_X * Z) / pitch);
  // On the real row's column grid when it is one pod (centred on it, to the
  // nearest column); a multi-pod row has no single grid, so centre on the panel.
  // Fall back to centring when the aligned row would run off the panel. A row
  // that would reach into the entry strip drops a desk until it clears.
  let n = Math.min(SPARE_DESKS, maxColsFor(panelWidth)), x, rowW;
  for (; n > 0; n--) {
    rowW = (n * WS_W + (n - 1) * WS_GAP_X) * Z;
    x = pods.length === 1 ? pods[0].x + Math.round((cols - n) / 2) * pitch : Math.floor((panelWidth - rowW) / 2);
    if (x < 0 || x + rowW > panelWidth) x = Math.floor((panelWidth - rowW) / 2);
    if (x >= ENTRY_STRIP_W) break;
  }
  if (n === 0) return [];
  const row = { x, y: pods[0].y + (WS_H + WS_GAP_Y) * Z, w: rowW, h: WS_H * Z };
  if (row.y + row.h + DECOR_MARGIN > panelHeight || !decorSpots.every(s => apart(row, s))) return [];
  return Array.from({ length: n }, (_, i) => ({ x: row.x + i * pitch, y: row.y, variant: i % 2 }));
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
// mirror flips it horizontally in place (same bounding box).
function drawSprite(ctx, key, x, y, scale = DECOR_SCALE, mirror = false) {
  const img = SPRITES[key];
  if (!img) return;
  const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
  if (!mirror) { ctx.drawImage(img, x, y, w, h); return; }
  ctx.save();
  ctx.translate(x + w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0, w, h);
  ctx.restore();
}

// --- A low bookshelf run under each window: three short bookcase units
// tiled edge-to-edge, centred on the window and narrower than it, backs tight
// against the wall. The 16×16 frame's art spans x 2–14, so units step by the
// art width and the first is pulled left by the transparent margin. No
// boards (panel too narrow), no shelves. Pure; exported for the placement test. ---
const SHELF_SCALE = DECOR_SCALE;
const SHELF_UNITS = 3, SHELF_ART_X = 2, SHELF_ART_W = 12, SHELF_FRAME = 16;
const SHELF_UNIT_W = SHELF_ART_W * SHELF_SCALE, SHELF_H = SHELF_FRAME * SHELF_SCALE;
export function computeBookshelfRuns(panelWidth) {
  if (!computeBoardLayout(panelWidth).visible) return [];
  const layout = computeWallLayout(panelWidth);
  const w = SHELF_UNITS * SHELF_UNIT_W;
  return [layout.window1X, layout.window2X].map((wx) => ({
    x: Math.floor((wx + layout.windowW / 2) * Z - w / 2),
    y: WALL_BOTTOM + Z - SHELF_H,
    w, h: SHELF_H,
  }));
}

function drawBookshelves(ctx, w) {
  if (!SPRITES.bookshelf) return; // no orphan shadows under a missing sprite
  for (const run of computeBookshelfRuns(w)) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(run.x, run.y + run.h, run.w, Z); // contact shadow under the feet
    for (let i = 0; i < SHELF_UNITS; i++) {
      drawSprite(ctx, 'bookshelf', run.x + i * SHELF_UNIT_W - SHELF_ART_X * SHELF_SCALE, run.y, SHELF_SCALE);
    }
  }
}

// Brand gold (#d4a847) as an rgb triple for rgba() tints on the canvas.
const GOLD_RGB = '212, 168, 71';

// --- Per-pod rug + repo label ---
// The rug is a fixed gold, independent of the UI theme like the wood floor,
// desks and sofa it sits among: the light-theme accent is nearly the same
// colour as the floor, so a theme-tinted rug vanished in light mode. The
// repo label keeps the theme text colour.
function drawPodRug(ctx, pod, theme) {
  drawRug(ctx, podRugRect(pod), pod.label, theme);
}

function drawRug(ctx, r, label, theme) {
  const z = Z;

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

  if (label) {
    // Styled like the agent name labels below the desks.
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(${theme.tr}, ${theme.tg}, ${theme.tb}, 0.7)`;
    ctx.fillText(label, r.x + r.w / 2, r.y + 5 * z, r.w - 4 * z);
    ctx.textAlign = 'start';
  }
}

function drawDecor(ctx, spots, theme) {
  for (const spot of spots) {
    if (spot.kind === 'chat') {
      // Skip the whole group rather than draw a rug and pot around missing furniture.
      if (!SPRITES.sofa || !SPRITES.sofafront || !SPRITES.table) continue;
      drawRug(ctx, spot, null, theme);
      const tx = spot.x + CHAT_PAD_X + SOFA_W + CHAT_GAP;
      const ty = spot.y + CHAT_PAD_TOP + SOFA_FRONT_H + CHAT_GAP;
      drawSprite(ctx, 'sofafront', tx, spot.y + CHAT_PAD_TOP);
      // The side sofas' feet fill their last art row while the table's stop one
      // row short, so lift them one art pixel to share the table's floor line.
      const sy = ty + TABLE_H - SOFA_H - DECOR_SCALE;
      drawSprite(ctx, 'sofa', spot.x + CHAT_PAD_X, sy);
      drawSprite(ctx, 'table', tx, ty);
      drawSprite(ctx, 'coffee', tx + 8 * DECOR_SCALE, ty + 7 * DECOR_SCALE);
      drawSprite(ctx, 'sofa', tx + TABLE_W + CHAT_GAP, sy, DECOR_SCALE, true);
    } else {
      drawSprite(ctx, spot.kind, spot.x, spot.y, spot.scale || DECOR_SCALE);  // 'plant2' or 'cactus'
    }
  }
}

// One character in a standing frame, facing a given row; mirror turns the
// right-facing row into a left-facing one (the sheet has no left row).
function drawStanding(ctx, variant, x, y, row, mirror) {
  const sheet = SPRITES['char' + variant] || SPRITES.char0;
  if (!sheet) return;
  ctx.save();
  if (mirror) { ctx.translate(x + CHAR_W, y); ctx.scale(-1, 1); x = 0; y = 0; }
  ctx.drawImage(sheet, CHAR_COL_STAND * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H, x, y, CHAR_W, CHAR_H);
  ctx.restore();
}

// The conference set plus whoever is currently sitting at it. Sitters draw
// interleaved with the furniture so the head seat's feet tuck under the
// table's top rim and the foot chair's back covers its sitter's legs.
function drawConference(ctx, conf) {
  // Furniture is skipped when its sprites failed to load (like drawDecor),
  // but sitters ALWAYS draw: seats are claimed in updateWander regardless,
  // and a missing chair PNG must never make a character invisible.
  const furniture = SPRITES.conftable && SPRITES.confchair && SPRITES.confchairback;
  const sitters = new Map(); // seat index -> variant, arrived sitters only
  for (const [sid, seat] of confSeats) if (!wanderAnims.has(sid)) sitters.set(seat, charVariant(sid));
  const sitter = (i) => {
    if (sitters.has(i)) drawStanding(ctx, sitters.get(i), conf.seats[i].x, conf.seats[i].y, conf.seats[i].row, conf.seats[i].mirror);
  };
  if (furniture) for (const c of conf.chairs) if (c.kind === 'confchair') drawSprite(ctx, c.kind, c.x, c.y, Z, c.mirror);
  sitter(0); // head, before the table so their feet sit behind the top rim
  if (furniture) {
    const t = conf.table;
    ctx.drawImage(SPRITES.conftable, t.x, t.y, t.w, t.h);
    drawSprite(ctx, 'coffee', t.x + Math.floor(t.w / 2) - 12 * DECOR_SCALE, t.y + 50);
  }
  for (let i = 1; i <= 4; i++) sitter(i); // side sitters over their chairs
  sitter(5); // foot, before the chair-back so it covers their legs
  if (furniture) drawSprite(ctx, conf.chairs[4].kind, conf.chairs[4].x, conf.chairs[4].y, Z);
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

// --- Idle wander: an IDLE agent leaves its desk, walks to a free conference
// seat and sits there until its state changes, then walks back. Client-side
// and time-based like the walk in/out anims. confSeats holds the seat claim
// from the moment the walk starts; the character renders seated once its
// wander anim finishes. Everything clears if the conference set vanishes
// (resize) — characters simply render at their desks again next frame.
const confSeats = new Map();   // sessionId -> seat index (walking there, or seated)
const wanderAnims = new Map(); // sessionId -> { dir: 'seat'|'desk', start, variant, fromX, fromY }
let currentConf = null;        // this frame's computeConference result, for drawMotion + departures
let currentObstacles = [];     // this frame's furniture rects, for the walk routes

function updateWander(conf) {
  if (!conf) { confSeats.clear(); wanderAnims.clear(); return; }
  const taken = new Set(confSeats.values());
  for (const [sid, agent] of agents) {
    // Read-only colleagues keep their desks: the desk pass carries their
    // dimming and owner label, which the conference pass has no room for.
    const idle = agent.state === 'IDLE' && canControlAgent(agent);
    if (idle && !confSeats.has(sid) && !wanderAnims.has(sid) && !walkAnims.has(sid)) {
      const seat = conf.seats.findIndex((_, i) => !taken.has(i));
      if (seat === -1) continue; // table full — stay at the desk
      confSeats.set(sid, seat);
      taken.add(seat);
      // No walk during the connect replay (prevJobStates === null): like the
      // walk-ins, pre-existing idle agents render seated, not mid-commute.
      if (motionEnabled() && prevJobStates !== null) {
        wanderAnims.set(sid, { dir: 'seat', start: performance.now(), variant: charVariant(sid) });
      }
    } else if (!idle && confSeats.has(sid)) {
      const seatPos = conf.seats[confSeats.get(sid)];
      const midWalk = wanderAnims.get(sid)?.dir === 'seat';
      confSeats.delete(sid);
      wanderAnims.delete(sid);
      // Fully seated: walk back to the desk. Still walking over: snap back
      // rather than teleport to the seat first.
      if (!midWalk && motionEnabled()) {
        wanderAnims.set(sid, { dir: 'desk', start: performance.now(), variant: charVariant(sid), fromX: seatPos.x, fromY: seatPos.y, fromRow: seatPos.row });
      }
    }
  }
  // Deleting the current entry during Map iteration is well-defined.
  for (const sid of confSeats.keys()) if (!agents.has(sid)) confSeats.delete(sid);
  for (const sid of wanderAnims.keys()) if (!agents.has(sid)) wanderAnims.delete(sid);
}

function motionEnabled() {
  // Live query (not the module-load const): flipping the OS reduce-motion
  // setting mid-session should affect the next animation, not the next reload.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  return !reduced && !document.hidden;
}

export function hasMotion() {
  return paperAnims.length > 0 || walkAnims.size > 0 || wanderAnims.size > 0;
}

// Entrance: the left edge of the floor. There is no door — the walker appears
// at whatever height its corridor row runs at (entryRoute), so the entrance
// moves with the route instead of the route bending to reach a fixed point.
const ENTRY_X = Z;

// Multi-leg route between a desk and a conference seat that stays off the
// furniture: down the desk column to a corridor just above the set, across,
// then down the seat's own clear column (side and head columns are beside or
// above the table; the foot seat detours via the left lane, its centre column
// being the table itself, and only brushes the table's leg row on the last
// step). The initial descent can still cross a lower pod row, exactly like
// the walk in/out verticals always have. Reversed for the walk back.
// The vertical lanes just outside the chair columns — descending a seat's
// own column would clip through the chair above it, so side and foot seats
// are approached down the nearest outer lane instead. Clamped for the
// narrowest panel the set can place on.
function confLanes(conf) {
  return { left: Math.max(2, conf.table.x - 78), right: conf.table.x + conf.table.w + 46 };
}

function wanderRoute(desk, seat, conf, toSeat) {
  const yMid = conf.table.y - 24;
  const lanes = confLanes(conf);
  // Only the head seat (the sole down-facing one) is approached down its own
  // column — it sits above the table, so that column is clear.
  const laneX = seat.row === CHAR_ROW_DOWN ? seat.x
    : seat.x < conf.table.x + conf.table.w / 2 ? lanes.left : lanes.right;
  const pts = [desk, { x: desk.x, y: yMid }, { x: laneX, y: yMid }];
  if (laneX !== seat.x) pts.push({ x: laneX, y: seat.y });
  pts.push(seat);
  if (!toSeat) pts.reverse();
  return pathThrough(pts);
}

// Every rect a walk route must not cross, in one list: pod rugs, spare desks,
// decor (chat areas + plants) and the conference set with its chair overhang.
export function walkObstacles(rugs, decor, spares, conf) {
  const rects = [...rugs, ...decor, ...spares.map(d => ({ x: d.x, y: d.y, w: WS_W * Z, h: WS_H * Z }))];
  if (conf) {
    const t = conf.table;
    rects.push({ x: t.x - 42, y: t.y - 18, w: t.w + 84, h: t.h + 50 });
  }
  return rects;
}

// The clear corridor row nearest y: the obstacles' vertical spans, inverted
// into the gaps between them, gaps too narrow for a character dropped, the
// rest ranked by how close to y a walker can stand in them. Spans count full
// width — a rug half-way across still rules its rows out, which is what keeps
// this a scan rather than a search. null when nothing is clear.
export function corridorY(obstacles, panelHeight, y) {
  const spans = obstacles.map(r => [r.y, r.y + r.h]).sort((a, b) => a[0] - b[0]);
  spans.push([panelHeight, panelHeight]);
  let top = FLOOR_TOP, best = null;
  for (const [s, e] of spans) {
    if (s - top >= CHAR_H) {
      const cand = Math.round(Math.min(Math.max(y, top), s - CHAR_H));
      if (best === null || Math.abs(cand - y) < Math.abs(best - y)) best = cand;
    }
    top = Math.max(top, e);
  }
  return best;
}

// Walk in/out routes: in at the left edge on the empty floor row nearest the
// desk, straight across that row, then up or down the desk column — and the
// reverse walking out. The entrance rides on the corridor, so there is no
// vertical leg along the left strip and no fixed door height. A walk-out
// starting inside the conference set (a foot-seat sitter) steps out via the
// nearest outer lane first. The desk column leg is the approach: it crosses
// whatever rows lie between the corridor and the desk, exactly as the
// verticals always have. With no clear row at all (a packed panel) it falls
// back to the old fixed corridor.
export function entryRoute(point, conf, inbound, panelHeight, obstacles = []) {
  const yMid = corridorY(obstacles, panelHeight, point.y)
    ?? (conf ? conf.table.y - 24 : panelHeight - CHAR_H);
  // A start inside the set's footprint — chair overhang included — steps out
  // via the nearest outer lane; anywhere else its own column is already clear.
  let climb = [{ x: point.x, y: yMid }];
  if (conf) {
    const t = conf.table;
    if (point.x + CHAR_W > t.x - 42 && point.x < t.x + t.w + 42 &&
        point.y + CHAR_H > t.y - 18 && point.y < t.y + t.h + 32) {
      const laneX = point.x < t.x + t.w / 2 ? confLanes(conf).left : confLanes(conf).right;
      climb = [{ x: laneX, y: point.y }, { x: laneX, y: yMid }];
    }
  }
  const pts = [{ x: point.x, y: point.y }, ...climb, { x: ENTRY_X, y: yMid }];
  if (inbound) pts.reverse();
  return pathThrough(pts);
}

function pathThrough(pts) {
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.x !== b.x || a.y !== b.y) legs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  }
  const total = legs.reduce((s, l) => s + Math.abs(l.x1 - l.x0) + Math.abs(l.y1 - l.y0), 0);
  return { from: { x: pts[0].x, y: pts[0].y }, legs, total };
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
  // A sitter leaves from the conference table, and a mid-wander walker from
  // its current point along the walk — never a snap to a spot it isn't at.
  const desk = deskCharPos(sessionId, layout);
  const seat = currentConf && confSeats.has(sessionId) ? currentConf.seats[confSeats.get(sessionId)] : null;
  const anim = wanderAnims.get(sessionId);
  let pos = seat || desk;
  if (anim && desk && currentConf) {
    const path = anim.dir === 'seat'
      ? (seat ? wanderRoute(desk, seat, currentConf, true) : null)
      : wanderRoute(desk, { x: anim.fromX, y: anim.fromY, row: anim.fromRow }, currentConf, false);
    if (path) pos = pointAlongPath(path, ((performance.now() - anim.start) / 1000) * WALK_SPEED);
  }
  confSeats.delete(sessionId);
  wanderAnims.delete(sessionId);
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
      path = entryRoute(to, currentConf, true, h, currentObstacles);
    } else {
      path = entryRoute({ x: anim.fromX, y: anim.fromY }, currentConf, false, h, currentObstacles);
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

  // Idle wanderers between desk and conference seat. Targets resolve fresh
  // like the walk anims; wanderRoute keeps the crossing legs off the
  // conference furniture.
  for (const [sid, anim] of wanderAnims) {
    let path;
    const desk = deskCharPos(sid, layout);
    if (!desk || !currentConf) { wanderAnims.delete(sid); continue; }
    if (anim.dir === 'seat') {
      const seat = currentConf.seats[confSeats.get(sid)];
      if (!seat) { wanderAnims.delete(sid); continue; }
      path = wanderRoute(desk, seat, currentConf, true);
    } else {
      path = wanderRoute(desk, { x: anim.fromX, y: anim.fromY, row: anim.fromRow }, currentConf, false);
    }
    const dist = ((now - anim.start) / 1000) * WALK_SPEED;
    if (dist >= path.total) {
      // Hold the endpoint one frame: the seated/desk pass skipped this agent
      // before this anim was seen finishing, so it would blink out otherwise.
      drawWalker(ctx, anim.variant, pointAlongPath(path, path.total), now);
      wanderAnims.delete(sid);
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
  // Layer 4: Bookshelf runs under the windows (before the boards so easels overlap shelves)
  drawBookshelves(ctx, w);
  // Layer 5: Job boards
  drawJobBoardEasels(ctx, w);
  // Layer 6: Ambient particles
  drawParticles(ctx, w, h);

  // Per-repo pod layout, then ambient decor in whatever floor is left over
  const layout = computeOfficeLayout(w, h);
  const rugs = layout.pods.map(podRugRect);
  const decor = computeDecorPlacement(rugs, w, h);
  drawDecor(ctx, decor, theme);
  for (const pod of layout.pods) drawPodRug(ctx, pod, theme);
  // Empty workstations on the row below a sparse office: dark screens, no one seated
  const spares = computeSpareDesks(layout.pods, decor, w, h);
  for (const d of spares) drawWorkstation(ctx, d.x, d.y, 'DISCONNECTED', theme, d.variant, null);
  // Conference table in the open band below them; idle agents wander over
  currentConf = computeConference(rugs, spares, decor, w, h);
  currentObstacles = walkObstacles(rugs, decor, spares, currentConf);
  updateWander(currentConf);
  if (currentConf) drawConference(ctx, currentConf);

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
    // While a walk/wander anim exists the overlay pass draws the character,
    // and a conference sitter renders at the table — the desk stays, empty.
    const away = walkAnims.has(sessionId) || wanderAnims.has(sessionId) || confSeats.has(sessionId);
    drawWorkstation(ctx, sx, sy, state, theme, deskVariant, agent);
    drawMonitorGlow(ctx, sx, sy, state, theme);
    if (alive && sheet && !away) {
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

    if (state === 'MESSAGE' && !away) {
      // Beside the character's head — only while the character is actually
      // at the desk; a walker's bubble would float over an empty chair.
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
    // A seated agent's visible character is at the conference table, so the
    // click-to-focus affordance follows it there (the empty desk still works).
    if (currentConf) {
      for (const [sid, seatIdx] of confSeats) {
        const s = currentConf.seats[seatIdx];
        if (x >= s.x - Z && x <= s.x + CHAR_W + Z && y >= s.y - Z && y <= s.y + CHAR_H + Z) {
          switchToSession(sid);
          return;
        }
      }
    }
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
