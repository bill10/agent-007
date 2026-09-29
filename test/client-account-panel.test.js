// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
import { send } from '../public/modules/ws.js';
import { setBillionEnabled, setSelf } from '../public/modules/state.js';
import { handleAccountState, handleAccountError, renderAccount } from '../public/modules/account.js';
const click = action => document.querySelector(`[data-action="${action}"]`).click();
const account = (id, email, status = 'Available') => ({ id, email, enabled: true, status });
const show = rotation => handleAccountState({ type: 'account-state', rotation });
beforeEach(() => {
  document.body.innerHTML = '<div id="account-panel"><div class="account-body"></div></div>';
  setBillionEnabled(true); setSelf(null, false); send.mockReset(); send.mockReturnValue(true);
  window.confirm = vi.fn(() => true);
  handleAccountError({ message: null });
});
describe('account rotation settings', () => {
  it('restores controls and reports a disconnected socket so the owner can retry', () => {
    show({ enabled: false, accounts: [] });
    send.mockReturnValue(false);
    click('rotation-discover');
    expect(document.querySelector('.account-error').textContent).toContain('Not connected');
    expect(document.querySelector('[data-action="rotation-discover"]').disabled).toBe(false);
    send.mockReturnValue(true);
    click('rotation-discover');
    expect(send).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-action="rotation-discover"]').disabled).toBe(true);
  });

  it('explains that the default starts once two accounts are added', () => {
    show({ enabled: false, defaultSettings: true, fallback: true, accounts: [] });
    expect(document.body.textContent).toContain('starts when at least two accounts are added');
    expect(send).not.toHaveBeenCalled();
  });
  it('offers discovery and custom folders without enabling rotation', () => {
    show({ enabled: false, fallback: true, accounts: [] });
    expect(document.body.textContent).toContain('rotation is off');
    click('rotation-add'); expect(send).not.toHaveBeenCalled();
    document.querySelector('.account-folder').value = ' ~/.claude-work ';
    click('rotation-add'); expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-add', folder: '~/.claude-work' });
    expect(window.confirm).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('button')].every(b => b.disabled)).toBe(true);
  });
  it('saves order, inclusion and fallback together, confirms enabling once', () => {
    show({ enabled: false, fallback: true, active: 'a', accounts: [account('a', 'a@x', 'Active'), account('b', 'b@x'), account('c', 'c@x')] });
    document.querySelectorAll('[data-action="rotation-up"]')[2].click();
    const boxes = document.querySelectorAll('input[type="checkbox"]');
    boxes[2].click(); boxes[3].click(); boxes[4].click();
    click('rotation-configure');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-configure', enabled: true, fallback: false, accounts: [{ id: 'a', enabled: true }, { id: 'c', enabled: true }, { id: 'b', enabled: false }] });
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });
  it('switches by account id, renders emails as text, and keeps errors visible after state updates', () => {
    const rotation = { enabled: true, active: 'a', accounts: [account('a', 'a@x'), account('b', '<img src=x>')] };
    show(rotation); expect(document.querySelector('img')).toBeNull();
    window.confirm.mockReturnValue(false); click('rotation-switch'); expect(send).not.toHaveBeenCalled();
    window.confirm.mockReturnValue(true); click('rotation-switch');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-switch', id: 'b' });
    handleAccountError({ message: 'Another Claude process is running.' }); show(rotation);
    expect(document.querySelector('.account-error').textContent).toContain('Another Claude process');
  });
  it('offers recovery after an interrupted switch and hides when owner actions are unavailable', () => {
    show({ pending: true, accounts: [] });
    expect(document.querySelector('[data-action="rotation-discover"]')).toBeNull();
    click('rotation-recover'); expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-recover' });
    setSelf('u1', true); renderAccount(); expect(document.getElementById('account-panel').hidden).toBe(true);
    setSelf(null, false); setBillionEnabled(false); renderAccount(); expect(document.getElementById('account-panel').hidden).toBe(true);
  });
});
