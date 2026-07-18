import { describe, it, expect } from 'vitest';
import { setSelf, canControlAgent } from '../public/modules/state.js';

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
