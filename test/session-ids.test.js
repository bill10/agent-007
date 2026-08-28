import { describe, it, expect } from 'vitest';
import { nextSessionId } from '../server/state.js';

describe('session ids', () => {
  it('are unique within a run', () => {
    const ids = new Set(Array.from({ length: 200 }, () => nextSessionId()));
    expect(ids.size).toBe(200);
  });

  it('carry a per-process prefix, so they cannot repeat across restarts', () => {
    // The counter alone restarts at zero while job records outlive the process,
    // so a job holding `session-5` would resolve to whatever `session-5` is in
    // the NEXT generation — an unrelated agent on a different branch.
    const id = nextSessionId();
    expect(id).toMatch(/^session-[a-z0-9]+-\d+$/);
    // The prefix is the part that differs between runs; the bare counter form
    // must no longer be produced.
    expect(id).not.toMatch(/^session-\d+$/);
  });
});
