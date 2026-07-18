// Shared mutable state — single owner for all Maps, Sets, and singletons.
// All other modules import from here. No circular deps.

import { homedir } from 'os';
import { join } from 'path';
import {
  createCodenamePool, createCocktailPool, createColorCycler,
} from '../lib/helpers.js';

// --- Constants ---
export const PORT = process.env.PORT || 7007;

// --- Network binding & origin allowlist (Phase 0: remote access) ---
// HOST controls the bind interface. Default 127.0.0.1 keeps the server
// localhost-only (single-player). Set HOST=0.0.0.0 (or a specific tailscale IP)
// to reach it from other machines — only do this behind Tailscale or another
// trusted network, since the server spawns real shells.
export const HOST = process.env.HOST || '127.0.0.1';

// Origins are matched by hostname. localhost/127.0.0.1 are always allowed so the
// local browser keeps working. Add remote hostnames (e.g. your tailnet name) via
// ALLOWED_ORIGINS, comma-separated. Entries may be bare hostnames
// (`mac-mini.tailnet.ts.net`) or full origins (`https://mac-mini:7007`) — only
// the hostname is used. A single `*` disables the check (allow any origin).
const DEFAULT_ORIGIN_HOSTS = ['localhost', '127.0.0.1'];
const rawOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
export const ALLOW_ALL_ORIGINS = rawOrigins.includes('*');
const originHostsFromEnv = rawOrigins
  .filter(o => o !== '*')
  .map(entry => {
    try { return new URL(entry).hostname; } catch {}
    try { return new URL(`http://${entry}`).hostname; } catch {}
    return entry;
  });
export const ALLOWED_ORIGIN_HOSTS = new Set([...DEFAULT_ORIGIN_HOSTS, ...originHostsFromEnv]);

// Shared origin gate for both HTTP (server/http.js) and WS (server/ws.js).
// Requests with no Origin header (same-origin browser requests, curl, native WS
// clients) are allowed through — cross-origin browsers are the threat model.
export function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOW_ALL_ORIGINS) return true;
  try {
    return ALLOWED_ORIGIN_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export const RING_BUFFER_MAX = 5000;
export const GIT_AUTO_TIMEOUT = 5000;
export const GIT_USER_TIMEOUT = 30000;
export const CONFIG_DIR = join(homedir(), '.agent-007');
export const WORKTREE_DIR = join(CONFIG_DIR, 'worktrees');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

// --- Mutable state ---
export const sessions = new Map();
export let sessionCounter = 0;
export function nextSessionId() { return `session-${++sessionCounter}`; }

export const orphans = new Map();
export const adoptingOrphans = new Set();

export let config = { version: 1, repos: [], orphans: [], activeSessions: [] };
export function setConfig(c) { config = c; }

export const knownConflictKeys = new Set();

// --- Pools ---
export const codenamePool = createCodenamePool();
export const cocktailPool = createCocktailPool();
export const colorCycler = createColorCycler();
