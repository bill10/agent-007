// Identity & auth (multiplayer phase 1)
//
// Users live in ~/.agent-007/users.json (separate from config.json so the
// `adduser` CLI never races the server's session writes and needs no restart).
// Each user: { id, displayName, color, tokenHash, createdAt }. Tokens are
// bearer secrets — only the SHA-256 hash is stored, never the plaintext.
//
// Auth is OFF until the first user exists: with zero users the server behaves
// exactly as it did before (open localhost single-player). Creating a user with
// `npm run adduser` flips the server into authenticated mode. This keeps the
// zero-config clone-and-run experience intact while enabling multiplayer.
//
// NOTE: like the origin check, this is a trust/identity layer, not a sandbox —
// every authenticated user can still spawn shells on this machine. Only issue
// tokens to people you'd give an SSH login. See docs/designs/multiplayer.md.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const USERS_PATH = process.env.AGENT007_USERS_PATH
  || join(homedir(), '.agent-007', 'users.json');

// Distinct-per-user accent palette (separate from the per-agent color cycle).
export const USER_COLORS = [
  '#d4a847', '#58a6ff', '#7fbc6a', '#e0853a', '#bc8cff', '#76d9e6', '#ff7b72', '#e3b341',
];

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

export function newUserId() {
  return 'u_' + randomBytes(4).toString('hex');
}

// mtime-cached read so per-request auth doesn't hit disk every time, but a fresh
// `adduser` is picked up without a server restart.
let _cache = { mtimeMs: -1, users: [] };
export function loadUsers() {
  try {
    if (!existsSync(USERS_PATH)) { _cache = { mtimeMs: -1, users: [] }; return []; }
    const mtimeMs = statSync(USERS_PATH).mtimeMs;
    if (mtimeMs === _cache.mtimeMs) return _cache.users;
    const raw = JSON.parse(readFileSync(USERS_PATH, 'utf8'));
    const users = Array.isArray(raw) ? raw : (Array.isArray(raw.users) ? raw.users : []);
    _cache = { mtimeMs, users };
    return users;
  } catch (err) {
    console.warn('users.json unreadable, treating as no users:', err.message);
    return [];
  }
}

export function authEnabled() {
  return loadUsers().length > 0;
}

// The shape safe to send to clients (never includes tokenHash).
export function publicUser(u) {
  return u && { id: u.id, displayName: u.displayName, color: u.color };
}

// Resolve a bearer token to a user, or null. Constant-time compare against each
// stored hash so a wrong token can't be distinguished by timing.
export function resolveToken(token) {
  if (!token) return null;
  const presented = Buffer.from(hashToken(token), 'utf8');
  for (const u of loadUsers()) {
    if (!u.tokenHash || u.tokenHash.length !== presented.length) continue;
    const stored = Buffer.from(u.tokenHash, 'utf8');
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      return u;
    }
  }
  return null;
}

// Pull a bearer token from an Express request: Authorization header first,
// then a ?token= query param (needed for the WebSocket handshake, where the
// browser can't set headers).
export function tokenFromRequest(req) {
  const auth = req.headers?.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch {}
  return null;
}
