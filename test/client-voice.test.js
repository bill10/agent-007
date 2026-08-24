import { describe, it, expect } from 'vitest';
import { normalizeTranscript } from '../public/modules/voice.js';

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
