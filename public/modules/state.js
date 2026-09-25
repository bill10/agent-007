// Shared state store — all modules import from here
export const agents = new Map(); // sessionId -> agent object
export const repos = new Map();  // repoPath -> { slug, exists, agents: Set }
export const orphans = new Map(); // orphanId -> orphan data
export let activeSessionId = null;

export function setActiveSession(id) {
  activeSessionId = id;
}

// The job board shares the terminal panel with the agent tabs. activeSessionId
// is deliberately left untouched while the board is showing, so dismissing the
// board returns you to the terminal you were on.
export let boardActive = false;
export function setBoardActive(on) { boardActive = !!on; }

export const jobs = new Map(); // jobId -> job record from the server
export let boardSettings = { running: false, maxPerRepo: 2, intervalMs: 300000, permissionMode: 'auto' };
export function setBoardSettings(s) { boardSettings = { ...boardSettings, ...s }; }

// --- Viewer identity & ownership (phase 2) ---
export let selfUserId = null;
export let authEnabled = false;
export let serverPlatform = ''; // process.platform of the server, from the welcome message

// Whether this server runs Billion (server/billion.js). The explorer keeps its
// row pinned even while it is stopped, so there is always a way to start it.
export let billionEnabled = false;
export function setBillionEnabled(on) { billionEnabled = !!on; }

// Billion's notify_owner messages the owner has not dismissed (server/owner.js).
export let waitingItems = [];
export function setWaitingItems(items) { waitingItems = Array.isArray(items) ? items : []; }

// Billion's tab first, then the rest in their own order.
export function billionFirst(entries) {
  return [...entries].sort(([, a], [, b]) => Number(!!b.isBillion) - Number(!!a.isBillion));
}

export function setSelf(userId, enabled, platform) {
  selfUserId = userId;
  authEnabled = !!enabled;
  if (platform) serverPlatform = platform;
}

// The shell preset offered in the spawn form follows the server's OS —
// commands run there, not in the browser.
export function shellPreset() {
  return serverPlatform === 'win32'
    ? { label: 'PowerShell', cmd: 'powershell.exe' }
    : { label: 'Bash', cmd: 'bash' };
}

// True if the current viewer may control this agent: always in single-player
// (auth off) or for unowned agents; otherwise only the owner. Server enforces
// this regardless — the client guard just avoids a broken "type → nothing" feel.
export function canControlAgent(agent) {
  if (!authEnabled) return true;
  if (!agent || !agent.ownerId) return true;
  return agent.ownerId === selfUserId;
}

// Which panel a phone shows (body[data-view], see .mobile-nav in style.css).
// Set unconditionally: desktop CSS ignores it, so no width check is needed.
export function setView(view) {
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll('.mobile-nav button')) b.setAttribute('aria-current', b.dataset.view === view);
}

export function stateColor(state) {
  switch (state) {
    case 'WORKING': return 'var(--state-working)';
    case 'WAITING': return 'var(--state-waiting)';
    case 'MESSAGE': return 'var(--state-message)';
    case 'IDLE': return 'var(--state-idle)';
    case 'DISCONNECTED': return 'var(--state-disconnected)';
    default: return 'var(--state-idle)';
  }
}
