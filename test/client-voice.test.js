import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { agents, setActiveSession, setSelf } from '../public/modules/state.js';
import {
  normalizeTranscript, deliverToActivePty,
  collectResults, interimTail, recognitionErrorMessage, onEndAction,
} from '../public/modules/voice.js';

describe('normalizeTranscript (voice input)', () => {
  it('trims and appends a single separating space', () => {
    expect(normalizeTranscript('fix the login bug')).toBe('fix the login bug ');
    expect(normalizeTranscript('  fix the login bug  ')).toBe('fix the login bug ');
  });

  it('collapses internal whitespace and newlines', () => {
    expect(normalizeTranscript('run  the\n tests')).toBe('run the tests ');
  });

  it('returns empty string for blank input (nothing sent to the pty)', () => {
    expect(normalizeTranscript('')).toBe('');
    expect(normalizeTranscript('   \n ')).toBe('');
  });
});

describe('collectResults (recognition result batch)', () => {
  const final = (t) => ({ isFinal: true, 0: { transcript: t } });
  const partial = (t) => ({ isFinal: false, 0: { transcript: t } });

  it('separates normalized finals from concatenated interim text', () => {
    const { finals, interim } = collectResults([final(' fix  the bug '), partial('and then'), partial(' run tests')], 0);
    expect(finals).toEqual(['fix the bug ']);
    expect(interim).toBe('and then run tests');
  });

  it('respects the start index (already-processed results are skipped)', () => {
    const { finals, interim } = collectResults([final('old'), final('new')], 1);
    expect(finals).toEqual(['new ']);
    expect(interim).toBe('');
  });

  it('drops finals that normalize to nothing', () => {
    const { finals } = collectResults([final('   \n ')], 0);
    expect(finals).toEqual([]);
  });
});

describe('interimTail (indicator shows the words being spoken now)', () => {
  it('passes short interim text through unchanged', () => {
    expect(interimTail('hello world')).toBe('hello world');
  });

  it('keeps only the tail of long interim text, prefixed with an ellipsis', () => {
    const long = 'x'.repeat(100) + 'the end';
    const tail = interimTail(long);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.endsWith('the end')).toBe(true);
    expect(tail.length).toBe(81); // '…' + last 80 chars
  });
});

describe('recognitionErrorMessage (error code → user message)', () => {
  it('ignores normal-operation codes (silence timeout, own abort)', () => {
    expect(recognitionErrorMessage('no-speech')).toBeNull();
    expect(recognitionErrorMessage('aborted')).toBeNull();
  });

  it('maps permission and hardware failures to specific messages', () => {
    expect(recognitionErrorMessage('not-allowed')).toMatch(/access denied/);
    expect(recognitionErrorMessage('service-not-allowed')).toMatch(/access denied/);
    expect(recognitionErrorMessage('audio-capture')).toMatch(/No microphone/);
  });

  it('falls back to a generic message naming the code', () => {
    expect(recognitionErrorMessage('network')).toBe('Voice input error: network');
  });
});

describe('onEndAction (bounded-mic bookkeeping)', () => {
  it('restarts while the silence budget and session cap allow', () => {
    expect(onEndAction(1, 1000)).toBe('restart');
    expect(onEndAction(7, 1000)).toBe('restart');
  });

  it('pauses once the silence budget (8 restarts) is spent', () => {
    expect(onEndAction(8, 1000)).toBe('pause');
    expect(onEndAction(9, 1000)).toBe('pause');
  });

  it('expires past the 5-minute session cap', () => {
    expect(onEndAction(1, 5 * 60 * 1000 + 1)).toBe('expire');
    expect(onEndAction(1, 5 * 60 * 1000)).toBe('restart'); // boundary: cap is exclusive
  });

  it('spent silence budget wins over an expired session', () => {
    expect(onEndAction(8, 10 * 60 * 1000)).toBe('pause');
  });
});

describe('deliverToActivePty (voice → pty wiring)', () => {
  beforeEach(() => {
    agents.clear();
    setActiveSession(null);
    setSelf(null, false);
    send.mockClear();
    send.mockReturnValue(true);
  });

  it('sends the finalized transcript as pty-input to the active session', () => {
    agents.set('s1', { ownerId: null });
    setActiveSession('s1');
    expect(deliverToActivePty('fix the bug ')).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: 'pty-input', sessionId: 's1', data: 'fix the bug ' });
  });

  it('sends nothing when no session is active', () => {
    expect(deliverToActivePty('hello ')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing when the active session has no agent entry', () => {
    setActiveSession('gone');
    expect(deliverToActivePty('hello ')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing for a view-only agent (auth on, owned by someone else)', () => {
    setSelf('u_a', true);
    agents.set('s2', { ownerId: 'u_b' });
    setActiveSession('s2');
    expect(deliverToActivePty('rm -rf tmp ')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing to an ended (DISCONNECTED) session — mirrors the server exited-drop', () => {
    agents.set('s1', { ownerId: null, state: 'DISCONNECTED' });
    setActiveSession('s1');
    expect(deliverToActivePty('hello ')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports delivery failure when the socket is down', () => {
    agents.set('s1', { ownerId: null });
    setActiveSession('s1');
    send.mockReturnValue(false);
    expect(deliverToActivePty('hello ')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
