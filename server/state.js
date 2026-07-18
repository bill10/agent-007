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

// Loopback binds are localhost-only (never warn about remote exposure); wildcard
// binds accept remote connections. Shared so server.js and the origin logic agree
// on what "local" is. (These are HOST bind-string forms — `::1`, not `[::1]`.)
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
export const WILDCARD_BIND_HOSTS = ['0.0.0.0', '::'];

// Origins are matched by hostname. Loopback hosts are always allowed so the local
// browser keeps working (note: the IPv6 loopback Origin header serializes as the
// bracketed `[::1]`). Add remote hostnames (e.g. your tailnet name) via
// ALLOWED_ORIGINS, comma-separated. Entries may be bare hostnames
// (`mac-mini.tailnet.ts.net`), host:port (`mac-mini:7007`), or full origins
// (`https://mac-mini:7007`) — only the hostname is used. A single `*` disables
// the check entirely (allows ANY origin): on the default localhost bind that lets
// any website you visit drive the server through your browser — avoid it.
const DEFAULT_ORIGIN_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const rawOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_ALL_ORIGINS = rawOrigins.includes('*');
const originHostsFromEnv = rawOrigins
  .filter(o => o !== '*')
  .map(entry => {
    // Add a scheme when the entry lacks one, else new URL() parses a bare
    // "host:port" as scheme+path and yields an empty hostname (silent lockout).
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `http://${entry}`;
    try { return new URL(withScheme).hostname; } catch { return null; }
  })
  .filter(Boolean);
const ALLOWED_ORIGIN_HOSTS = new Set([...DEFAULT_ORIGIN_HOSTS, ...originHostsFromEnv]);

// Shared origin gate for both HTTP (server/http.js) and WS (server/ws.js).
// Requests with no Origin header (same-origin browser requests, curl, native WS
// clients) are allowed through — cross-origin browsers are the threat model.
// NOTE: this only blocks cross-origin *browser* requests; it is NOT access
// control. Non-browser clients send no Origin and pass. When HOST is remote, the
// network boundary (Tailscale / trusted LAN) is what actually gates access.
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
