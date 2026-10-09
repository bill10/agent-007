// Owner-controlled Claude and Codex account rotation. No credential is sent to the UI.
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
const NAME = { claude: 'Claude', codex: 'Codex' };
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
  panel.hidden = authEnabled || !billionEnabled;
  const body = panel.querySelector('.account-body');
  body.replaceChildren();
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
  const discover = button(body, 'Find logged-in accounts', 'rotation-discover', () => transmit(body, 'rotation-discover'), 'Find logged-in Claude and Codex accounts');
  discover.classList.add('account-discover');
  let saveButton;
  function updateControls() {
    auto.disabled = enabledCount() < 2 && !draft.enabled;
    hint.textContent = draft.accounts.length < 2 ? (draft.defaultSettings
      ? 'Finding two logged-in accounts enables auto-switching. You can turn it off here.'
      : 'Find at least two logged-in accounts, then enable auto-switching.')
      : enabledCount() < 2 ? 'Select at least two accounts to enable automatic switching.'
      : 'Selected accounts are used top to bottom. Billion moves to the other CLI only if one of its accounts is selected. Save settings to apply changes.';
    if (saveButton) saveButton.disabled = draft.enabled && enabledCount() < 2;
  }
  updateControls();
  const accounts = document.createElement('div'); accounts.className = 'rotation-accounts'; body.append(accounts);
  draft.accounts.forEach((a, index) => {
    const row = document.createElement('div'); row.className = 'rotation-account'; row.dataset.cli = a.cli; accounts.append(row);
    const identity = document.createElement('div'); identity.className = 'account-identity'; row.append(identity);
    // The tag is in the checkbox's label: one email can be both a Claude and a Codex login.
    const box = checkbox(identity, a.email, a.enabled, on => { a.enabled = on; edited(); updateControls(); });
    const tag = document.createElement('span'); tag.className = 'account-cli-tag'; tag.textContent = NAME[a.cli];
    box.parentElement.append(tag);
    const status = document.createElement('span'); status.className = 'settings-dim';
    status.textContent = a.status + (a.limitedUntil > Date.now() ? ` · retry ${new Date(a.limitedUntil).toLocaleString()}` : '');
    identity.append(status);
    if (a.error) { const error = document.createElement('span'); error.className = 'account-error'; error.textContent = a.error; row.append(error); }
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
