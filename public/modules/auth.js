// Client-side identity & login (phase 1)
const TOKEN_KEY = 'agent007-token';

// Mirrors WS_UNAUTHORIZED in server/auth.js — keep in sync.
export const WS_UNAUTHORIZED = 4401;
export const DEFAULT_LOGIN_MESSAGE = 'Enter your access token to continue.';

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const safeColor = (c) => /^#[0-9a-fA-F]{3,8}$/.test(String(c)) ? c : 'var(--accent)';

// On load, pull ?token= out of the URL, persist it, and strip it from the
// address bar so it doesn't linger in history or get shared accidentally.
export function captureTokenFromUrl() {
  try {
    const url = new URL(location.href);
    if (url.searchParams.get('token')) {
      localStorage.setItem(TOKEN_KEY, url.searchParams.get('token'));
      url.searchParams.delete('token');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch {}
}

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

// Spread into fetch() options so /api calls carry the bearer token.
export function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Full-screen login overlay. Submitting stores the token and reloads so every
// connection (WS + fetch) picks it up cleanly.
export function showLogin(message = DEFAULT_LOGIN_MESSAGE) {
  const existing = document.getElementById('login-overlay');
  if (existing) {
    if (message) existing.querySelector('#login-message').textContent = message;
    return;
  }
  const overlay = document.createElement('div');
  overlay.id = 'login-overlay';
  overlay.className = 'login-overlay';
  overlay.innerHTML = `
    <form class="login-box" id="login-form">
      <div class="login-title">Agent 007</div>
      <div class="login-subtitle">Enter your access token</div>
      <input type="password" id="login-token" class="login-input" placeholder="Paste token" autocomplete="off" spellcheck="false">
      <button type="submit" class="login-submit">Enter</button>
      <div class="login-message" id="login-message">${message || ''}</div>
    </form>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#login-form').onsubmit = (e) => {
    e.preventDefault();
    const val = overlay.querySelector('#login-token').value.trim();
    if (!val) return;
    setToken(val);
    location.reload();
  };
  overlay.querySelector('#login-token').focus();
}

// Minimal presence pill: who's online right now (Phase 3 grows this into the
// office). Hidden when auth is off or nobody is present.
export function renderPresence(users, selfId) {
  let el = document.getElementById('presence');
  if (!el) {
    el = document.createElement('div');
    el.id = 'presence';
    el.className = 'presence';
    document.body.appendChild(el);
  }
  if (!users || users.length === 0) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = users.map(u => {
    const initials = (u.displayName || '?').trim().slice(0, 2).toUpperCase();
    const isSelf = u.id === selfId;
    const title = escapeHtml(u.displayName) + (isSelf ? ' (you)' : '');
    return `<span class="presence-dot${isSelf ? ' presence-self' : ''}" style="background:${safeColor(u.color)}" title="${title}">${escapeHtml(initials)}</span>`;
  }).join('');
}
