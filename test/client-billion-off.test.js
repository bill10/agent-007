// @vitest-environment happy-dom
// Billion off (BILLION=0): no Billion tab, and anything that routes to the chat
// lands on the Jobs board instead.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/jobs.js', () => ({
  showJobBoard: vi.fn(),
  hideJobBoard: vi.fn(),
  attachmentName: vi.fn(),
  MAX_ATTACHMENT_BYTES: 0, MAX_ATTACHMENTS: 0, MAX_ATTACHMENT_TOTAL_BYTES: 0,
}));
vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { showJobBoard } from '../public/modules/jobs.js';
import { setBillionEnabled, billionOff } from '../public/modules/state.js';
import { showWaiting } from '../public/modules/waiting.js';
import { updateTabs } from '../public/modules/terminal.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="terminal-tabs"></div><div id="waiting-board"></div><div id="terminal-empty"></div>';
  vi.clearAllMocks();
});

describe('Billion off', () => {
  it('draws the Billion tab with Billion on', () => {
    setBillionEnabled(true);
    updateTabs();
    expect(document.querySelector('.waiting-tab')).not.toBeNull();
  });

  it('draws no Billion tab, and showWaiting opens Jobs instead', () => {
    setBillionEnabled(false);
    expect(billionOff()).toBe(true);
    updateTabs();
    expect(document.querySelector('.waiting-tab')).toBeNull();
    showWaiting();
    expect(showJobBoard).toHaveBeenCalled();
    expect(document.getElementById('waiting-board').style.display).not.toBe('flex');
  });
});
