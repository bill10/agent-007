// Shared state store — all modules import from here
export const agents = new Map(); // sessionId -> agent object
export const repos = new Map();  // repoPath -> { slug, exists, agents: Set }
export const orphans = new Map(); // orphanId -> orphan data
export let activeSessionId = null;

export function setActiveSession(id) {
  activeSessionId = id;
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
