// Owner-controlled Claude account rotation. No credential is sent to the UI.
import { send } from './ws.js';
import { authEnabled, billionEnabled } from './state.js';

let state = {};
let draft = { enabled: false, fallback: true, accounts: [] };
let lastError = null;
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
    wrap.append(input, document.createTextNode(label)); parent.append(wrap); return input;
  };
  text(draft.pending ? 'A switch was interrupted. Restore the previous login before continuing.'
    : draft.enabled ? 'Automatic rotation is on. Claude conversations and settings stay in place.'
    : draft.defaultSettings ? 'Automatic rotation starts when at least two accounts are added.'
    : 'Automatic rotation is off. Choose accounts and enable it to rotate at usage limits.');
  if (draft.error) text(draft.error, 'account-error');
  if (lastError) text(lastError, 'account-error');
  if (draft.pending) {
    button(body, 'Restore previous login', 'rotation-recover', () => transmit('rotation-recover'));
    return;
  }
  if (draft.damaged) return;
  if (draft.resumePending) button(body, 'Retry paused Claude conversations', 'rotation-resume', () => transmit('rotation-resume'));
  const accounts = document.createElement('div'); accounts.className = 'rotation-accounts'; body.append(accounts);
  draft.accounts.forEach((a, index) => {
    const row = document.createElement('div'); row.className = 'rotation-account'; accounts.append(row);
    checkbox(row, a.email, a.enabled, on => { a.enabled = on; });
    const status = document.createElement('span'); status.className = 'settings-dim';
    status.textContent = a.status + (a.limitedUntil > Date.now() ? ` · retry ${new Date(a.limitedUntil).toLocaleString()}` : ''); row.append(status);
    if (a.error) { const error = document.createElement('span'); error.textContent = a.error; row.append(error); }
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
  const discover = document.createElement('div'); discover.className = 'account-actions'; body.append(discover);
  button(discover, 'Find logged-in accounts', 'rotation-discover', () => transmit('rotation-discover'));
  const input = document.createElement('input'); input.className = 'account-folder'; input.placeholder = '~/.claude-work'; input.setAttribute('aria-label', 'Claude account config folder'); discover.append(input);
  button(discover, 'Add folder', 'rotation-add', () => { if (input.value.trim()) transmit('rotation-add', { folder: input.value.trim() }); });
  if (draft.accounts.length) {
    text('Accounts are used in the order above. Source folders supply logins; Claude keeps using its current settings and history. Avoid running the same login from a source folder while rotation is enabled.', 'settings-dim');
    checkbox(body, 'Automatic rotation', draft.enabled, on => { draft.enabled = on; });
    checkbox(body, 'Fall back to Codex when Claude accounts are unavailable', draft.fallback, on => { draft.fallback = on; });
    button(body, 'Save rotation settings', 'rotation-configure', () => {
      if (draft.enabled && !state.rotation?.enabled && !confirm('Enable automatic account rotation at usage limits? This restarts the app’s Claude sessions with their conversations preserved.')) return;
      transmit('rotation-configure', { enabled: draft.enabled, fallback: draft.fallback, accounts: draft.accounts.map(({ id, enabled }) => ({ id, enabled })) });
    });
  }
  // Recover an unfinished switch made by an older app version. The migration
  // controls are replaced; its backup remains usable until recovery is done.
  if (['switching', 'rollback failed'].includes(state.status) || (state.status === 'migrated' && !draft.accounts.length)) {
    button(body, 'Restore login from previous version', 'rollback', () => {
      if (confirm('Restore the login backed up by the previous account-switch feature?')) transmit('rollback');
    });
  }
}
