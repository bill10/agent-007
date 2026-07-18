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

// WebSocket close code for "authentication required/failed". Shared so the
// server and client agree (client mirrors this in public/modules/auth.js).
export const WS_UNAUTHORIZED = 4401;

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// users.json may be a bare array or a { users: [...] } wrapper. One normalizer
// so auth.js and bin/adduser.js can't drift.
export function normalizeUsers(raw) {
  return Array.isArray(raw) ? raw : (Array.isArray(raw?.users) ? raw.users : []);
}

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

export function newUserId() {
  return 'u_' + randomBytes(4).toString('hex');
}

// Sentinel served when users.json exists but can't be read/parsed and we have no
// last-known-good copy: length > 0 keeps auth ENABLED, but its unmatchable id and
// empty tokenHash reject every token. This makes a corrupt file fail CLOSED
// (deny) rather than open (silently disabling auth for the whole server).
const DENY_ALL = Object.freeze([Object.freeze({ id: '__deny__', displayName: '', color: '', tokenHash: '' })]);

// Cache keyed on mtime AND size so same-second / coarse-FS-resolution rewrites
// aren't missed (mtime alone can collide on HFS+/NFS). Refreshes without a
// restart when `adduser` changes the file.
let _cache = { key: null, users: [] };
export function loadUsers() {
  if (!existsSync(USERS_PATH)) { _cache = { key: null, users: [] }; return []; }
  try {
    const st = statSync(USERS_PATH);
    const key = `${st.mtimeMs}:${st.size}`;
    if (key === _cache.key) return _cache.users;
    const users = normalizeUsers(JSON.parse(readFileSync(USERS_PATH, 'utf8')));
    _cache = { key, users };
    return users;
  } catch (err) {
    // File exists but couldn't be read/parsed. NEVER disable auth on error:
    // serve the last known-good users if we have them, otherwise deny everything.
    console.warn('users.json unreadable — failing closed (auth stays on):', err.message);
    return _cache.users.length ? _cache.users : DENY_ALL;
  }
}

export function authEnabled() {
  return loadUsers().length > 0;
}

// The shape safe to send to clients (never includes tokenHash).
export function publicUser(u) {
  return u && { id: u.id, displayName: u.displayName, color: u.color };
}

// Look up a user by id (for labeling session owners). Returns publicUser or null.
export function userById(id) {
  if (!id) return null;
  return publicUser(loadUsers().find(u => u.id === id)) || null;
}

// Resolve a bearer token to a user, or null. Constant-time compare against each
// stored hash so a wrong token can't be distinguished by timing.
export function resolveToken(token) {
  if (!token) return null;
  const presented = Buffer.from(hashToken(token), 'utf8');
  for (const u of loadUsers()) {
    // Skip malformed records; the length guard also satisfies timingSafeEqual's
    // equal-length requirement (hex strings of equal length → equal-size buffers).
    if (!u.tokenHash || u.tokenHash.length !== presented.length) continue;
    if (timingSafeEqual(Buffer.from(u.tokenHash, 'utf8'), presented)) return u;
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
