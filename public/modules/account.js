// Settings → Accounts: one list of every login on this machine, each row
// tagged with its CLI. The rows come from the server's scan of the agent CLIs
// (settings.js hands it over with setScan) and, for Claude and Codex, from
// the owner's account-switching registries, whose order is the switch order.
// Switch controls only where the owner may act. No credential reaches the UI.
import { send } from './ws.js';
import { authEnabled, billionEnabled } from './state.js';

// One list of both CLIs' accounts, in switch order. The server keeps one
// registry per CLI (`rotation`, `codexRotation`), each with its own active
// login; an account's `rank` is its place in the list (unranked ones follow,
// Claude before Codex). Claude's messages carry no `cli` (the server's
// default); Codex's say so.
const CLIS = [
  { cli: 'claude', key: 'rotation', name: 'Claude', example: '~/.claude-work' },
  { cli: 'codex', key: 'codexRotation', name: 'Codex', example: '~/.codex-work' },
];
const NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

// The home dir, guessed from the scan's default folders, only to shorten paths.
export const homeOf = agents => agents.flatMap(a => a.accounts).map(a => a.folder.match(/^(.*)[\\/]\.(claude|codex|gemini)$/)?.[1]).find(Boolean);
export const tilde = (p, home) => (home && /^[\\/]/.test(p.slice(home.length)) && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
// The scan's login folders, one per login: folders logged in as the same
// email under one CLI (a source folder and the default one it was switched
// into) are one login. A folder with no email is a login of its own.
export function scanLogins(agents) {
  const out = [];
  for (const { cli, accounts } of agents) {
    for (const acc of accounts) {
      const key = `${cli}:${acc.email ? acc.email.toLowerCase() : acc.folder}`;
      const same = out.find(l => l.key === key);
      if (!same) { out.push({ ...acc, key, cli }); continue; }
      same.isDefault ||= acc.isDefault;
      same.plan ||= acc.plan;
      if (acc.loggedIn) same.loggedIn = true;
    }
  }
  return out;
}
let scanned = null;   // the last scan's agents, null until one arrives
export function setScan(agents) { scanned = agents; renderAccount(); }
const blank = () => ({ enabled: false, defaultSettings: true, accounts: [] });
let state = {};
// Unsaved edits survive a state update: they are laid over the fresh state.
let dirty = false;
const settings = d => JSON.stringify([d.enabled, d.accounts.map(a => [a.id, a.enabled])]);
function combine(msg) {
  const regs = CLIS.map(c => ({ ...c, r: msg[c.key] || blank() }));
  const accounts = regs.flatMap(({ cli, r }) => r.accounts.map(a => ({ ...a, cli })))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));   // stable: Claude first among the unranked
  return {
    enabled: regs.some(({ r }) => r.enabled), defaultSettings: regs.every(({ r }) => r.defaultSettings), accounts,
    active: Object.fromEntries(regs.map(({ cli, r }) => [cli, r.active])),
    blocked: regs.filter(({ r }) => r.pending || r.damaged), regs,
  };
}
let draft = combine({});
function merge(fresh) {
  const ids = a => a.map(x => x.id).sort().join();
  // An interrupted switch or a changed account list wins over unsaved edits.
  // An error does not: it stays in the registry until the next switch.
  if (!dirty || fresh.blocked.length || ids(fresh.accounts) !== ids(draft.accounts)) { dirty = false; return fresh; }
  const merged = { ...fresh, enabled: draft.enabled,
    accounts: draft.accounts.map(d => ({ ...fresh.accounts.find(a => a.id === d.id), enabled: d.enabled })) };
  if (settings(merged) === settings(fresh)) dirty = false;   // saved
  return merged;
}
let folderDraft = '';
let folderCli = 'claude';
let manualOpen = false;
let lastError = null;
export function handleAccountState(msg) {
  state = msg;
  draft = merge(combine(msg));
  renderAccount();
}
export function handleAccountError(msg) { lastError = msg.message; renderAccount(); }

