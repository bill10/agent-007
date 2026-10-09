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
  // Unsaved edits live in the module; an interrupted switch always drops them.
  handleAccountState({ type: 'account-state', rotation: { pending: true, accounts: [] }, codexRotation: { pending: true, accounts: [] } });
});
describe('account rotation settings', () => {
  it('keeps the folder available to correct after an error and emphasizes recovery errors', () => {
    const rotation = { enabled: false, accounts: [{ ...account('a', 'a@x'), error: 'Sign in again' }] };
    show(rotation);
    const input = document.querySelector('#account-config-folder');
    input.value = '/incorrect/folder'; input.dispatchEvent(new Event('input'));
    handleAccountError({ message: 'Folder not found' });
    expect(document.querySelector('#account-config-folder').value).toBe('/incorrect/folder');
    expect([...document.querySelectorAll('.account-error')].some(el => el.textContent === 'Sign in again')).toBe(true);
    show({ pending: true, accounts: [] });
    expect(document.querySelector('.account-error').textContent).toContain('switch was interrupted');
    show(rotation); document.querySelector('#account-config-folder').value = ''; document.querySelector('#account-config-folder').dispatchEvent(new Event('input'));
  });

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

  it('shows the disabled auto-switch control before discovery', () => {
    show({ enabled: false, defaultSettings: true, fallback: true, accounts: [] });
    expect(document.body.textContent).toContain('Finding two logged-in accounts enables auto-switching');
    expect(document.querySelector('#account-auto-switch').disabled).toBe(true);
    expect(document.querySelector('.account-manual').open).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('directs a single-account setup to discovery rather than selecting a missing account', () => {
    show({ enabled: false, defaultSettings: false, accounts: [account('a', 'a@x')] });
    expect(document.querySelector('#account-auto-switch').disabled).toBe(true);
    expect(document.querySelector('#account-auto-switch-hint').textContent).toContain('Find at least two');
  });
  it('offers discovery and custom folders without enabling rotation', () => {
    show({ enabled: false, fallback: true, accounts: [] });
    expect(document.querySelector('#account-auto-switch').checked).toBe(false);
    click('rotation-add'); expect(send).not.toHaveBeenCalled();
    document.querySelector('#account-config-folder').value = ' ~/.claude-work ';
    click('rotation-add'); expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-add', folder: '~/.claude-work' });
    expect(window.confirm).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('button')].every(b => b.disabled)).toBe(true);
  });
  it('saves order and inclusion together, confirms enabling once', () => {
    show({ enabled: false, active: 'a', accounts: [account('a', 'a@x', 'Active'), account('b', 'b@x'), account('c', 'c@x')] });
    document.querySelectorAll('[data-action="rotation-up"]')[2].click();
    const boxes = document.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(4);
    boxes[3].click(); boxes[0].click();
    click('rotation-configure');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-configure', enabled: true, accounts: [{ id: 'a', enabled: true }, { id: 'c', enabled: true }, { id: 'b', enabled: false }] });
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });
  it('prevents enabling or saving auto-switch with fewer than two selected accounts but allows turning it off', () => {
    show({ enabled: true, active: 'a', accounts: [account('a', 'a@x'), account('b', 'b@x')] });
    document.querySelectorAll('.rotation-account input')[1].click();
    expect(document.querySelector('[data-action="rotation-configure"]').disabled).toBe(true);
    const auto = document.querySelector('#account-auto-switch');
    expect(auto.disabled).toBe(false);
    auto.click();
    expect(auto.disabled).toBe(true);
    click('rotation-configure');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
  it('unlocks automatic switching when a second account is selected and blocks duplicate saves', () => {
    show({ enabled: false, accounts: [account('a', 'a@x'), { ...account('b', 'b@x'), enabled: false }] });
    const auto = document.querySelector('#account-auto-switch');
    expect(auto.disabled).toBe(true);
    expect(document.getElementById(auto.getAttribute('aria-describedby')).textContent).toContain('Select at least two');
    document.querySelectorAll('.rotation-account input')[1].click();
    expect(auto.disabled).toBe(false);
    auto.click();
    click('rotation-configure'); click('rotation-configure');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
  it('keeps the draft editable when enabling automatic switching is cancelled', () => {
    show({ enabled: false, accounts: [account('a', 'a@x'), account('b', 'b@x')] });
    document.querySelector('#account-auto-switch').click();
    window.confirm.mockReturnValue(false);
    click('rotation-configure');
    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector('[data-action="rotation-configure"]').disabled).toBe(false);
    expect(document.querySelector('#account-auto-switch').checked).toBe(true);
  });
  it('keeps manual folder entry expanded after an error and collapsed after closing it', () => {
    const rotation = { enabled: false, accounts: [] };
    show(rotation);
    const manual = document.querySelector('.account-manual');
    manual.open = true; manual.dispatchEvent(new Event('toggle'));
    const input = document.querySelector('#account-config-folder');
    input.value = '/missing/account'; input.dispatchEvent(new Event('input'));
    click('rotation-add');
    handleAccountError({ message: 'Folder not found' });
    expect(document.querySelector('.account-manual').open).toBe(true);
    expect(document.querySelector('#account-config-folder').value).toBe('/missing/account');
    const restored = document.querySelector('.account-manual');
    restored.open = false; restored.dispatchEvent(new Event('toggle'));
    show(rotation);
    expect(document.querySelector('.account-manual').open).toBe(false);
    document.querySelector('#account-config-folder').value = '';
    document.querySelector('#account-config-folder').dispatchEvent(new Event('input'));
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
  // Value: protects=an old-version switch left 'switching' still offers Restore login from previous version, sending rollback after confirm;
  //   fails_when=the rollback button drops its status check, skips confirm, or sends a cli/other action;
  //   why_new=no client test covered the legacy rollback button; seam=none
  it('offers the previous-version restore for an interrupted old switch, after confirm', () => {
    handleAccountState({ type: 'account-state', status: 'switching', rotation: { enabled: false, accounts: [] }, codexRotation: { enabled: false, accounts: [] } });
    expect(document.querySelectorAll('[data-action="rollback"]')).toHaveLength(1);
    const restore = document.querySelector('[data-action="rollback"]');
    expect(restore.textContent).toBe('Restore login from previous version');
    window.confirm.mockReturnValue(false); restore.click(); expect(send).not.toHaveBeenCalled();
    window.confirm.mockReturnValue(true); restore.click();
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rollback' });
    handleAccountState({ type: 'account-state', status: 'idle', rotation: { enabled: false, accounts: [] } });
    expect(document.querySelector('[data-action="rollback"]')).toBeNull();
  });
});

describe('one list of Claude and Codex accounts', () => {
  const both = (rotation, codexRotation) => handleAccountState({ type: 'account-state', rotation, codexRotation });
  const emails = () => [...document.querySelectorAll('.rotation-account label span:first-of-type')].map(s => s.textContent);
  const tags = () => [...document.querySelectorAll('.account-cli-tag')].map(s => s.textContent);
  const claude = { enabled: true, active: 'a', accounts: [account('a', 'a@x', 'Active'), account('b', 'b@x')] };
  const codexState = { enabled: true, active: 'c', accounts: [account('c', 'c@x', 'Active'), account('d', 'd@x')] };
  // Value: protects=old per-CLI settings (no rank) show Claude first then Codex, each in saved order, and saved ranks order the mixed list;
  //   fails_when=the merge drops a CLI, sorts unstable, or ignores rank; why_new=one list replaced two sections; seam=none
  it('lists Claude accounts then Codex, each tagged, until a saved order mixes them', () => {
    both(claude, codexState);
    expect(emails()).toEqual(['a@x', 'b@x', 'c@x', 'd@x']);
    expect(tags()).toEqual(['Claude', 'Claude', 'Codex', 'Codex']);
    expect(document.querySelectorAll('#account-auto-switch')).toHaveLength(1);
    expect(document.querySelectorAll('[data-action="rotation-discover"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-action="rotation-configure"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Fall back');
    expect(document.body.textContent).toContain('other tools that read it follow it');
    const ranked = (r, ranks) => ({ ...r, accounts: r.accounts.map((a, i) => ({ ...a, rank: ranks[i] })) });
    both(ranked(claude, [0, 2]), ranked(codexState, [1, 3]));
    expect(emails()).toEqual(['a@x', 'c@x', 'b@x', 'd@x']);
  });
  it('saves one mixed order for both CLIs, with no cli and no fallback', () => {
    both(claude, codexState);
    document.querySelectorAll('[data-action="rotation-up"]')[2].click();   // c above b
    click('rotation-configure');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-configure', enabled: true,
      accounts: ['a', 'c', 'b', 'd'].map(id => ({ id, enabled: true })) });
    expect(window.confirm).not.toHaveBeenCalled();
  });
  it('counts selected accounts across both CLIs', () => {
    both({ enabled: false, active: 'a', accounts: [account('a', 'a@x', 'Active')] }, { enabled: false, active: 'c', accounts: [account('c', 'c@x', 'Active')] });
    expect(document.querySelector('#account-auto-switch').disabled).toBe(false);
  });
  it('keeps each CLI\'s own active account and sends cli: codex for a Codex row', () => {
    both(claude, codexState);
    const switches = [...document.querySelectorAll('[data-action="rotation-switch"]')];
    expect(switches.map(b => b.closest('.rotation-account').dataset.cli)).toEqual(['claude', 'codex']);
    switches[1].click();
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-switch', cli: 'codex', id: 'd' });
    expect(switches[1].getAttribute('aria-label')).toBe('Switch Codex to d@x now');
  });
  it('keeps unsaved edits when a state update arrives, and drops them once saved', () => {
    both(claude, codexState);
    document.querySelectorAll('[data-action="rotation-down"]')[1].click();   // b below c
    both(claude, codexState);
    expect(emails()).toEqual(['a@x', 'c@x', 'b@x', 'd@x']);
    click('rotation-configure');
    handleAccountError({ message: 'Invalid rotation settings.' });
    both(claude, codexState);
    expect(emails()).toEqual(['a@x', 'c@x', 'b@x', 'd@x']);
    const rank = (r, ranks) => ({ ...r, accounts: r.accounts.map((a, i) => ({ ...a, rank: ranks[i] })) });
    both(rank(claude, [0, 2]), rank(codexState, [1, 3]));
    both(claude, codexState);
    expect(emails()).toEqual(['a@x', 'b@x', 'c@x', 'd@x']);
  });
  it('keeps unsaved edits through a lasting registry error, and drops them when the account list changes', () => {
    both(claude, codexState);
    document.querySelectorAll('[data-action="rotation-down"]')[0].click();
    both(claude, { ...codexState, error: 'The selected login failed; the previous login was restored.' });
    expect(emails()).toEqual(['b@x', 'a@x', 'c@x', 'd@x']);
    expect(document.querySelector('.account-error').textContent).toContain('selected login failed');
    both(claude, { ...codexState, accounts: [...codexState.accounts, account('e', 'e@x')] });
    expect(emails()).toEqual(['a@x', 'b@x', 'c@x', 'd@x', 'e@x']);
  });
  it('holds the list for an interrupted Codex switch and offers Restore previous Codex login', () => {
    both(claude, codexState);
    document.querySelectorAll('[data-action="rotation-down"]')[0].click();
    both(claude, { ...codexState, pending: true });
    expect(document.querySelector('[data-action="rotation-discover"]')).toBeNull();
    expect(document.querySelector('.account-error').textContent).toContain('Codex account switch was interrupted');
    click('rotation-recover');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-recover', cli: 'codex' });
  });
  it('adds a folder for the CLI picked next to it', () => {
    both({ enabled: false, accounts: [] }, { enabled: false, accounts: [] });
    const kind = document.querySelector('#account-folder-cli');
    kind.value = 'codex'; kind.dispatchEvent(new Event('change'));
    const input = document.querySelector('#account-config-folder');
    expect(input.placeholder).toBe('~/.codex-work');
    input.value = '~/.codex-work'; click('rotation-add');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-add', cli: 'codex', folder: '~/.codex-work' });
    kind.value = 'claude'; kind.dispatchEvent(new Event('change'));
  });
});
