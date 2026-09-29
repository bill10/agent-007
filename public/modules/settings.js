// The Settings panel behind the gear in the terminal header. Its one section,
// "Agents & accounts", shows the server's last scan of installed agent CLIs and
// their login folders (GET /api/agent-accounts); Refresh rescans (POST).
// Read-only.

import { authHeaders, showLogin, escapeHtml } from './auth.js';

const tilde = (p, home) => (home && /^[\\/]/.test(p.slice(home.length)) && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

// The two Billion and the board run on: named even when missing, with where
// to get them (server/command-path.js has the same hints).
const WANTED = {
  claude: 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup',
  codex: 'Install Codex: npm install -g @openai/codex',
};

export function renderAgents(agents) {
  const missing = Object.entries(WANTED).filter(([cli]) => !agents.some(a => a.cli === cli)).map(([cli, hint]) => `
    <div class="settings-agent">
      <div class="settings-agent-line"><span class="settings-agent-name">${cli}</span> <span class="settings-status out">not installed</span></div>
      <div class="settings-path">${escapeHtml(hint)}, then restart Agent 007</div>
    </div>`).join('');
  if (!agents.length) return `<p class="settings-empty">No agent CLIs found on the PATH.</p>${missing}`;
  // The home dir, guessed from the default folders, only to shorten paths.
  const home = agents.flatMap(a => a.accounts).map(a => a.folder.match(/^(.*)[\\/]\.(claude|codex|gemini)$/)?.[1]).find(Boolean);
  return agents.map(a => `
    <div class="settings-agent">
      <div class="settings-agent-line"><span class="settings-agent-name">${escapeHtml(a.cli)}</span>${a.version ? ` <span class="settings-dim">${escapeHtml(a.version)}</span>` : ''}</div>
      <div class="settings-path" title="${escapeHtml(a.path)}">${escapeHtml(tilde(a.path, home))}</div>
      ${a.accounts.map(acc => `
        <div class="settings-account">
          <span class="settings-folder" title="${escapeHtml(acc.folder)}">${escapeHtml(tilde(acc.folder, home))}</span>${acc.isDefault ? ' <span class="settings-tag">default</span>' : ''}
          ${acc.email ? `<span class="settings-email">${escapeHtml(acc.email)}</span>` : ''}
          ${acc.plan ? `<span class="settings-dim">${escapeHtml(acc.plan)}</span>` : ''}
          ${acc.org ? `<span class="settings-dim">${escapeHtml(acc.org)}</span>` : ''}
          ${acc.loggedIn === null ? '' : `<span class="settings-status ${acc.loggedIn ? 'in' : 'out'}">${acc.loggedIn ? 'logged in' : 'logged out'}</span>`}
        </div>`).join('')}
      ${!a.accounts.length && WANTED[a.cli] ? '<div class="settings-account"><span class="settings-status out">no login found</span></div>' : ''}
    </div>`).join('') + missing;
}

export function setupSettings() {
  const btn = document.getElementById('settings-btn');
  const panel = document.getElementById('settings-panel');
  const list = document.getElementById('settings-agents');
  const refresh = document.getElementById('settings-refresh');

  async function load(method = 'GET') {
    refresh.disabled = true;
    refresh.textContent = method === 'POST' ? 'Scanning…' : 'Refresh';
    try {
      const resp = await fetch('/api/agent-accounts', { method, headers: authHeaders() });
      if (resp.status === 401) return showLogin();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      list.innerHTML = renderAgents((await resp.json()).agents);
    } catch (err) {
      list.innerHTML = `<p class="settings-empty">Could not load: ${escapeHtml(err.message)}</p>`;
    } finally {
      refresh.disabled = false;
      refresh.textContent = 'Refresh';
    }
  }

  const place = () => {
    const r = btn.getBoundingClientRect();
    panel.style.top = `${r.bottom + 6}px`;
    // Right edge under the gear, but never off either side of a narrow screen.
    panel.style.left = `${Math.max(8, Math.min(r.right, window.innerWidth - 8) - panel.offsetWidth)}px`;
  };
  const open = (show) => {
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show) { place(); load(); }
  };

  btn.onclick = () => open(panel.hidden);
  refresh.onclick = () => load('POST');
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); } });
  document.addEventListener('mousedown', (e) => { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) open(false); });
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });
}
