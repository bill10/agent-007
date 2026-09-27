// @vitest-environment happy-dom
// The "Claude account" panel (public/modules/account.js): off by default, one
// action set per state, every action but the folder check confirmed first.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { setBillionEnabled, setSelf } from '../public/modules/state.js';
import { handleAccountState, renderAccount } from '../public/modules/account.js';

const labels = () => [...document.querySelectorAll('.account-btn')].map(b => b.textContent);
const click = (action) => document.querySelector(`.account-btn[data-action="${action}"]`).click();

beforeEach(() => {
  document.body.innerHTML = '<details id="account-panel" style="display:none"><summary>Claude account</summary><div class="account-body"></div></details>';
  setBillionEnabled(true);
  setSelf(null, false);
  send.mockClear();
  window.confirm = vi.fn(() => true);
});

describe('the Claude account panel', () => {
  it('offers only the folder when nothing is set up', () => {
    handleAccountState({ type: 'account-state', status: 'not set up' });
    expect(document.getElementById('account-panel').style.display).toBe('');
    expect(document.querySelector('.account-status').textContent).toMatch(/^Not set up/);
    expect(labels()).toEqual(['Check folder']);
    const input = document.querySelector('.account-folder');
    click('setup');
    expect(send).not.toHaveBeenCalled();          // an empty folder sends nothing
    input.value = ' ~/.claude-new ';
    click('setup');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'setup', folder: '~/.claude-new' });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('ready: arm and switch now, each behind a confirm', () => {
    handleAccountState({ type: 'account-state', status: 'ready', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x' });
    expect(labels()).toEqual(['Check again', 'Arm: switch when the current account is used up', 'Switch now']);
    window.confirm = vi.fn(() => false);
    click('arm');
    click('migrate');
    expect(send).not.toHaveBeenCalled();
    window.confirm = vi.fn(() => true);
    click('arm');
    expect(window.confirm.mock.calls[0][0]).toMatch(/permanent move, not for getting past a limit/);
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'arm' });
    click('migrate');
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'migrate' });
  });

  it('armed: disarm sends arm off; migrated: roll back and retire, once', () => {
    handleAccountState({ type: 'account-state', status: 'armed', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x' });
    expect(labels()).toEqual(['Disarm', 'Switch now']);
    expect(document.querySelector('.account-status').textContent).toMatch(/Armed: switches old@x → new@x/);
    click('disarm');
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'arm', on: false });
    handleAccountState({ type: 'account-state', status: 'migrated', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x', at: '2026-09-27T10:00:00Z' });
    expect(labels()).toEqual(['Roll back', 'Retire the new folder']);
    expect(document.querySelector('.account-status').textContent).toMatch(/Switched to new@x on 2026-09-27 .*Do not run anything with CLAUDE_CONFIG_DIR=\/h\/.claude-new/);
    click('retire');
    expect(window.confirm.mock.lastCall[0]).toMatch(/never deleted/);
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'retire' });
    handleAccountState({ type: 'account-state', status: 'migrated', folder: '/h/.claude-new', newEmail: 'new@x', retiredTo: '/h/.claude-new.retired-2026-09-27' });
    expect(labels()).toEqual(['Roll back']);
    click('rollback');
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'rollback' });
  });

  it('hides with user accounts on, or without Billion', () => {
    handleAccountState({ type: 'account-state', status: 'ready' });
    setSelf('u1', true);
    renderAccount();
    expect(document.getElementById('account-panel').style.display).toBe('none');
    setSelf(null, false);
    setBillionEnabled(false);
    renderAccount();
    expect(document.getElementById('account-panel').style.display).toBe('none');
  });
});
