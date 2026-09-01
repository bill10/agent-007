// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

// office.js only needs switchToSession from terminal.js, which pulls in xterm.
vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));

const { charVariant, CHAR_VARIANTS } = await import('../public/modules/office.js');

// Each agent gets one of the six pixel-agents sprite sheets, picked from its
// session id so the look survives re-renders and agents joining or leaving.
describe('character variant assignment', () => {
  it('is deterministic and stays within the six sheets', () => {
    const ids = ['sess-a', 'sess-b', '', 'a-very-long-session-id-0123456789', '日本語'];
    for (const id of ids) {
      const v = charVariant(id);
      expect(v).toBe(charVariant(id));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(CHAR_VARIANTS);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('has a sprite sheet on disk for every variant', () => {
    for (let i = 0; i < CHAR_VARIANTS; i++) {
      expect(existsSync(`public/assets/characters/char_${i}.png`), `char_${i}.png`).toBe(true);
    }
  });

  it('spreads different ids across variants', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(charVariant(`session-${i}`));
    expect(seen.size).toBeGreaterThan(1);
  });
});
