// Shared state store — all modules import from here
export const agents = new Map(); // sessionId -> agent object
export const repos = new Map();  // repoPath -> { slug, exists, agents: Set }
export const orphans = new Map(); // orphanId -> orphan data
export let activeSessionId = null;

export function setActiveSession(id) {
  activeSessionId = id;
}

// --- Viewer identity & ownership (phase 2) ---
export let selfUserId = null;
export let authEnabled = false;

export function setSelf(userId, enabled) {
  selfUserId = userId;
  authEnabled = !!enabled;
}

// True if the current viewer may control this agent: always in single-player
// (auth off) or for unowned agents; otherwise only the owner. Server enforces
// this regardless — the client guard just avoids a broken "type → nothing" feel.
export function canControlAgent(agent) {
  if (!authEnabled) return true;
  if (!agent || !agent.ownerId) return true;
  return agent.ownerId === selfUserId;
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
