// The Settings panel behind the gear in the terminal header. "Agents &
// accounts" shows the server's last scan of installed agent CLIs and their
// login folders (GET /api/agent-accounts); Refresh rescans (POST). "Telegram"
// shows the connected chat, with Change. "Read aloud" picks the voice the
// Billion tab reads in. On top, this copy's version and, when npm has a
// newer one, Update.

import { authHeaders, showLogin, escapeHtml } from './auth.js';
import { send } from './ws.js';
import { readAloudSupported, englishVoices, pickVoice, savedVoiceURI, setVoiceURI } from './readaloud.js';

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

// The Telegram line (server/owner.js telegramPayload): the connected chat and
// "Change", which forgets it so the next message to the bot is offered in the
// Billion tab; or, with none, how to connect one.
export function renderTelegramSettings(state) {
  const box = document.getElementById('telegram-settings');
  if (!box) return;
  box.hidden = false;
  const chat = state.chat;
  const line = !state.on ? 'Off. Put a bot token from @BotFather in ~/.agent-007/.env as TELEGRAM_BOT_TOKEN (agent007 init creates that file) and restart.'
    : !chat ? 'Not connected. 1. Message your bot, or add it to your group. 2. Press "Use this chat" in the Billion tab.'
    : `Connected to ${chat.name ? `${chat.name} (chat ${chat.chatId})` : `chat ${chat.chatId}`}${chat.fromEnv ? ', set by TELEGRAM_CHAT_ID' : ''}.`;
  box.innerHTML = `<div class="settings-section-head"><h2>Telegram</h2></div><p class="settings-telegram"></p>`;
  const p = box.querySelector('.settings-telegram');
  p.textContent = line;
  if (chat && !chat.fromEnv) {
    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'settings-refresh';
    change.textContent = 'Change';
    change.title = 'Forget this chat; the next chat to message the bot is offered in the Billion tab';
    change.onclick = () => send({ type: 'telegram-forget' });
    box.querySelector('.settings-section-head').appendChild(change);
  }
}

// "Read aloud": the voice picker, "Auto · <the voice it would pick>" then
// every English voice, remembered by this browser (readaloud.js). Shown only
// when there is a choice.
export function renderVoiceSettings() {
  const box = document.getElementById('voice-settings');
  const pick = document.getElementById('voice-pick');
  if (!box || !pick) return;
  const voices = readAloudSupported() ? englishVoices(window.speechSynthesis.getVoices?.() || []) : [];
  box.hidden = voices.length < 2;
  const saved = savedVoiceURI();
  const key = voices.map(v => v.voiceURI).join('|') + `#${saved}`;
  if (pick.dataset.key === key) return;
  pick.dataset.key = key;
  const auto = pickVoice(voices, null);
  const first = document.createElement('option');
  first.value = '';
  first.textContent = auto ? `Auto · ${auto.name}` : 'Auto';
  pick.replaceChildren(first, ...voices.map(v => {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = v.name;
    return opt;
  }));
  pick.value = voices.some(v => v.voiceURI === saved) ? saved : '';
  pick.onchange = () => { setVoiceURI(pick.value); renderVoiceSettings(); };
}

// One skill store (GET /api/skill-store, server/skill-store.js): the last
// sync, or, while it is being turned on, what turning it on would do with
// Turn on and Cancel. Turning it on always shows that dry run first.
export function renderSkillStore(view) {
  if (view.error) return `<div class="account-error">${escapeHtml(view.error)}</div>`;
  if (view.preview) {
    return `<div><span class="settings-dim">Dry run, nothing changed yet:</span> ${escapeHtml(view.preview.summary)}</div>`
      + '<div class="settings-dim">Every folder it replaces goes to ~/.agent-007/skill-backup first.</div>'
      + '<div class="skill-store-actions"><button type="button" class="settings-refresh settings-primary" data-store="confirm">Turn on</button>'
      + '<button type="button" class="settings-refresh" data-store="cancel">Cancel</button></div>';
  }
  if (!view.last) return view.enabled ? '<div>No sync yet.</div>' : '';
  const when = new Date(view.last.at);
  return `<div><span class="settings-dim">Last sync${Number.isNaN(when.getTime()) ? '' : ` ${escapeHtml(when.toLocaleString())}`}:</span> ${escapeHtml(view.summary)}</div>`
    + (view.last.backup ? `<div class="settings-dim" title="${escapeHtml(view.last.backup)}">Backup: ${escapeHtml(tilde(view.last.backup, view.home))}</div>` : '');
}

