// Pixel office rendering — canvas drawing, click handling, animation
import { agents, activeSessionId } from './state.js';
import { switchToSession } from './terminal.js';

const Z = 3;

const CHAR_PALETTES = [
  { hair: '#2c1810', skin: '#f5c5a3', shirt: '#4a90d9', pants: '#2c3e50' },
  { hair: '#c0392b', skin: '#e8beac', shirt: '#27ae60', pants: '#1a332a' },
  { hair: '#daa520', skin: '#ffdbac', shirt: '#8e44ad', pants: '#3d2b50' },
  { hair: '#1a1a2e', skin: '#8d5524', shirt: '#e74c3c', pants: '#4a2020' },
  { hair: '#8b4513', skin: '#d4a373', shirt: '#f39c12', pants: '#3d3020' },
  { hair: '#f5a623', skin: '#c68642', shirt: '#2980b9', pants: '#1a2a40' },
  { hair: '#5d4037', skin: '#f5c5a3', shirt: '#16a085', pants: '#0d3028' },
  { hair: '#34495e', skin: '#d4a373', shirt: '#e67e22', pants: '#3d2a10' },
  { hair: '#922b21', skin: '#ffdbac', shirt: '#34495e', pants: '#1a1a2e' },
  { hair: '#4a235a', skin: '#e8beac', shirt: '#c0392b', pants: '#3d1a1a' },
];

const WALL_H = 36 * Z;
const WALL_BOTTOM = WALL_H + 2 * Z;
const WS_W = 32, WS_H = 36, WS_GAP_X = 12, WS_GAP_Y = 18;
const COUCH_BUFFER = 24; // Z-units below baseboard reserved for U-shaped seating + plants

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

// --- Furniture sprites ---
// Seating: LPC Revised Base Object Kit (CC-BY-SA 3.0)
// Desk/Plant: Free Furniture Office Equipment Set by Antea (CC-BY 4.0)
const SPRITE_PATHS = {
  sofa:    'assets/furniture/sofa_front.png',       // 53×32 brown casual sofa (front view)
  chairL:  'assets/furniture/armchair_left.png',    // 24×32 armchair faces left
  chairR:  'assets/furniture/armchair_right.png',   // 24×32 armchair faces right
  plant:   'assets/furniture/plant_big.png',         // 32×32 potted office plant (Antea CC-BY 4.0)
  table:   'assets/furniture/table_small.png',      // 32×32 small round table
  desk:    'assets/furniture/desk.png',             // 32×32 computer desk with monitor
  desk2:   'assets/furniture/desk2.png',            // 32×32 alt desk layout
};
// Desk sprite: monitor part is in top 12 rows — we skip it and draw our own
const DESK_CROP_Y = 13;
// Per-desk-variant positions (in sprite pixels)
const DESK_MON_X = 3;    // Desk.png: monitor at x=3-16, center ~9
const DESK2_MON_X = 13;  // Desk-2.png: monitor at x=13-26, center ~19
const DESK_CHAR_X = 5;   // character X offset for Desk.png (centered on keyboard)
const DESK2_CHAR_X = 15; // character X offset for Desk-2.png
const SPRITES = {};
let spritesLoaded = false;

