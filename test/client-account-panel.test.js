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
    const input = document.querySelector('.account-folder');
    input.value = '/incorrect/folder'; input.dispatchEvent(new Event('input'));
    handleAccountError({ message: 'Folder not found' });
    expect(document.querySelector('.account-folder').value).toBe('/incorrect/folder');
    expect([...document.querySelectorAll('.account-error')].some(el => el.textContent === 'Sign in again')).toBe(true);
    show({ pending: true, accounts: [] });
    expect(document.querySelector('.account-error').textContent).toContain('switch was interrupted');
    show(rotation); document.querySelector('.account-folder').value = ''; document.querySelector('.account-folder').dispatchEvent(new Event('input'));
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
    document.querySelector('.account-folder').value = ' ~/.claude-work ';
    click('rotation-add'); expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-add', folder: '~/.claude-work' });
    expect(window.confirm).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('button')].every(b => b.disabled)).toBe(true);
  });
  it('saves order, inclusion and fallback together, confirms enabling once', () => {
    show({ enabled: false, fallback: true, active: 'a', accounts: [account('a', 'a@x', 'Active'), account('b', 'b@x'), account('c', 'c@x')] });
    document.querySelectorAll('[data-action="rotation-up"]')[2].click();
    const boxes = document.querySelectorAll('input[type="checkbox"]');
    boxes[3].click(); boxes[0].click(); boxes[4].click();
    click('rotation-configure');
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-configure', enabled: true, fallback: false, accounts: [{ id: 'a', enabled: true }, { id: 'c', enabled: true }, { id: 'b', enabled: false }] });
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
    const input = document.querySelector('.account-folder');
    input.value = '/missing/account'; input.dispatchEvent(new Event('input'));
    click('rotation-add');
    handleAccountError({ message: 'Folder not found' });
    expect(document.querySelector('.account-manual').open).toBe(true);
    expect(document.querySelector('.account-folder').value).toBe('/missing/account');
    const restored = document.querySelector('.account-manual');
    restored.open = false; restored.dispatchEvent(new Event('toggle'));
    show(rotation);
    expect(document.querySelector('.account-manual').open).toBe(false);
    document.querySelector('.account-folder').value = '';
    document.querySelector('.account-folder').dispatchEvent(new Event('input'));
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
    expect(document.querySelector('[data-cli="claude"] [data-action="rotation-discover"]')).toBeNull();
    click('rotation-recover'); expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-recover' });
    setSelf('u1', true); renderAccount(); expect(document.getElementById('account-panel').hidden).toBe(true);
    setSelf(null, false); setBillionEnabled(false); renderAccount(); expect(document.getElementById('account-panel').hidden).toBe(true);
  });
  // Value: protects=an old-version switch left 'switching' still offers Restore login from previous version under Claude, sending rollback after confirm;
  //   fails_when=the rollback button moves out of the Claude section, drops its status check, skips confirm, or sends a cli/other action;
  //   why_new=no client test covered the legacy rollback button after it moved out of renderCli; seam=none
  it('offers the previous-version restore under Claude for an interrupted old switch, after confirm', () => {
    handleAccountState({ type: 'account-state', status: 'switching', rotation: { enabled: false, accounts: [] }, codexRotation: { enabled: false, accounts: [] } });
    expect(document.querySelector('[data-cli="codex"] [data-action="rollback"]')).toBeNull();
    const restore = document.querySelector('[data-cli="claude"] [data-action="rollback"]');
    expect(restore.textContent).toBe('Restore login from previous version');
    window.confirm.mockReturnValue(false); restore.click(); expect(send).not.toHaveBeenCalled();
    window.confirm.mockReturnValue(true); restore.click();
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rollback' });
    handleAccountState({ type: 'account-state', status: 'idle', rotation: { enabled: false, accounts: [] } });
    expect(document.querySelector('[data-action="rollback"]')).toBeNull();
  });
});

