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
  document.body.innerHTML = '<div id="account-panel" hidden><div class="settings-section-head"><h2>Claude account</h2></div><div class="account-body"></div></div>';
  setBillionEnabled(true);
  setSelf(null, false);
  send.mockClear();
  window.confirm = vi.fn(() => true);
});

describe('the Claude account panel', () => {
  it('offers only the folder when nothing is set up', () => {
    handleAccountState({ type: 'account-state', status: 'not set up' });
    expect(document.getElementById('account-panel').hidden).toBe(false);
    expect(document.querySelector('.account-status').textContent).toMatch(/^Not set up/);
    expect(labels()).toEqual(['Check folder']);
    const input = document.querySelector('.account-folder');
    expect(input.required).toBe(true);
    click('setup');
    expect(send).not.toHaveBeenCalled();          // an empty folder sends nothing, and the buttons stay live
    expect(document.querySelector('.account-btn').disabled).toBe(false)
    input.value = ' ~/.claude-new ';
    click('setup');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'setup', folder: '~/.claude-new' });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('ready: arm and switch now, each behind a confirm', () => {
    handleAccountState({ type: 'account-state', status: 'ready', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x' });
    expect(labels()).toEqual(['Check again', 'Arm', 'Switch now']);
    window.confirm = vi.fn(() => false);
    click('arm');
    click('migrate');
    expect(send).not.toHaveBeenCalled();
    window.confirm = vi.fn(() => true);
    click('arm');
    expect(window.confirm.mock.calls[0][0]).toMatch(/permanent move, not for getting past a limit/);
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'arm' });
    // Sent once: every button waits for the server's next state.
    expect([...document.querySelectorAll('.account-btn')].every(b => b.disabled)).toBe(true);
    click('migrate');
    expect(send).toHaveBeenCalledTimes(1);
    handleAccountState({ type: 'account-state', status: 'ready', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x' });
    click('migrate');
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'migrate' });
    expect(document.querySelector('.account-btn').className).toContain('settings-refresh');
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

  it('rolled back: says why, offers the folder again, and arms nothing', () => {
    handleAccountState({ type: 'account-state', status: 'rolled back', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x', error: 'claude auth status reports old@x after the swap, not new@x' });
    const status = document.querySelector('.account-status');
    expect(status.textContent).toBe('Rolled back to old@x (claude auth status reports old@x after the swap, not new@x).');
    expect(status.dataset.status).toBe('rolled back');
    expect(labels()).toEqual(['Check again']);
    expect(document.querySelector('.account-folder').value).toBe('/h/.claude-new');
    click('setup');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'setup', folder: '/h/.claude-new' });
    // Without an error to show, the line ends after the email.
    handleAccountState({ type: 'account-state', status: 'rolled back', oldEmail: 'old@x' });
    expect(document.querySelector('.account-status').textContent).toBe('Rolled back to old@x.');
  });

  it('migrated: a cancelled confirm sends nothing, and a retired folder is named', () => {
    handleAccountState({ type: 'account-state', status: 'migrated', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x', at: '2026-09-27T10:00:00Z' });
    window.confirm = vi.fn(() => false);
    click('rollback');
    click('retire');
    expect(send).not.toHaveBeenCalled();
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(window.confirm.mock.calls[0][0]).toMatch(/Roll back to old@x\?/);
    handleAccountState({ type: 'account-state', status: 'migrated', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x', at: '2026-09-27T10:00:00Z', retiredTo: '/h/.claude-new.retired-2026-09-27' });
    expect(document.querySelector('.account-status').textContent).toBe('Switched to new@x on 2026-09-27 (was old@x). Folder retired as /h/.claude-new.retired-2026-09-27.');
    expect(document.querySelector('.account-folder')).toBeNull();
  });

  it('armed: a cancelled disarm sends nothing; an unknown status shows as is; no panel is a no-op', () => {
    handleAccountState({ type: 'account-state', status: 'armed', oldEmail: 'old@x', newEmail: 'new@x' });
    window.confirm = vi.fn(() => false);
    click('disarm');
    expect(send).not.toHaveBeenCalled();
    expect(window.confirm.mock.calls[0][0]).toMatch(/^Disarm\?/);
    handleAccountState({ type: 'account-state', status: 'something new' });
    expect(document.querySelector('.account-status').textContent).toBe('something new');
    expect(labels()).toEqual([]);
    document.body.innerHTML = '';
    expect(() => renderAccount()).not.toThrow();
  });

  it("shows the last error on a ready line, and offers only Roll back while a switch hangs or a rollback failed", () => {
    handleAccountState({ type: 'account-state', status: 'ready', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x', error: '/h/.claude-new does not exist' });
    expect(document.querySelector('.account-status').textContent).toMatch(/Nothing armed\. Last attempt: \/h\/.claude-new does not exist/);
    handleAccountState({ type: 'account-state', status: 'switching', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x', at: '2026-09-27T10:00:00Z' });
    expect(document.querySelector('.account-status').textContent).toMatch(/started on 2026-09-27 and did not finish/);
    expect(labels()).toEqual(['Roll back']);
    handleAccountState({ type: 'account-state', status: 'rollback failed', folder: '/h/.claude-new', oldEmail: 'old@x', newEmail: 'new@x', error: 'boom' });
    expect(document.querySelector('.account-status').textContent).toMatch(/so did the rollback: boom/);
    expect(labels()).toEqual(['Check again', 'Roll back']);   // the way out once the store works again
    click('rollback');
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'rollback' });
  });

  it('hides with user accounts on, or without Billion', () => {
    handleAccountState({ type: 'account-state', status: 'ready' });
    setSelf('u1', true);
    renderAccount();
    expect(document.getElementById('account-panel').hidden).toBe(true);
    setSelf(null, false);
    setBillionEnabled(false);
    renderAccount();
    expect(document.getElementById('account-panel').hidden).toBe(true);
  });
});