// The version line (GET /api/update, server/self-update.js) and where an
// update started from it has got to. step: null, 'updating', 'restarting',
// 'done' or 'failed'. check: null, 'checking' or 'checked' (the Check for updates button).
const UPDATE_CMD = 'agent007 update';
export function renderVersion(info, step = null, check = null) {
  const lines = [`<div><span class="settings-version-name">Agent 007</span> ${escapeHtml(info.version)}</div>`];
  // Who Cloudflare Access let in (server/proxy.js): its header, not verified here.
  if (info.accessEmail) lines.push(`<div class="settings-dim">Signed in through Cloudflare Access as ${escapeHtml(info.accessEmail)}</div>`);
  if (step === 'done') {
    lines.push(`<div class="settings-version-new">Updated to ${escapeHtml(info.version)}. Reload the page to use it.</div>`,
      '<button type="button" class="settings-refresh" data-update="reload">Reload</button>');
  } else if (step === 'failed') {
    const log = info.finished?.log || 'The update stopped without saying why.';
    lines.push('<div>The update failed:</div>', `<div class="settings-version-error">${escapeHtml(log)}</div>`,
      `<div>Run it in a terminal instead: <code>${UPDATE_CMD}</code></div>`);
  } else if (step === 'restarting') {
    lines.push('<div>Restarting…</div>');
  } else if (step === 'updating') {
    const n = info.updating?.waiting;
    lines.push(`<div>${n ? `Waiting for ${n} busy worker${n === 1 ? '' : 's'}…` : 'Updating…'}</div>`);
  } else if (info.finished?.code === 0) {
    lines.push(`<div>${escapeHtml(info.finished.log.split('\n').at(-1) || 'Up to date.')}</div>`);
  } else if (info.kind === 'npx') {
    lines.push('<div class="settings-dim">npx runs the latest each start.</div>');
  }
  if (!step && info.kind !== 'npx') {
    if (check === 'checked' && info.checkFailed) lines.push('<div class="settings-version-error">The check failed: could not reach the npm registry.</div>');
    if (info.latest) {
      lines.push(`<div class="settings-version-new">Version ${escapeHtml(info.latest)} is available · <button type="button" class="settings-link" data-update="notes" aria-haspopup="dialog">What’s new</button></div>`,
        `<button type="button" class="settings-refresh settings-primary" data-update="start" title="Runs ${UPDATE_CMD}: ${info.kind === 'checkout' ? 'git pull' : 'npm install -g'}, then a restart once busy workers finish">Update</button>`);
    } else if (check === 'checked') {
      if (!info.checkFailed) lines.push(`<div>Up to date (version ${escapeHtml(info.version)})</div>`);
    }
    if (check === 'checking') lines.push('<div class="settings-dim">Checking…</div>');
    else lines.push('<button type="button" class="settings-refresh" data-update="check">Check for updates</button>');
  }
  return lines.join('');
}