describe('Codex account rotation settings', () => {
  const codex = rotation => handleAccountState({ type: 'account-state', rotation: { enabled: false, accounts: [] }, codexRotation: rotation });
  const inCodex = sel => document.querySelector(`[data-cli="codex"] ${sel}`);
  // Value: protects=unsaved edits in one section survive a state update caused by an action in the other section;
  //   fails_when=handleAccountState overwrites every CLI's draft on each message;
  //   why_new=before two sections there was one draft and one Save; seam=none
  it('keeps unsaved Claude edits when a Codex action updates the state, and drops them once Claude saves', () => {
    const claude = { enabled: false, fallback: true, active: 'a', accounts: [account('a', 'a@x', 'Active'), account('b', 'b@x')] };
    const codexState = { enabled: false, accounts: [account('c', 'c@x')] };
    handleAccountState({ type: 'account-state', rotation: claude, codexRotation: codexState });
    document.querySelectorAll('[data-cli="claude"] [data-action="rotation-down"]')[0].click();
    inCodex('[data-action="rotation-discover"]').click();
    handleAccountState({ type: 'account-state', rotation: claude, codexRotation: { ...codexState, accounts: [account('c', 'c@x'), account('d', 'd@x')] } });
    expect([...document.querySelectorAll('[data-cli="claude"] .rotation-account label span')].map(s => s.textContent)).toEqual(['b@x', 'a@x']);
    expect(document.querySelectorAll('[data-cli="codex"] .rotation-account')).toHaveLength(2);
    document.querySelector('[data-cli="claude"] [data-action="rotation-configure"]').click();
    // A refused save keeps the edits; the saved order arriving clears them.
    handleAccountError({ message: 'Invalid rotation settings.' });
    handleAccountState({ type: 'account-state', rotation: claude, codexRotation: codexState });
    expect([...document.querySelectorAll('[data-cli="claude"] .rotation-account label span')].map(s => s.textContent)).toEqual(['b@x', 'a@x']);
    const saved = { ...claude, accounts: [claude.accounts[1], claude.accounts[0]] };
    handleAccountState({ type: 'account-state', rotation: saved, codexRotation: codexState });
    handleAccountState({ type: 'account-state', rotation: claude, codexRotation: codexState });
    expect([...document.querySelectorAll('[data-cli="claude"] .rotation-account label span')].map(s => s.textContent)).toEqual(['a@x', 'b@x']);
  });
  it('drops unsaved edits for an interrupted switch, so Restore previous login shows', () => {
    const codexState = { enabled: true, active: 'c', accounts: [account('c', 'c@x', 'Active'), account('d', 'd@x')] };
    codex(codexState);
    inCodex('[data-action="rotation-down"]').click();
    codex({ ...codexState, pending: true });
    expect(inCodex('[data-action="rotation-recover"]')).not.toBeNull();
  });
  it('names the CLI on controls repeated in both sections', () => {
    codex({ enabled: true, active: 'c', accounts: [account('c', 'c@x', 'Active'), account('d', 'd@x')] });
    expect(inCodex('[data-action="rotation-discover"]').getAttribute('aria-label')).toBe('Find logged-in Codex accounts');
    expect(inCodex('[data-action="rotation-configure"]').getAttribute('aria-label')).toBe('Save Codex settings');
    expect(document.querySelector('[data-cli="claude"] [data-action="rotation-discover"]').getAttribute('aria-label')).toBe('Find logged-in Claude accounts');
  });
  it('lists Codex accounts in their own section after Claude, with the same controls', () => {
    codex({ enabled: true, active: 'c', fallback: true, accounts: [account('c', 'c@x', 'Active'), account('d', 'd@x')] });
    expect([...document.querySelectorAll('.account-cli-title')].map(h => h.textContent)).toEqual(['Claude Code', 'Codex']);
    for (const action of ['rotation-discover', 'rotation-up', 'rotation-down', 'rotation-switch', 'rotation-configure']) expect(inCodex(`[data-action="${action}"]`)).not.toBeNull();
    expect(inCodex('#account-auto-switch-codex').checked).toBe(true);
    expect(document.querySelector('[data-cli="codex"]').textContent).toContain('Fall back to Claude Code when Codex accounts are unavailable');
    expect(document.querySelector('[data-cli="codex"]').textContent).toContain('other tools that read it follow the switch');
  });
  it('sends cli: codex on every Codex action and shows its error in the Codex section only', () => {
    codex({ enabled: true, active: 'c', accounts: [account('c', 'c@x', 'Active'), account('d', 'd@x')] });
    inCodex('[data-action="rotation-switch"]').click();
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-switch', cli: 'codex', id: 'd' });
    handleAccountError({ message: 'Another Codex process is running outside this app.' });
    expect(inCodex('.account-error').textContent).toContain('Another Codex process');
    expect(document.querySelector('[data-cli="claude"] .account-error')).toBeNull();
    inCodex('[data-action="rotation-discover"]').click();
    expect(send).toHaveBeenLastCalledWith({ type: 'account', action: 'rotation-discover', cli: 'codex' });
  });
  it('offers Restore previous login for an interrupted Codex switch while Claude stays usable', () => {
    codex({ pending: true, accounts: [] });
    expect(inCodex('[data-action="rotation-discover"]')).toBeNull();
    expect(document.querySelector('[data-cli="claude"] [data-action="rotation-discover"]')).not.toBeNull();
    inCodex('[data-action="rotation-recover"]').click();
    expect(send).toHaveBeenCalledWith({ type: 'account', action: 'rotation-recover', cli: 'codex' });
  });
});