export function renderAccount() {
  const panel = document.getElementById('account-panel');
  if (!panel) return;
  const body = panel.querySelector('.account-body');
  body.replaceChildren();
  // The switch controls only where the owner may act (the server sends no state elsewhere).
  if (authEnabled || !billionEnabled) return renderLogins(body, scanned ? scanLogins(scanned) : [], []);
  render(body);
  // Recover an unfinished switch made by an older app version. The migration
  // controls are replaced; its backup remains usable until recovery is done.
  if (['switching', 'rollback failed'].includes(state.status) || (state.status === 'migrated' && !state.rotation?.accounts?.length)) {
    const el = document.createElement('button'); el.className = 'settings-refresh account-btn';
    el.textContent = 'Restore login from previous version'; el.dataset.action = 'rollback';
    el.onclick = () => { if (confirm('Restore the login backed up by the previous account-switch feature?')) transmit(body, 'rollback'); };
    body.append(el);
  }
}

// Every control in the panel waits while an action runs: the server takes one
// account action at a time, for either CLI. Unsaved edits stay until the
// state shows them saved, so a refused save keeps them.
function transmit(body, action, extra = {}) {
  lastError = null;
  for (const control of body.querySelectorAll('button, input, select')) control.disabled = true;
  if (!send({ type: 'account', action, ...extra })) { lastError = 'Not connected. Reconnect and try again.'; renderAccount(); }
}
const cliField = cli => (cli === 'claude' ? {} : { cli });

