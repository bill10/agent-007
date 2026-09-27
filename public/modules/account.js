// The owner's Claude account switch (server/account-migration.js): the
// "Claude account" section of the Settings panel (the gear in the terminal
// header, public/modules/settings.js). Every action goes to the server as
// { type: 'account', action }, and every one but the folder check asks first.
// Off by default: with nothing set up the section only offers the folder.
import { send } from './ws.js';
import { authEnabled, billionEnabled } from './state.js';

let state = { status: 'not set up' };

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
  const line = {
    'not set up': 'Not set up. Log the new account in once in a folder of its own (CLAUDE_CONFIG_DIR=~/.claude-new claude, then /login) and give that folder here.',
    ready: `Ready: ${s.oldEmail} now, ${s.newEmail} in ${s.folder}. Nothing armed.`,
    armed: `Armed: switches ${s.oldEmail} → ${s.newEmail} at Billion's next hard usage limit.`,
    migrated: `Switched to ${s.newEmail} on ${(s.at || '').slice(0, 10)} (was ${s.oldEmail}).${s.retiredTo ? ` Folder retired as ${s.retiredTo}.` : ` Do not run anything with CLAUDE_CONFIG_DIR=${s.folder}; retire it once checked.`}`,
    'rolled back': `Rolled back to ${s.oldEmail}${s.error ? ` (${s.error})` : ''}.`,
  }[s.status] || s.status;
  body.innerHTML = '';
  const status = document.createElement('div');
  status.className = 'account-status';
  status.dataset.status = s.status;
  status.textContent = line;
  body.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'account-actions';
  const button = (label, action, extra = {}) => {
    const b = document.createElement('button');
    b.className = 'account-btn';
    b.dataset.action = action;
    b.textContent = label;
    b.onclick = () => {
      const ask = CONFIRM[action];
      if (ask && !confirm(ask(s))) return;
      send({ type: 'account', action: action === 'disarm' ? 'arm' : action, ...(action === 'disarm' ? { on: false } : {}), ...extra });
    };
    actions.appendChild(b);
    return b;
  };
  if (s.status === 'not set up' || s.status === 'ready' || s.status === 'rolled back') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'account-folder';
    input.placeholder = '~/.claude-new';
    input.spellcheck = false;
    input.value = s.folder || '';
    input.setAttribute('aria-label', "New account's config folder");
    actions.appendChild(input);
    const check = document.createElement('button');
    check.className = 'account-btn';
    check.dataset.action = 'setup';
    check.textContent = s.status === 'not set up' ? 'Check folder' : 'Check again';
    check.onclick = () => { if (input.value.trim()) send({ type: 'account', action: 'setup', folder: input.value.trim() }); };
    actions.appendChild(check);
  }
  if (s.status === 'ready') {
    button('Arm: switch when the current account is used up', 'arm');
    button('Switch now', 'migrate');
  }
  if (s.status === 'armed') {
    button('Disarm', 'disarm');
    button('Switch now', 'migrate');
  }
  if (s.status === 'migrated') {
    button('Roll back', 'rollback');
    if (!s.retiredTo) button('Retire the new folder', 'retire');
  }
  body.appendChild(actions);
}
