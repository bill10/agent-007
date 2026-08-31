import { describe, it, expect } from 'vitest';
import { setSelf, canControlAgent } from '../public/modules/state.js';
import * as state from '../public/modules/state.js';

describe('setSelf serverPlatform', () => {
  it('stores the platform from the welcome message', () => {
    setSelf('u_a', false, 'win32');
    expect(state.serverPlatform).toBe('win32');
  });

  it('keeps the previous platform when the param is missing', () => {
    setSelf('u_a', false, 'linux');
    setSelf('u_b', true); // welcome without platform (older server)
    expect(state.serverPlatform).toBe('linux');
  });

  it('offers PowerShell as the shell preset on a win32 server', () => {
    setSelf('u_a', false, 'win32');
    expect(state.shellPreset()).toEqual({ label: 'PowerShell', cmd: 'powershell.exe' });
  });

  it('offers bash as the shell preset otherwise', () => {
    setSelf('u_a', false, 'darwin');
    expect(state.shellPreset()).toEqual({ label: 'Bash', cmd: 'bash' });
  });
});

describe('canControlAgent (client read-only guard)', () => {
  it('allows everything when auth is disabled (single-player)', () => {
    setSelf('u_a', false);
    expect(canControlAgent({ ownerId: 'u_b' })).toBe(true);
    expect(canControlAgent({ ownerId: null })).toBe(true);
    expect(canControlAgent(null)).toBe(true);
  });

  it('with auth on: owner and unowned allowed, non-owner blocked', () => {
    setSelf('u_a', true);
    expect(canControlAgent({ ownerId: 'u_a' })).toBe(true);   // owner
    expect(canControlAgent({ ownerId: null })).toBe(true);    // unowned
    expect(canControlAgent({})).toBe(true);                   // no ownerId
    expect(canControlAgent({ ownerId: 'u_b' })).toBe(false);  // non-owner
  });
});