function render(body) {
  const edited = () => { dirty = true; };
  const text = (value, cls = 'account-status') => {
    const el = document.createElement('div'); el.className = cls; el.textContent = value; body.append(el); return el;
  };
  const button = (parent, label, action, fn, ariaLabel) => {
    const el = document.createElement('button'); el.className = 'settings-refresh account-btn';
    el.textContent = label; el.dataset.action = action; el.onclick = fn;
    if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
    parent.append(el); return el;
  };
  const checkbox = (parent, label, checked, onchange) => {
    const wrap = document.createElement('label'), input = document.createElement('input');
    wrap.className = 'rotation-toggle'; input.type = 'checkbox'; input.checked = checked;
    input.onchange = () => onchange(input.checked);
    const caption = document.createElement('span'); caption.textContent = label;
    wrap.append(input, caption); parent.append(wrap); return input;
  };
  for (const { cli, name, r } of draft.regs) {
    if (r.pending) text(`A ${name} account switch was interrupted. Restore the previous ${name} login before continuing.`, 'account-error');
    if (r.error) text(r.error, 'account-error');
  }
  if (lastError) text(lastError, 'account-error');
  // Settings save both registries at once, so an interrupted or unreadable
  // one holds the whole list until it is restored.
  for (const { cli, name, r } of draft.blocked) {
    if (r.pending) button(body, `Restore previous ${name} login`, 'rotation-recover', () => transmit(body, 'rotation-recover', cliField(cli)));
  }
  if (draft.blocked.length) return;
  for (const { cli, name, r } of draft.regs) {
    if (r.resumePending) button(body, `Retry paused ${name} conversations`, 'rotation-resume', () => transmit(body, 'rotation-resume', cliField(cli)));
  }
  const enabledCount = () => draft.accounts.filter(a => a.enabled).length;
  const auto = checkbox(body, 'Auto-switch accounts at usage limits', draft.enabled, on => { draft.enabled = on; edited(); updateControls(); });
  auto.id = 'account-auto-switch';
  const hint = text('', 'account-status'); hint.id = 'account-auto-switch-hint'; hint.setAttribute('aria-live', 'polite');
  auto.setAttribute('aria-describedby', hint.id);
  let saveButton;
  function updateControls() {
    auto.disabled = enabledCount() < 2 && !draft.enabled;
    hint.textContent = draft.accounts.length < 2 ? (draft.defaultSettings
      ? 'Two logged-in Claude or Codex accounts turn auto-switching on. Log in to another, then Refresh.'
      : 'Log in to a second Claude or Codex account, then Refresh, to enable auto-switching.')
      : enabledCount() < 2 ? 'Select at least two accounts to enable automatic switching.'
      : 'Selected accounts are used top to bottom. Billion moves to the other CLI only if one of its accounts is selected. Save settings to apply changes.';
    if (saveButton) saveButton.disabled = draft.enabled && enabledCount() < 2;
  }
  updateControls();
  // The registries' accounts, in switch order, then the scan's other logins
  // (Gemini and the rest, logged-out folders, a login not enrolled).
  const logins = scanned ? scanLogins(scanned) : [];
  const take = a => {
    const i = logins.findIndex(l => l.cli === a.cli && l.email?.toLowerCase() === a.email?.toLowerCase());
    return i < 0 ? null : logins.splice(i, 1)[0];
  };
  const accounts = renderLogins(body, logins, draft.accounts.map(a => [a, take(a)]));
  accounts.querySelectorAll('.rotation-account[data-index]').forEach(row => {
    const index = Number(row.dataset.index), a = draft.accounts[index];
    const box = row.querySelector('input'); box.onchange = () => { a.enabled = box.checked; edited(); updateControls(); };
    const controls = document.createElement('div'); controls.className = 'account-actions'; row.append(controls);
    const who = `${NAME[a.cli]} account ${a.email}`;
    const up = button(controls, 'Move up', 'rotation-up', () => {
      [draft.accounts[index - 1], draft.accounts[index]] = [draft.accounts[index], draft.accounts[index - 1]]; edited(); renderAccount();
    }, `Move ${who} up`); up.disabled = index === 0;
    const down = button(controls, 'Move down', 'rotation-down', () => {
      [draft.accounts[index], draft.accounts[index + 1]] = [draft.accounts[index + 1], draft.accounts[index]]; edited(); renderAccount();
    }, `Move ${who} down`); down.disabled = index === draft.accounts.length - 1;
    if (a.id !== draft.active[a.cli]) button(controls, 'Switch now', 'rotation-switch', () => {
      if (confirm(`Switch ${NAME[a.cli]} to ${a.email}? The app's ${NAME[a.cli]} sessions will restart in their existing conversations.`)) transmit(body, 'rotation-switch', { ...cliField(a.cli), id: a.id });
    }, `Switch ${NAME[a.cli]} to ${a.email} now`);
  });
  const manual = document.createElement('details'); manual.className = 'account-manual'; manual.open = manualOpen;
  manual.ontoggle = () => { manualOpen = manual.open; };
  const summary = document.createElement('summary'); summary.textContent = 'Add an account folder manually'; manual.append(summary); body.append(manual);
  const folderControls = document.createElement('div'); folderControls.className = 'account-folder-controls'; manual.append(folderControls);
  const kind = document.createElement('select'); kind.id = 'account-folder-cli'; kind.className = 'account-folder account-folder-cli'; kind.setAttribute('aria-label', 'CLI of this folder');
  for (const c of CLIS) {
    const option = document.createElement('option'); option.value = c.cli; option.textContent = c.name; kind.append(option);
  }
  kind.value = folderCli;
  const label = document.createElement('label'); label.htmlFor = 'account-config-folder'; label.textContent = 'Claude config folder or Codex home folder';
  const input = document.createElement('input'); input.id = 'account-config-folder'; input.className = 'account-folder'; input.value = folderDraft; input.oninput = () => { folderDraft = input.value; };
  const hintFolder = () => { input.placeholder = CLIS.find(c => c.cli === kind.value).example; };
  kind.onchange = () => { folderCli = kind.value; hintFolder(); }; hintFolder();
  folderControls.append(label, kind, input);
  button(folderControls, 'Add folder', 'rotation-add', () => {
    if (input.value.trim()) transmit(body, 'rotation-add', { ...cliField(kind.value), folder: input.value.trim() });
  }, 'Add account folder');
  if (draft.accounts.length) {
    text('Close Claude sessions and Codex outside this app before switching. A Codex switch rewrites the default Codex auth.json, so other tools that read it follow it, and restarts Codex’s background server. Avoid using these account folders separately while auto-switching is on.', 'settings-dim');
    saveButton = button(body, 'Save settings', 'rotation-configure', () => {
      if (draft.enabled && !combine(state).enabled && !confirm('Enable automatic account switching? When an account hits its usage limit, the app’s sessions on that CLI restart on the next account with their conversations preserved.')) return;
      transmit(body, 'rotation-configure', { enabled: draft.enabled, accounts: draft.accounts.map(({ id, enabled }) => ({ id, enabled })) });
    });
  }
  updateControls();
}

