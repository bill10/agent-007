// The owner's Claude account switch (server/account-migration.js): the
// "Claude account" section of the Settings panel (the gear in the terminal
// header, public/modules/settings.js). Every action goes to the server as
// { type: 'account', action }, and every one but the folder check asks first.
// Off by default: with nothing set up the section only offers the folder.
import { send } from './ws.js';
import { authEnabled, billionEnabled } from './state.js';

let state = { status: 'not set up' };
let lastError = null;   // the server's answer to the last click, until the next state
const PROGRESS = { setup: 'Checking…', arm: 'Arming…', disarm: 'Disarming…', migrate: 'Switching…', rollback: 'Rolling back…', retire: 'Retiring…' };

const CONFIRM = {
  arm: (s) => `Arm the switch to ${s.newEmail}?\n\nThe first time Claude Code tells Billion it has hit a usage limit, the default Claude Code login (${s.oldEmail}) is replaced by ${s.newEmail}, in place, and Billion restarts on it. This is for a permanent move, not for getting past a limit.`,
  disarm: () => 'Disarm? Nothing switches until you arm it again.',
  migrate: (s) => `Switch the default Claude Code login from ${s.oldEmail} to ${s.newEmail} now?\n\nThe current login is backed up first and put back by itself if the switch does not verify. Billion restarts; running workers keep going.`,
  rollback: (s) => `Roll back to ${s.oldEmail}?\n\nThe backed-up login goes back into the default Claude Code folder, and Billion restarts.`,
  retire: (s) => `Retire ${s.folder}?\n\nIt is renamed to ${s.folder}.retired-<date>, never deleted. Do this only once you have checked that Claude Code works with ${s.newEmail}.`,
};

export function handleAccountState(msg) {
  state = { ...msg };
  delete state.type;
  lastError = null;
  renderAccount();
}

// A refused or failed action, shown under the buttons (server/ws.js).
export function handleAccountError(msg) {
  lastError = msg.message;
  renderAccount();
}

// The panel: a state line, then the folder or the buttons the state allows.
export function renderAccount() {
  const panel = document.getElementById('account-panel');
  if (!panel) return;
  // Billion's owner alone: with user accounts on nobody may (server/ws.js).
  panel.hidden = authEnabled || !billionEnabled;
  const body = panel.querySelector('.account-body');
  const s = state;
  const lastAttempt = s.error ? ` Last attempt: ${s.error}` : '';
  const line = {
    'not set up': 'Not set up. Log the new account in once in a folder of its own (CLAUDE_CONFIG_DIR=~/.claude-new claude, then /login) and give that folder here.',
    ready: `Ready: ${s.oldEmail} now, ${s.newEmail} in ${s.folder}. Nothing armed.${lastAttempt}`,
    armed: `Armed: switches ${s.oldEmail} → ${s.newEmail} at Billion's next usage limit.`,
    switching: `A switch to ${s.newEmail} started on ${(s.at || '').slice(0, 10)} and did not finish. Roll back to ${s.oldEmail}, then check the folder again.`,
    migrated: `Switched to ${s.newEmail} on ${(s.at || '').slice(0, 10)} (was ${s.oldEmail}).${s.retiredTo ? ` Folder retired as ${s.retiredTo}.` : ` Do not run anything with CLAUDE_CONFIG_DIR=${s.folder}; retire it once checked.`}${lastAttempt}`,
    'rolled back': `Rolled back to ${s.oldEmail}.${lastAttempt}`,
    'rollback failed': `The switch to ${s.newEmail} failed and so did the rollback: ${s.error || 'see the server log'}. The default login may be half swapped; try Roll back again, or restore ~/.agent-007/account-backup by hand, then check the folder again.`,
  }[s.status] || s.status;
  body.innerHTML = '';
  const status = document.createElement('div');
  status.className = 'account-status';
  status.dataset.status = s.status;
  status.textContent = line;
  body.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'account-actions';
  // Sent once: the buttons go quiet until the server's next account-state
  // re-renders the panel, so a second click cannot send the action twice.
  const sendOnce = (b, action, msg) => {
    for (const other of actions.querySelectorAll('button')) other.disabled = true;
    b.textContent = PROGRESS[action] || b.textContent;
    send(msg);
  };
  const button = (label, action, onclick) => {
    const b = document.createElement('button');
    b.className = 'settings-refresh account-btn';
    b.dataset.action = action;
    b.textContent = label;
    b.onclick = onclick || (() => {
      const ask = CONFIRM[action];
      if (ask && !confirm(ask(s))) return;
      sendOnce(b, action, action === 'disarm' ? { type: 'account', action: 'arm', on: false } : { type: 'account', action });
    });
    actions.appendChild(b);
    return b;
  };
  if (s.status === 'not set up' || s.status === 'ready' || s.status === 'rolled back' || s.status === 'rollback failed') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'account-folder';
    input.placeholder = '~/.claude-new';
    input.spellcheck = false;
    input.required = true;
    input.value = s.folder || '';
    input.setAttribute('aria-label', "New account's config folder");
    actions.appendChild(input);
    const check = button(s.status === 'not set up' ? 'Check folder' : 'Check again', 'setup', () => {
      const folder = input.value.trim();
      if (!folder) { input.reportValidity?.(); input.focus(); return; }
      sendOnce(check, 'setup', { type: 'account', action: 'setup', folder });
    });
  }
  if (s.status === 'ready') {
    button('Arm', 'arm');
    button('Switch now', 'migrate');
  }
  if (s.status === 'armed') {
    button('Disarm', 'disarm');
    button('Switch now', 'migrate');
  }
  if (s.status === 'migrated' || s.status === 'switching' || s.status === 'rollback failed') {
    button('Roll back', 'rollback');
    if (s.status === 'migrated' && !s.retiredTo) button('Retire the new folder', 'retire');
  }
  body.appendChild(actions);
  if (lastError) {
    const err = document.createElement('div');
    err.className = 'account-error';
    err.textContent = lastError;
    body.appendChild(err);
  }
}
