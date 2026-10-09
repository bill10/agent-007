// Owner-controlled Claude and Codex account rotation. No credential is sent to the UI.
import { send } from './ws.js';
import { authEnabled, billionEnabled } from './state.js';

// One section per CLI, each with its own registry, draft and controls. Claude's
// messages carry no `cli` (the server's default); Codex's say so.
const CLIS = [
  { cli: 'claude', key: 'rotation', title: 'Claude Code', name: 'Claude', ids: '', folder: 'Claude config folder', example: '~/.claude-work', other: 'Codex' },
  { cli: 'codex', key: 'codexRotation', title: 'Codex', name: 'Codex', ids: '-codex', folder: 'Codex home folder', example: '~/.codex-work', other: 'Claude Code' },
];
const blank = () => ({ enabled: false, fallback: true, accounts: [] });
let state = {};
const drafts = { claude: blank(), codex: blank() };
// A section with unsaved edits keeps them when a state update arrives for the
// other one: each message carries both registries.
const dirty = { claude: false, codex: false };
const folderDrafts = { claude: '', codex: '' };
const manualOpen = { claude: false, codex: false };
let lastError = null;
let lastCli = 'claude';   // the section the last action came from, where its error shows
export function handleAccountState(msg) {
  state = msg;
  for (const c of CLIS) if (!dirty[c.cli]) drafts[c.cli] = structuredClone(msg[c.key] || blank());
  renderAccount();
}
export function handleAccountError(msg) { lastError = msg.message; renderAccount(); }

export function renderAccount() {
  const panel = document.getElementById('account-panel');
  if (!panel) return;
  panel.hidden = authEnabled || !billionEnabled;
  const root = panel.querySelector('.account-body');
  root.replaceChildren();
  for (const c of CLIS) {
    const section = document.createElement('section');
    section.className = 'account-cli'; section.dataset.cli = c.cli;
    const heading = document.createElement('h3'); heading.className = 'account-cli-title'; heading.textContent = c.title;
    heading.id = `account-cli-${c.cli}`; section.setAttribute('aria-labelledby', heading.id);
    section.append(heading); root.append(section);
    renderCli(c, section, root);
  }
  // Recover an unfinished switch made by an older app version. The migration
  // controls are replaced; its backup remains usable until recovery is done.
  if (['switching', 'rollback failed'].includes(state.status) || (state.status === 'migrated' && !drafts.claude.accounts.length)) {
    const el = document.createElement('button'); el.className = 'settings-refresh account-btn';
    el.textContent = 'Restore login from previous version'; el.dataset.action = 'rollback';
    el.onclick = () => { if (confirm('Restore the login backed up by the previous account-switch feature?')) transmitFrom(root, 'claude', 'rollback'); };
    root.querySelector('[data-cli="claude"]').append(el);
  }
}

// Every control in the panel waits while an action runs: the server takes one
// account action at a time, for either CLI. The draft is sent, so it is clean.
function transmitFrom(root, cli, action, extra = {}) {
  lastError = null; lastCli = cli; dirty[cli] = false;
  for (const control of root.querySelectorAll('button, input')) control.disabled = true;
  if (!send({ type: 'account', action, ...(cli === 'claude' ? {} : { cli }), ...extra })) { lastError = 'Not connected. Reconnect and try again.'; renderAccount(); }
}