function loadSprites() {
  if (spritesLoaded) return Promise.resolve();
  const promises = Object.entries(SPRITE_PATHS).map(([key, path]) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { SPRITES[key] = img; resolve(); };
      img.onerror = () => resolve(); // graceful fallback
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

// --- Grid layout: center workstations horizontally, and vertically within
// the open floor (below the windows + seating zone). Centering in the FULL
// panel height left the desks floating mid-canvas with a large dead band of
// empty floor below them when only a few agents were running. ---
const FLOOR_TOP = WALL_BOTTOM + 26 * Z; // reserve the top zone for windows + couches
function computeGridLayout(agentCount, panelWidth, panelHeight) {
  const maxCols = Math.max(1, Math.min(4, Math.floor((panelWidth / Z + WS_GAP_X) / (WS_W + WS_GAP_X))));
  const count = Math.max(1, agentCount);
  const cols = Math.min(count, maxCols);
  const rows = Math.ceil(count / cols);

  const gridW = (cols * WS_W + (cols - 1) * WS_GAP_X) * Z;
  const gridH = (rows * WS_H + (rows - 1) * WS_GAP_Y) * Z;

  const startX = Math.floor((panelWidth - gridW) / 2);

  // Center within [FLOOR_TOP, panelHeight]; never start above the floor.
  const startY = Math.max(FLOOR_TOP, Math.floor(FLOOR_TOP + (panelHeight - FLOOR_TOP - gridH) / 2));

  return { startX, startY, cols };
}

function getWsScreenPos(idx, layout) {
  const col = idx % layout.cols;
  const row = Math.floor(idx / layout.cols);
  return {
    x: layout.startX + col * (WS_W + WS_GAP_X) * Z,
    y: layout.startY + row * (WS_H + WS_GAP_Y) * Z,
  };
}

// --- Color helpers ---
function lightenColor(hex, amount) {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
  return `rgb(${r}, ${g}, ${b})`;
}

function warmLighten(hex, amount) {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + Math.round(amount * 1.3));
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + Math.round(amount * 1.1));
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + Math.round(amount * 0.7));
  return `rgb(${r}, ${g}, ${b})`;
}

function coolLighten(hex, amount) {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + Math.round(amount * 0.85));
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + Math.round(amount * 1.0));
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + Math.round(amount * 1.2));
  return `rgb(${r}, ${g}, ${b})`;
}

