// buildJobPrompt's follow-up-job instruction. Every dispatched agent gets this
// prompt (see server/jobs.js dispatchOnce -> buildJobCommand -> buildJobPrompt),
// so a typo or dropped line here silently changes what every job agent is told
// it can do — with nothing at the HTTP or CLI layer to catch it.

import { describe, it, expect } from 'vitest';
import { createJob, buildJobPrompt } from '../lib/jobs.js';

const REPO_A = '/repos/alpha';

function job(overrides = {}) {
  const { job: j } = createJob({ title: 'A job', repoPath: REPO_A, ...overrides });
  return { ...j, ...overrides };
}

describe('buildJobPrompt: agent-007-job follow-up instruction', () => {
  it('tells the dispatched agent how to queue an out-of-scope finding', () => {
    const prompt = buildJobPrompt(job({ title: 'Fix the flaky test', detail: 'D' }));
    // This is the whole point of the CLI existing: without this line in the
    // prompt, a dispatched agent has no way to learn the command exists.
    expect(prompt).toContain('agent-007-job');
    expect(prompt).toMatch(/queue it instead/i);
    // Comes after the /ship instructions, not instead of them.
    expect(prompt.indexOf('/ship')).toBeLessThan(prompt.indexOf('agent-007-job'));
  });
});