// The rows: `switching` is [registry account, its scan login or null] for each
// account in switch order, each with a checkbox (wired by render) and its
// status; `logins` are read-only rows after them.
function renderLogins(body, logins, switching) {
  const list = document.createElement('div'); list.className = 'rotation-accounts'; body.append(list);
  const home = scanned ? homeOf(scanned) : null;
  const row = (cli, login, name, a, index) => {
    const el = document.createElement('div'); el.className = 'rotation-account'; el.dataset.cli = cli; list.append(el);
    const identity = document.createElement('div'); identity.className = 'account-identity'; el.append(identity);
    const tag = document.createElement('span'); tag.className = 'account-cli-tag'; tag.textContent = NAME[cli] || cli;
    const caption = document.createElement('span'); caption.textContent = name;
    if (login) caption.title = login.folder;
    // The CLI leads the row, inside the checkbox's label: one email can be both a Claude and a Codex login.
    if (a) {
      el.dataset.index = index;
      const wrap = document.createElement('label'), input = document.createElement('input');
      wrap.className = 'rotation-toggle'; input.type = 'checkbox'; input.checked = a.enabled;
      wrap.append(input, tag, caption); identity.append(wrap);
    } else {
      const wrap = document.createElement('span'); wrap.className = 'account-name';
      wrap.append(tag, caption); identity.append(wrap);
    }
    const meta = document.createElement('div'); meta.className = 'account-meta'; el.append(meta);
    const bit = (text, cls = 'settings-dim') => { const b = document.createElement('span'); b.className = cls; b.textContent = text; meta.append(b); };
    // One status: a switch row's (Active, Available, Limited · until …), else
    // the login's; Logged out wins either way. Default marks the CLI's
    // default folder when that login is not already the Active one.
    const out = login?.loggedIn === false || (a && a.status === 'Needs login');
    if (login?.plan) bit(login.plan);
    if (out) bit('Logged out', 'settings-status out');
    else if (a) bit(a.status === 'Limited' && a.limitedUntil > Date.now() ? `Limited · until ${new Date(a.limitedUntil).toLocaleString()}` : a.status, 'account-state');
    else if (login?.loggedIn) bit('Logged in', 'settings-status in');
    if (login?.isDefault && a?.status !== 'Active') bit('Default');
    if (!meta.children.length) meta.remove();
    if (a?.error) { const error = document.createElement('span'); error.className = 'account-error'; error.textContent = a.error; el.append(error); }
  };
  switching.forEach(([a, login], index) => row(a.cli, login, a.email, a, index));
  for (const login of logins) row(login.cli, login, login.email || tilde(login.folder, home), null);
  if (!list.children.length) {
    const empty = document.createElement('p'); empty.className = 'settings-empty';
    empty.textContent = scanned ? 'No logins found. Log in to Claude Code or Codex, then Refresh.' : 'Scanning…';
    list.append(empty);
  }
  return list;
}
