// Owner-controlled Claude account rotation. No credential is sent to the UI.
import { send } from './ws.js';
import { authEnabled, billionEnabled } from './state.js';

let state = {};
let draft = { enabled: false, fallback: true, accounts: [] };
let lastError = null;
let folderDraft = '';
let manualFolderOpen = false;
export function handleAccountState(msg) {
  state = msg;
  draft = structuredClone(msg.rotation || { enabled: false, fallback: true, accounts: [] });
  renderAccount();
}
export function handleAccountError(msg) { lastError = msg.message; renderAccount(); }

export function renderAccount() {
  const panel = document.getElementById('account-panel');
  if (!panel) return;
  panel.hidden = authEnabled || !billionEnabled;
  const body = panel.querySelector('.account-body');
  body.replaceChildren();
  const text = (value, cls = 'account-status') => {
    const el = document.createElement('div'); el.className = cls; el.textContent = value; body.append(el); return el;
  };
  const transmit = (action, extra = {}) => {
    lastError = null;
    for (const control of body.querySelectorAll('button, input')) control.disabled = true;
    if (!send({ type: 'account', action, ...extra })) { lastError = 'Not connected. Reconnect and try again.'; renderAccount(); }
  };
  const button = (parent, label, action, fn) => {
    const el = document.createElement('button'); el.className = 'settings-refresh account-btn';
    el.textContent = label; el.dataset.action = action; el.onclick = fn; parent.append(el); return el;
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
  if (lastError) text(lastError, 'account-error');
  if (draft.pending) {
    button(body, 'Restore previous login', 'rotation-recover', () => transmit('rotation-recover'));
    return;
  }
  if (draft.damaged) return;
  if (draft.resumePending) button(body, 'Retry paused Claude conversations', 'rotation-resume', () => transmit('rotation-resume'));
  const enabledCount = () => draft.accounts.filter(a => a.enabled).length;
  const auto = checkbox(body, 'Auto-switch accounts at usage limits', draft.enabled, on => { draft.enabled = on; updateControls(); });
  auto.id = 'account-auto-switch';
  const hint = text('', 'account-status'); hint.id = 'account-auto-switch-hint'; hint.setAttribute('aria-live', 'polite');
  auto.setAttribute('aria-describedby', hint.id);
  const discover = button(body, 'Find logged-in accounts', 'rotation-discover', () => transmit('rotation-discover'));
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
    checkbox(identity, a.email, a.enabled, on => { a.enabled = on; updateControls(); });
    const status = document.createElement('span'); status.className = 'settings-dim';
    status.textContent = a.status + (a.limitedUntil > Date.now() ? ` · retry ${new Date(a.limitedUntil).toLocaleString()}` : ''); identity.append(status);
    if (a.error) { const error = document.createElement('span'); error.className = 'account-error'; error.textContent = a.error; row.append(error); }
    const controls = document.createElement('div'); controls.className = 'account-actions'; row.append(controls);
    const up = button(controls, 'Move up', 'rotation-up', () => {
      [draft.accounts[index - 1], draft.accounts[index]] = [draft.accounts[index], draft.accounts[index - 1]]; renderAccount();
    }); up.disabled = index === 0;
    const down = button(controls, 'Move down', 'rotation-down', () => {
      [draft.accounts[index], draft.accounts[index + 1]] = [draft.accounts[index + 1], draft.accounts[index]]; renderAccount();
    }); down.disabled = index === draft.accounts.length - 1;
    if (a.id !== draft.active) button(controls, 'Switch now', 'rotation-switch', () => {
      if (confirm(`Switch to ${a.email}? The app's Claude sessions will restart in their existing conversations.`)) transmit('rotation-switch', { id: a.id });
    });
  });
  const manual = document.createElement('details'); manual.className = 'account-manual'; manual.open = manualFolderOpen;
  manual.ontoggle = () => { manualFolderOpen = manual.open; };
  const summary = document.createElement('summary'); summary.textContent = 'Add an account folder manually'; manual.append(summary); body.append(manual);
  const folderControls = document.createElement('div'); folderControls.className = 'account-folder-controls'; manual.append(folderControls);
  const label = document.createElement('label'); label.htmlFor = 'account-config-folder'; label.textContent = 'Claude config folder'; folderControls.append(label);
  const input = document.createElement('input'); input.id = 'account-config-folder'; input.className = 'account-folder'; input.value = folderDraft; input.oninput = () => { folderDraft = input.value; }; input.placeholder = '~/.claude-work'; folderControls.append(input);
  button(folderControls, 'Add folder', 'rotation-add', () => { if (input.value.trim()) transmit('rotation-add', { folder: input.value.trim() }); });
  if (draft.accounts.length) {
    text('Close Claude sessions outside this app before switching. Avoid using these account folders separately while auto-switching is on.', 'settings-dim');
    checkbox(body, 'Fall back to Codex when Claude accounts are unavailable', draft.fallback, on => { draft.fallback = on; });
    saveButton = button(body, 'Save settings', 'rotation-configure', () => {
      if (draft.enabled && !state.rotation?.enabled && !confirm('Enable automatic account switching? When an account hits its usage limit, the app’s Claude sessions restart on the next account with their conversations preserved.')) return;
      transmit('rotation-configure', { enabled: draft.enabled, fallback: draft.fallback, accounts: draft.accounts.map(({ id, enabled }) => ({ id, enabled })) });
    });
  }
  updateControls();
  // Recover an unfinished switch made by an older app version. The migration
  // controls are replaced; its backup remains usable until recovery is done.
  if (['switching', 'rollback failed'].includes(state.status) || (state.status === 'migrated' && !draft.accounts.length)) {
    button(body, 'Restore login from previous version', 'rollback', () => {
      if (confirm('Restore the login backed up by the previous account-switch feature?')) transmit('rollback');
    });
  }
}
