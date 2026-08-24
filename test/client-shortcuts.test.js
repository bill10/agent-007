import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../public/modules/terminal.js', () => ({ switchToSession: vi.fn() }));
vi.mock('../public/modules/explorer.js', () => ({ toggleExplorer: vi.fn() }));
vi.mock('../public/modules/voice.js', () => ({ toggleVoice: vi.fn(), stopVoice: vi.fn() }));

import { toggleVoice } from '../public/modules/voice.js';
import { isGlobalShortcut, GLOBAL_SHORTCUT_KEYS, setupShortcuts } from '../public/modules/shortcuts.js';

function evt(overrides = {}) {
  return { metaKey: false, ctrlKey: false, altKey: false, key: '', repeat: false, preventDefault: vi.fn(), ...overrides };
}

describe('isGlobalShortcut (Cmd chord predicate shared with xterm filter)', () => {
  it('matches Cmd plus every registered shortcut key (incl. the new "d" for voice)', () => {
    expect(GLOBAL_SHORTCUT_KEYS).toContain('d');
    for (const key of GLOBAL_SHORTCUT_KEYS) {
      expect(isGlobalShortcut(evt({ metaKey: true, key }))).toBe(true);
    }
  });

  it('rejects chords that also hold Ctrl or Alt (Cmd must be the only modifier)', () => {
    expect(isGlobalShortcut(evt({ metaKey: true, ctrlKey: true, key: 'd' }))).toBe(false);
    expect(isGlobalShortcut(evt({ metaKey: true, altKey: true, key: 'd' }))).toBe(false);
    expect(isGlobalShortcut(evt({ ctrlKey: true, key: 'd' }))).toBe(false);
  });

  it('rejects Shift chords naturally because e.key is uppercase', () => {
    expect(isGlobalShortcut(evt({ metaKey: true, key: 'D' }))).toBe(false);
    expect(isGlobalShortcut(evt({ metaKey: true, key: 'E' }))).toBe(false);
  });

  it('rejects unregistered keys and bare keys without Cmd', () => {
    expect(isGlobalShortcut(evt({ metaKey: true, key: 'k' }))).toBe(false);
    expect(isGlobalShortcut(evt({ metaKey: true, key: '0' }))).toBe(false);
    expect(isGlobalShortcut(evt({ key: 'd' }))).toBe(false);
  });
});

describe('setupShortcuts Cmd+D dispatch (voice toggle)', () => {
  let handler;

  beforeEach(() => {
    handler = null;
    toggleVoice.mockClear();
    globalThis.document = {
      addEventListener: (type, fn) => { if (type === 'keydown') handler = fn; },
      getElementById: vi.fn(),
    };
  });

  afterEach(() => {
    delete globalThis.document;
  });

  it('Cmd+D calls toggleVoice and preventDefault; key-repeat is ignored', () => {
    setupShortcuts();
    const e = evt({ metaKey: true, key: 'd' });
    handler(e);
    expect(toggleVoice).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();

    const held = evt({ metaKey: true, key: 'd', repeat: true });
    handler(held);
    expect(toggleVoice).toHaveBeenCalledTimes(1);
    expect(held.preventDefault).not.toHaveBeenCalled();
  });
});