function darkenColor(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.floor(r * factor)}, ${Math.floor(g * factor)}, ${Math.floor(b * factor)})`;
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

// --- Seating areas under bookshelves (3 U-shaped reading nooks, sprite-based) ---
function drawSeatingAreas(ctx, w) {
  if (!SPRITES.sofa || !SPRITES.chairL || !SPRITES.chairR) return;
  const z = Z;
  const layout = computeWallLayout(w);

  // Sprite scaling — fit sofa to ~22Z wide
  const sofaScale = (22 * z) / SPRITES.sofa.naturalWidth;
  const sofaW = Math.floor(SPRITES.sofa.naturalWidth * sofaScale);
  const sofaH = Math.floor(SPRITES.sofa.naturalHeight * sofaScale);

  // Armchairs: scale to ~10Z wide (left faces right, right faces left)
  const chairLScale = (10 * z) / SPRITES.chairL.naturalWidth;
  const chairLW = Math.floor(SPRITES.chairL.naturalWidth * chairLScale);
  const chairLH = Math.floor(SPRITES.chairL.naturalHeight * chairLScale);

  const chairRScale = (10 * z) / SPRITES.chairR.naturalWidth;
  const chairRW = Math.floor(SPRITES.chairR.naturalWidth * chairRScale);
  const chairRH = Math.floor(SPRITES.chairR.naturalHeight * chairRScale);

  // In 3/4 top-down perspective, the sofa "back" is the top edge of the sprite.
  // Move sofa UP so its back overlaps with the baseboard (touching the wall).
  const seatY = WALL_BOTTOM - Math.floor(sofaH * 0.3);

  const shelfXs = [layout.shelf1X, layout.shelf2X, layout.shelf3X];

  for (const shX of shelfXs) {
    const centerX = Math.floor((shX + layout.shelfW / 2) * z);

    // Sofa (centered under shelf, back against wall)
    const sx = centerX - Math.floor(sofaW / 2);
    ctx.drawImage(SPRITES.sofa, sx, seatY, sofaW, sofaH);

    // Coffee table (centered below sofa)
    if (SPRITES.table) {
      const tableScale = (8 * z) / SPRITES.table.naturalWidth;
      const tableW = Math.floor(SPRITES.table.naturalWidth * tableScale);
      const tableH = Math.floor(SPRITES.table.naturalHeight * tableScale);
      ctx.drawImage(SPRITES.table, centerX - Math.floor(tableW / 2), seatY + sofaH + z, tableW, tableH);
    }

    // Inverse U: left position uses right-facing chair, right uses left-facing
    const chairY = seatY + sofaH - 4 * z;
    ctx.drawImage(SPRITES.chairR, sx - chairRW, chairY, chairRW, chairRH);
    ctx.drawImage(SPRITES.chairL, sx + sofaW, chairY, chairLW, chairLH);
  }
}

// --- Potted plants under windows (sprite-based) ---
function drawPlants(ctx, w) {
  if (!SPRITES.plant) return;
  const z = Z;
  const layout = computeWallLayout(w);
  const windowXs = [layout.window1X * z, layout.window2X * z];
  const ww = layout.windowW * z;

  const plantScale = (16 * z) / SPRITES.plant.naturalWidth;
  const plantW = Math.floor(SPRITES.plant.naturalWidth * plantScale);
  const plantH = Math.floor(SPRITES.plant.naturalHeight * plantScale);
  // 3/4 perspective: pot back touches the wall — pot top is ~55% down the sprite
  const plantY = WALL_BOTTOM - Math.floor(plantH * 0.65);

  for (const wx of windowXs) {
    const center = wx + Math.floor(ww / 2);
    ctx.drawImage(SPRITES.plant, center - 6 * z - plantW, plantY, plantW, plantH);
    ctx.drawImage(SPRITES.plant, center + 6 * z, plantY, plantW, plantH);
  }
}

// --- Per-workstation carpet ---
function drawWorkstationCarpet(ctx, sx, sy, theme) {
  const z = Z;
  const carpetW = 38 * z;  // wider than workstation (32), covers full area
  const carpetH = 38 * z;  // tall enough to cover desk + character + name
  const cx = sx + Math.floor((WS_W * z - carpetW) / 2);
  const cy = sy - z;  // start slightly above workstation top

  // Fill
  ctx.fillStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.22)`;
  ctx.fillRect(cx, cy, carpetW, carpetH);

  // Outer border
  ctx.strokeStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.40)`;
  ctx.lineWidth = 1;
  ctx.strokeRect(cx, cy, carpetW, carpetH);

  // Inner border (double-border pattern)
  ctx.strokeStyle = `rgba(${theme.ar}, ${theme.ag}, ${theme.ab}, 0.18)`;
  ctx.strokeRect(cx + 2 * z, cy + 2 * z, carpetW - 4 * z, carpetH - 4 * z);
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
function drawWorkstation(ctx, sx, sy, state, theme, idx, agent) {
  const z = Z;
  const deskSprite = idx % 2 === 0 ? SPRITES.desk : SPRITES.desk2;

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

  // --- Modern edgeless monitor (procedural, positioned where sprite monitor was) ---
  const mw = 14, mh = 9;  // monitor outer size in Z-units
  const monX = idx % 2 === 0 ? DESK_MON_X : DESK2_MON_X;
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

// Front-facing character (WAITING, IDLE, MESSAGE)
function drawCharacterFront(ctx, x, y, palette) {
  const z = Z;
  const { hair, skin, shirt, pants } = palette;
  const skinDark = darkenColor(skin, 0.82);
  const shirtDark = darkenColor(shirt, 0.7);
  const pantsDark = darkenColor(pants, 0.7);
  // Hair
  ctx.fillStyle = hair;
  ctx.fillRect(x + 2 * z, y, 6 * z, z);           // rounded top
  ctx.fillRect(x + z, y + z, 8 * z, z);
  ctx.fillRect(x, y + 2 * z, z, z);                // sideburns
  ctx.fillRect(x + 9 * z, y + 2 * z, z, z);
  ctx.fillRect(x + 2 * z, y + 2 * z, 2 * z, z);   // eyebrow line
  ctx.fillRect(x + 6 * z, y + 2 * z, 2 * z, z);
  // Face
  ctx.fillStyle = skin;
  ctx.fillRect(x + z, y + 2 * z, 8 * z, 5 * z);
  ctx.fillStyle = skinDark;
  ctx.fillRect(x, y + 3 * z, z, 2 * z);            // ears
  ctx.fillRect(x + 9 * z, y + 3 * z, z, 2 * z);
  // Eyes
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + 2 * z, y + 3 * z, 2 * z, 2 * z);
  ctx.fillRect(x + 6 * z, y + 3 * z, 2 * z, 2 * z);
  ctx.fillStyle = '#222';
  ctx.fillRect(x + 3 * z, y + 4 * z, z, z);
  ctx.fillRect(x + 7 * z, y + 4 * z, z, z);
  // Nose + mouth
  ctx.fillStyle = skinDark;
  ctx.fillRect(x + 4 * z, y + 5 * z, 2 * z, z);
  ctx.fillRect(x + 4 * z, y + 6 * z, 2 * z, z);
  // Chin
  ctx.fillStyle = skin;
  ctx.fillRect(x + 3 * z, y + 7 * z, 4 * z, z);
  // Shirt body
  ctx.fillStyle = shirt;
  ctx.fillRect(x + z, y + 8 * z, 8 * z, 4 * z);
  ctx.fillStyle = shirtDark;
  ctx.fillRect(x + 3 * z, y + 8 * z, 4 * z, z);   // collar shadow
  // Arms
  ctx.fillStyle = shirt;
  ctx.fillRect(x, y + 9 * z, z, 2 * z);
  ctx.fillRect(x + 9 * z, y + 9 * z, z, 2 * z);
  ctx.fillStyle = skin;
  ctx.fillRect(x, y + 11 * z, z, z);               // hands
  ctx.fillRect(x + 9 * z, y + 11 * z, z, z);
  // Belt
  ctx.fillStyle = pantsDark;
  ctx.fillRect(x + z, y + 12 * z, 8 * z, z);
  // Pants
  ctx.fillStyle = pants;
  ctx.fillRect(x + z, y + 13 * z, 3 * z, z);
  ctx.fillRect(x + 6 * z, y + 13 * z, 3 * z, z);
  // Shoes
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(x + z, y + 14 * z, 3 * z, z);
  ctx.fillRect(x + 6 * z, y + 14 * z, 3 * z, z);
}

// Back-facing character (WORKING)
function drawCharacterBack(ctx, x, y, palette) {
  const z = Z;
  const { hair, skin, shirt, pants } = palette;
  const shirtDark = darkenColor(shirt, 0.7);
  const hairDark = darkenColor(hair, 0.8);
  const pantsDark = darkenColor(pants, 0.7);
  // Hair (full block from back)
  ctx.fillStyle = hair;
  ctx.fillRect(x + 2 * z, y, 6 * z, z);             // top row
  ctx.fillRect(x + z, y + z, 8 * z, z);              // second row
  ctx.fillRect(x, y + 2 * z, 10 * z, 3 * z);          // rows 2-4: full back
  ctx.fillRect(x + z, y + 5 * z, 8 * z, 2 * z);      // rows 5-6: 1px less each side
  ctx.fillStyle = hairDark;
  ctx.fillRect(x + 4 * z, y + z, 2 * z, z);          // part line
  ctx.fillRect(x + 3 * z, y + 3 * z, 4 * z, z);      // texture
  // Neck
  ctx.fillStyle = skin;
  ctx.fillRect(x + 3 * z, y + 7 * z, 4 * z, z);
  // Ears
  ctx.fillStyle = darkenColor(skin, 0.82);
  ctx.fillRect(x, y + 3 * z, z, 2 * z);
  ctx.fillRect(x + 9 * z, y + 3 * z, z, 2 * z);
  // Shirt body
  ctx.fillStyle = shirt;
  ctx.fillRect(x + z, y + 8 * z, 8 * z, 4 * z);
  ctx.fillStyle = shirtDark;
  ctx.fillRect(x + 2 * z, y + 8 * z, 6 * z, z);   // collar shadow
  // Arms + typing animation
  const tick = Math.floor(Date.now() / 150);
  const leftUp = (tick % 4) < 2;
  ctx.fillStyle = shirt;
  ctx.fillRect(x, y + 9 * z, z, 2 * z);
  ctx.fillRect(x + 9 * z, y + 9 * z, z, 2 * z);
  ctx.fillStyle = skin;
  ctx.fillRect(x, y + (leftUp ? 10 : 11) * z, z, z);
  ctx.fillRect(x + 9 * z, y + (leftUp ? 11 : 10) * z, z, z);
  // Belt
  ctx.fillStyle = pantsDark;
  ctx.fillRect(x + z, y + 12 * z, 8 * z, z);
  // Pants
  ctx.fillStyle = pants;
  ctx.fillRect(x + z, y + 13 * z, 3 * z, z);
  ctx.fillRect(x + 6 * z, y + 13 * z, 3 * z, z);
  // Shoes
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(x + z, y + 14 * z, 3 * z, z);
  ctx.fillRect(x + 6 * z, y + 14 * z, 3 * z, z);
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

export function renderOffice() {
  const canvas = document.getElementById('office-canvas');
  const panel = document.getElementById('office-panel');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = panel.offsetWidth * dpr;
  canvas.height = panel.offsetHeight * dpr;
  canvas.style.width = `${panel.offsetWidth}px`;
  canvas.style.height = `${panel.offsetHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const theme = getThemeColors();

  // Layer 1: Floor (warm wood planks)
  drawFloor(ctx, w, h);
  // Layer 2: Walls (warm plaster)
  drawWalls(ctx, w);
  // Layer 3: Windows (2 windows with day/night + light beams)
  drawWindows(ctx, w, theme);
  // Layer 4: (bookshelves removed — bare plaster wall)
  // Layer 5: Seating areas (brown leather couches + chairs under shelves)
  drawSeatingAreas(ctx, w);
  // Layer 5b: Potted plants (under windows)
  drawPlants(ctx, w);
  // Layer 6: Ambient particles
  drawParticles(ctx, w, h);

  // Compute centered grid layout
  const layout = computeGridLayout(agents.size, w, h);

  let idx = 0;
  for (const [sessionId, agent] of agents) {
    const { x: sx, y: sy } = getWsScreenPos(idx, layout);
    const isActive = sessionId === activeSessionId;
    const palette = CHAR_PALETTES[idx % CHAR_PALETTES.length];
    const state = agent.state;
    const alive = state !== 'DISCONNECTED';

    drawWorkstation(ctx, sx, sy, state, theme, idx, agent);
    drawMonitorGlow(ctx, sx, sy, state, theme);

    if (alive) {
      const charX = sx + (idx % 2 === 0 ? DESK_CHAR_X : DESK2_CHAR_X) * Z;
      if (state === 'WORKING') {
        drawCharacterBack(ctx, charX, sy + 13 * Z, palette);
      } else {
        drawCharacterFront(ctx, charX, sy + 18 * Z, palette);
      }
    }

    if (agent.name) {
      const nameY = sy + 37 * Z;
      const nameX = sx + (WS_W / 2) * Z;
      ctx.textAlign = 'center';

      if (!isActive) {
        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = `rgba(${theme.tr}, ${theme.tg}, ${theme.tb}, 0.7)`;
        ctx.fillText(agent.name, nameX, nameY);
      } else {
        // Pulsing glow
        const pulse = Math.sin(Date.now() / 600) * 0.5 + 0.5;
        ctx.font = 'bold 11px monospace';
        ctx.shadowColor = `rgba(212, 168, 71, ${0.4 + pulse * 0.5})`;
        ctx.shadowBlur = 6 + pulse * 8;
        ctx.fillStyle = '#d4a847';
        ctx.fillText(agent.name, nameX, nameY);
        ctx.fillText(agent.name, nameX, nameY);
        ctx.shadowBlur = 0;
      }
      ctx.textAlign = 'start';
    }

    if (state === 'MESSAGE') {
      const charX = sx + (idx % 2 === 0 ? DESK_CHAR_X : DESK2_CHAR_X) * Z;
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


    idx++;
  }
}

export function setupOfficeClick() {
  const canvas = document.getElementById('office-canvas');
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const layout = computeGridLayout(agents.size, rect.width, rect.height);
    let idx = 0;
    for (const [sessionId] of agents) {
      const pos = getWsScreenPos(idx, layout);
      const sw = WS_W * Z, sh = (WS_H + 6) * Z;
      if (x >= pos.x - Z && x <= pos.x + sw + Z &&
          y >= pos.y - Z && y <= pos.y + sh + Z) {
        switchToSession(sessionId);
        return;
      }
      idx++;
    }
  });
}

export function startAnimationLoop() {
  function loop() {
    const hasLiving = [...agents.values()].some(a => a.state !== 'DISCONNECTED');
    if (hasLiving) renderOffice();
    requestAnimationFrame(loop);
  }
  loop();
}
