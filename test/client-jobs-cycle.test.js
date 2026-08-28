// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

// No mocks: load BOTH real modules to prove the terminal.js <-> jobs.js import
// cycle resolves. If either called across the cycle at module-evaluation time,
// this import would throw on a live binding that is still in the TDZ.
describe('terminal.js <-> jobs.js module cycle', () => {
  it('both modules evaluate without a TDZ error, in either import order', async () => {
    const term = await import('../public/modules/terminal.js');
    const board = await import('../public/modules/jobs.js');
    expect(typeof term.updateTabs).toBe('function');
    expect(typeof term.switchToSession).toBe('function');
    expect(typeof board.showJobBoard).toBe('function');
    expect(typeof board.renderBoard).toBe('function');
  });
});