function renderCli(c, body, root) {
  const { cli } = c, draft = drafts[cli];
  const edited = () => { dirty[cli] = true; };
  const text = (value, cls = 'account-status') => {
    const el = document.createElement('div'); el.className = cls; el.textContent = value; body.append(el); return el;
  };
  const transmit = (action, extra) => transmitFrom(root, cli, action, extra);
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
  if (draft.pending) text('A switch was interrupted. Restore the previous login before continuing.', 'account-error');
  if (draft.error) text(draft.error, 'account-error');
  if (lastError && lastCli === cli) text(lastError, 'account-error');
  if (draft.pending) {
    button(body, 'Restore previous login', 'rotation-recover', () => transmit('rotation-recover'));
    return;
  }
  if (draft.damaged) return;
  if (draft.resumePending) button(body, `Retry paused ${c.name} conversations`, 'rotation-resume', () => transmit('rotation-resume'));
  const enabledCount = () => draft.accounts.filter(a => a.enabled).length;
  const auto = checkbox(body, 'Auto-switch accounts at usage limits', draft.enabled, on => { draft.enabled = on; edited(); updateControls(); });
  auto.id = `account-auto-switch${c.ids}`; auto.setAttribute('aria-label', `Auto-switch ${c.name} accounts at usage limits`);
  const hint = text('', 'account-status'); hint.id = `account-auto-switch-hint${c.ids}`; hint.setAttribute('aria-live', 'polite');
  auto.setAttribute('aria-describedby', hint.id);
  const discover = button(body, 'Find logged-in accounts', 'rotation-discover', () => transmit('rotation-discover'), `Find logged-in ${c.name} accounts`);
  discover.classList.add('account-discover');
  let saveButton;
  function updateControls() {
    auto.disabled = enabledCount() < 2 && !draft.enabled;
    hint.textContent = draft.accounts.length < 2 ? (draft.defaultSettings
      ? 'Finding two logged-in accounts enables auto-switching. You can turn it off here.'
      : 'Find at least two logged-in accounts, then enable auto-switching.')
      : enabledCount() < 2 ? 'Select at least two accounts to enable automatic switching.'
      : 'Use the selected accounts in the order below. Save settings to apply changes.';
    if (saveButton) saveButton.disabled = draft.enabled && enabledCount() < 2;
  }
  updateControls();
  const accounts = document.createElement('div'); accounts.className = 'rotation-accounts'; body.append(accounts);
  draft.accounts.forEach((a, index) => {
    const row = document.createElement('div'); row.className = 'rotation-account'; accounts.append(row);
    const identity = document.createElement('div'); identity.className = 'account-identity'; row.append(identity);
    checkbox(identity, a.email, a.enabled, on => { a.enabled = on; edited(); updateControls(); });
    const status = document.createElement('span'); status.className = 'settings-dim';
    status.textContent = a.status + (a.limitedUntil > Date.now() ? ` · retry ${new Date(a.limitedUntil).toLocaleString()}` : ''); identity.append(status);
    if (a.error) { const error = document.createElement('span'); error.className = 'account-error'; error.textContent = a.error; row.append(error); }
    const controls = document.createElement('div'); controls.className = 'account-actions'; row.append(controls);
    const up = button(controls, 'Move up', 'rotation-up', () => {
      [draft.accounts[index - 1], draft.accounts[index]] = [draft.accounts[index], draft.accounts[index - 1]]; edited(); renderAccount();
    }); up.disabled = index === 0;
    const down = button(controls, 'Move down', 'rotation-down', () => {
      [draft.accounts[index], draft.accounts[index + 1]] = [draft.accounts[index + 1], draft.accounts[index]]; edited(); renderAccount();
    }); down.disabled = index === draft.accounts.length - 1;
    if (a.id !== draft.active) button(controls, 'Switch now', 'rotation-switch', () => {
      if (confirm(`Switch to ${a.email}? The app's ${c.name} sessions will restart in their existing conversations.`)) transmit('rotation-switch', { id: a.id });
    });
  });
  const manual = document.createElement('details'); manual.className = 'account-manual'; manual.open = manualOpen[cli];
  manual.ontoggle = () => { manualOpen[cli] = manual.open; };
  const summary = document.createElement('summary'); summary.textContent = 'Add an account folder manually'; manual.append(summary); body.append(manual);
  const folderControls = document.createElement('div'); folderControls.className = 'account-folder-controls'; manual.append(folderControls);
  const label = document.createElement('label'); label.htmlFor = `account-config-folder${c.ids}`; label.textContent = c.folder; folderControls.append(label);
  const input = document.createElement('input'); input.id = `account-config-folder${c.ids}`; input.className = 'account-folder'; input.value = folderDrafts[cli]; input.oninput = () => { folderDrafts[cli] = input.value; }; input.placeholder = c.example; folderControls.append(input);
  button(folderControls, 'Add folder', 'rotation-add', () => { if (input.value.trim()) transmit('rotation-add', { folder: input.value.trim() }); }, `Add ${c.folder}`);
  if (draft.accounts.length) {
    text(cli === 'codex'
      ? 'Close Codex outside this app before switching. Switching rewrites the default Codex auth.json, so other tools that read it follow the switch, and restarts Codex’s background server. Avoid using these account folders separately while auto-switching is on.'
      : 'Close Claude sessions outside this app before switching. Avoid using these account folders separately while auto-switching is on.', 'settings-dim');
    checkbox(body, `Fall back to ${c.other} when ${c.name} accounts are unavailable`, draft.fallback, on => { draft.fallback = on; edited(); });
    saveButton = button(body, 'Save settings', 'rotation-configure', () => {
      if (draft.enabled && !state[c.key]?.enabled && !confirm(`Enable automatic account switching? When an account hits its usage limit, the app’s ${c.name} sessions restart on the next account with their conversations preserved.`)) return;
      transmit('rotation-configure', { enabled: draft.enabled, fallback: draft.fallback, accounts: draft.accounts.map(({ id, enabled }) => ({ id, enabled })) });
    }, `Save ${c.title} settings`);
  }
  updateControls();
}