// The CHANGELOG's markdown, as much of it as it uses: ## and ### headings,
// lists one level deep, paragraphs, **bold**, `code` and [links](https://…).
const inline = (t) => escapeHtml(t)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
export function renderNotes(md) {
  const out = [];
  let depth = 0; // open <ul>s
  let text = null; // the open item's or paragraph's lines, inlined together so **bold** may wrap
  let para = false;
  const flush = () => {
    if (text !== null) out.push(para ? `<p>${inline(text)}</p>` : inline(text));
    text = null;
  };
  const closeTo = (d) => { flush(); while (depth > d) { out.push('</li></ul>'); depth--; } };
  for (const line of md.split('\n')) {
    const item = line.match(/^(\s*)[-*] (.*)/);
    const head = line.match(/^(##+) (.*)/);
    if (item) {
      flush();
      const d = item[1].length >= 2 ? 2 : 1;
      if (d > depth) { out.push('<ul>'.repeat(d - depth)); depth = d; } else { closeTo(d); out.push('</li>'); }
      out.push('<li>');
      text = item[2];
      para = false;
    } else if (head) {
      closeTo(0);
      const tag = head[1].length === 2 ? 'h3' : 'h4';
      // "[0.58.0.0] - 2026-10-07": the version, then its date dimmed.
      const [, ver, date] = head[2].match(/^\[([^\]]+)\](?: - (.*))?$/) || [];
      out.push(ver ? `<${tag}>${escapeHtml(ver)}${date ? ` <span class="settings-dim">${escapeHtml(date)}</span>` : ''}</${tag}>` : `<${tag}>${inline(head[2])}</${tag}>`);
    } else if (line.trim()) {
      if (text !== null) text += ` ${line.trim()}`;
      else { text = line.trim(); para = !depth; }
    } else closeTo(0);
  }
  closeTo(0);
  return out.join('');
}

// The What's new window: GET /api/update/changelog, rendered.
export function renderNotesBody(data) {
  if (!data || data.error) {
    const url = data?.url || 'https://github.com/bill10/agent-007/blob/main/CHANGELOG.md';
    return `<p>${escapeHtml(data?.error || 'Could not load the release notes.')}</p><p><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Read the CHANGELOG on GitHub</a></p>`;
  }
  return data.notes ? renderNotes(data.notes) : '<p>No release notes between these versions.</p>';
}

// The agent CLIs under Agent 007's own version (GET /api/cli-updates,
// server/cli-update.js): installed against npm's latest, and Update, which
// runs the CLI's own `<cli> update`. Running agents keep the old one until
// their next Restart, so the line says so.
const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const RESTART_NOTE = 'Running agents pick it up on their next Restart.';
export function renderCliVersions(updates) {
  return Object.entries(updates).map(([cli, u]) => {
    const name = CLI_NAMES[cli] || cli;
    const lines = [`<div><span class="settings-version-name">${escapeHtml(name)}</span> ${escapeHtml(u.version || '(version unknown)')}</div>`];
    if (u.updating) lines.push('<div>Updating…</div>');
    else if (u.finished?.code === 0) lines.push(`<div class="settings-version-new">Updated. ${RESTART_NOTE}</div>`);
    else if (u.finished) {
      lines.push('<div>The update failed:</div>', `<div class="settings-version-error">${escapeHtml(u.finished.log || 'It stopped without saying why.')}</div>`,
        `<div>Run it in a terminal instead: <code>${escapeHtml(cli)} update</code></div>`);
    } else if (u.latest && u.version && newer(u.latest, u.version)) {
      lines.push(`<div class="settings-version-new">Version ${escapeHtml(u.latest)} is available. ${RESTART_NOTE}</div>`,
        `<button type="button" class="settings-refresh settings-primary" data-cli-update="${escapeHtml(cli)}" title="Runs ${escapeHtml(cli)} update" aria-label="Update ${escapeHtml(name)}">Update</button>`);
    }
    return `<div class="settings-cli">${lines.join('')}</div>`;
  }).join('');
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
  const loadStore = () => storeCall('/api/skill-store');
  const open = (show) => {
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show) { renderVoiceSettings(); place(); load(); loadStore(); }
  };
  renderVoiceSettings();
  window.speechSynthesis?.addEventListener?.('voiceschanged', renderVoiceSettings);

  // Version and Update. Polled every 2s while an update runs: the server
  // going away is the restart, and its coming back the end of it.
  const box = document.getElementById('settings-version');
  let step = null;
  let polling = false;
  async function loadVersion(fresh = false) {
    let resp;
    try { resp = await fetch(fresh ? '/api/update?fresh=1' : '/api/update', { headers: authHeaders() }); } catch { resp = null; }
    if (resp?.status === 403) { box.hidden = true; return null; }
    if (!resp?.ok) return null;
    const info = await resp.json();
    box.hidden = false;
    btn.classList.toggle('has-update', Boolean(info.latest) && info.kind !== 'npx');
    return info;
  }
  const show = (info) => {
    box.innerHTML = renderVersion(info, step, check);
    const chk = box.querySelector('[data-update="check"]');
    if (chk) chk.onclick = checkNow;
    const start = box.querySelector('[data-update="start"]');
    if (start) start.onclick = update;
    const notes = box.querySelector('[data-update="notes"]');
    if (notes) notes.onclick = showNotes;
    const reload = box.querySelector('[data-update="reload"]');
    if (reload) reload.onclick = () => location.reload();
  };
  let last = null;
  let check = null;
  async function checkNow() {
    check = 'checking';
    show(last);
    const info = await loadVersion(true);
    check = 'checked';
    show(last = info || { ...last, checkFailed: true });
  }
  async function refreshVersion() {
    const info = await loadVersion();
    if (!info) return;
    // Started from another window: follow it here too.
    if (info.updating && !step) step = 'updating';
    show(last = info);
    if (step === 'updating') poll();
  }
  async function poll() {
    if (polling) return;
    polling = true;
    const before = last?.version;
    while (step === 'updating' || step === 'restarting') {
      await new Promise(r => setTimeout(r, 2000));
      const info = await loadVersion();
      if (!info) { step = 'restarting'; if (last) show(last); continue; }
      last = info;
      if (info.finished) step = info.finished.code === 0 ? null : 'failed';
      else if (step === 'restarting' || info.version !== before) step = 'done';
      show(info);
    }
    polling = false;
  }
  async function update() {
    step = 'updating';
    show(last);
    try {
      const resp = await fetch('/api/update', { method: 'POST', headers: authHeaders() });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);
    } catch (err) {
      step = 'failed';
      show({ ...last, finished: { code: 1, log: err.message } });
      return;
    }
    poll();
  }
  refreshVersion();

  // The agent CLIs' versions and their Update, polled every 2s while one runs.
  const cliBox = document.getElementById('settings-cli-versions');
  let cliPolling = false;
  async function loadCli() {
    let resp;
    try { resp = await fetch('/api/cli-updates', { headers: authHeaders() }); } catch { resp = null; }
    if (!resp?.ok) { cliBox.hidden = true; return null; }
    const updates = await resp.json();
    cliBox.hidden = !Object.keys(updates).length;
    cliBox.innerHTML = renderCliVersions(updates);
    for (const b of cliBox.querySelectorAll('[data-cli-update]')) b.onclick = () => updateCli(b.dataset.cliUpdate, b);
    return updates;
  }
  async function pollCli() {
    if (cliPolling) return;
    cliPolling = true;
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const updates = await loadCli();
      if (!updates || !Object.values(updates).some(u => u.updating)) break;
    }
    cliPolling = false;
    await load('POST');   // rescan, so Agents & accounts shows the new version
    loadCli();
  }
  async function updateCli(cli, b) {
    b.disabled = true;
    b.textContent = 'Updating…';
    const resp = await fetch(`/api/cli-updates/${encodeURIComponent(cli)}`, { method: 'POST', headers: authHeaders() }).catch(() => null);
    if (!resp?.ok) {
      const err = (await resp?.json().catch(() => ({})))?.error || 'Could not start the update.';
      b.insertAdjacentHTML('afterend', `<div class="settings-version-error">${escapeHtml(err)}</div>`);
      b.disabled = false;
      b.textContent = 'Update';
      return;
    }
    pollCli();
  }
  loadCli().then(u => { if (u && Object.values(u).some(x => x.updating)) pollCli(); });

  // One skill store: the switch, a dry run before it goes on, the last sync.
  const storeBox = document.getElementById('skill-store-settings');
  const storeOn = document.getElementById('skill-store-on');
  const storeBody = document.getElementById('skill-store-body');
  let storeHtml = null;
  const showStore = (view) => {
    storeOn.checked = !!view.enabled;
    storeOn.disabled = false;
    // Unchanged on a reopen, so the live region does not read it out again.
    const html = renderSkillStore(view);
    if (html !== storeHtml) storeBody.innerHTML = storeHtml = html;
    for (const b of storeBody.querySelectorAll('button')) b.disabled = false;
    const confirmBtn = storeBody.querySelector('[data-store="confirm"]');
    if (confirmBtn) { confirmBtn.onclick = async () => { await storeCall('/api/skill-store', { enabled: true }); storeOn.focus(); }; confirmBtn.focus(); }
    const cancel = storeBody.querySelector('[data-store="cancel"]');
    if (cancel) cancel.onclick = () => { showStore({ ...view, preview: null }); storeOn.focus(); };
  };
  async function storeCall(url, body) {
    storeOn.disabled = true;
    for (const b of storeBody.querySelectorAll('button')) b.disabled = true;
    let resp;
    try { resp = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); } catch { resp = null; }
    if (resp?.status === 403) { storeBox.hidden = true; return; }
    storeBox.hidden = false;
    const data = await resp?.json().catch(() => null);
    showStore(resp?.ok && data ? data : { enabled: storeOn.checked, error: data?.error || 'Could not reach the server.' });
  }
  storeOn.onchange = () => {
    if (storeOn.checked) { storeOn.checked = false; storeCall('/api/skill-store/preview', {}); }
    else storeCall('/api/skill-store', { enabled: false });
  };

  // What's new: a modal <dialog>, so Esc closes it and the page behind is inert.
  const dlg = document.getElementById('whats-new');
  const dlgBody = document.getElementById('whats-new-body');
  let notesSeq = 0; // a slow earlier fetch must not overwrite a newer one
  async function showNotes() {
    const seq = ++notesSeq;
    const sub = document.getElementById('whats-new-sub');
    const dlgUpdate = dlg.querySelector('[data-update]');
    // Update only while there is one to run and none is running already.
    const label = (d) => { sub.textContent = d?.latest ? `${d.version} → ${d.latest}` : ''; dlgUpdate.hidden = !d?.latest || Boolean(step); };
    label(last);
    dlgBody.innerHTML = '<p class="settings-dim">Loading…</p>';
    dlgBody.setAttribute('aria-busy', 'true');
    dlg.showModal();
    let data = null;
    try {
      const resp = await fetch('/api/update/changelog', { headers: authHeaders() });
      if (resp.ok) data = await resp.json();
    } catch {}
    if (seq !== notesSeq) return;
    if (data) label(data); // the server's answer, in case npm moved on since the panel loaded
    dlgBody.innerHTML = renderNotesBody(data);
    dlgBody.removeAttribute('aria-busy');
    dlgBody.scrollTop = 0;
  }
  // A click on the backdrop lands on the <dialog> itself, outside its inner box.
  // Only a press that also started there: a text selection dragged out of the notes is not a click outside.
  let downOnBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && downOnBackdrop) dlg.close(); });
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelector('[data-update]').onclick = () => { dlg.close(); update(); };
  // Back to What's new, or to Update/Reload if a re-render took it away.
  dlg.addEventListener('close', () => (box.querySelector('[data-update="notes"]') || box.querySelector('button') || btn).focus());

  btn.onclick = () => {
    if (panel.hidden && step !== 'updating' && step !== 'restarting') {
      if (step === 'failed') step = null;
      check = null;
      refreshVersion();
    }
    open(panel.hidden);
  };
  refresh.onclick = () => load('POST');
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && !dlg.open) { open(false); btn.focus(); } });
  document.addEventListener('mousedown', (e) => { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) open(false); });
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });
}
