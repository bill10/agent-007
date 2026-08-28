import { describe, it, expect } from 'vitest';
import {
  createJob, countInFlightByRepo, selectDispatchableJobs, branchSlugFromTitle,
  buildJobPrompt, buildJobCommand, deriveJobStatus, parsePrList,
  JOB_STATES, MAX_TITLE_LEN, STALLED_AFTER_MS, DEFAULT_PERMISSION_MODE,
  MAX_BRANCH_SLUG_LEN, DISPATCH_INTERVAL_MS, PERMISSION_MODES, isValidPermissionMode,
} from '../lib/jobs.js';
import { parseCommand, detectState } from '../lib/helpers.js';

const REPO_A = '/repos/alpha';
const REPO_B = '/repos/beta';

function job(overrides = {}) {
  const { job: j } = createJob({ title: 'A job', repoPath: REPO_A, ...overrides });
  return { ...j, ...overrides };
}

// --- createJob ---

describe('createJob', () => {
  it('starts a job in todo with posting attribution', () => {
    const { job: j } = createJob({
      title: 'Add rate limiting', detail: 'Use a token bucket.',
      repoPath: REPO_A, postedBy: 'u_1', postedByName: 'Bill',
    });
    expect(j.state).toBe('todo');
    expect(j.title).toBe('Add rate limiting');
    expect(j.detail).toBe('Use a token bucket.');
    expect(j.repoPath).toBe(REPO_A);
    expect(j.postedBy).toBe('u_1');
    expect(j.postedByName).toBe('Bill');
    expect(Date.parse(j.postedAt)).not.toBeNaN();
    // Nothing is assigned until the dispatcher picks it up.
    expect(j.agentSessionId).toBeNull();
    expect(j.agentName).toBeNull();
    expect(j.startedAt).toBeNull();
  });

  it('rejects a job with no title or no repo', () => {
    expect(createJob({ title: '   ', repoPath: REPO_A }).error).toMatch(/title/i);
    expect(createJob({ title: 'x', repoPath: '' }).error).toMatch(/repos/i);
  });

  it('truncates an over-long title', () => {
    const { job: j } = createJob({ title: 'x'.repeat(500), repoPath: REPO_A });
    expect(j.title.length).toBe(MAX_TITLE_LEN);
  });

  it('gives each job a distinct id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createJob({ title: 't', repoPath: REPO_A }).job.id));
    expect(ids.size).toBe(50);
  });
});

// --- Cap accounting ---

describe('countInFlightByRepo', () => {
  it('counts only in-progress jobs, per repo', () => {
    const jobs = [
      { state: 'in-progress', repoPath: REPO_A, agentSessionId: 's1' },
      { state: 'in-progress', repoPath: REPO_A, agentSessionId: 's2' },
      { state: 'in-progress', repoPath: REPO_B, agentSessionId: 's3' },
      { state: 'todo', repoPath: REPO_A },
      { state: 'review', repoPath: REPO_A, agentSessionId: 's4' },
    ];
    const counts = countInFlightByRepo(jobs);
    expect(counts.get(REPO_A)).toBe(2);
    expect(counts.get(REPO_B)).toBe(1);
  });

  it('does not count a job whose agent has died', () => {
    // A crashed agent must not hold a slot forever, because cards are never
    // auto-reverted to To do. Without this the repo deadlocks.
    const jobs = [
      { state: 'in-progress', repoPath: REPO_A, agentSessionId: 'dead' },
      { state: 'in-progress', repoPath: REPO_A, agentSessionId: 'alive' },
    ];
    expect(countInFlightByRepo(jobs, new Set(['alive'])).get(REPO_A)).toBe(1);
  });
});

// --- Dispatch selection ---

describe('selectDispatchableJobs', () => {
  const mk = (state, repoPath, postedAt, extra = {}) => ({ state, repoPath, postedAt, ...extra });

  it('takes todo jobs oldest first', () => {
    const jobs = [
      mk('todo', REPO_A, '2026-01-03T00:00:00Z', { id: 'c' }),
      mk('todo', REPO_A, '2026-01-01T00:00:00Z', { id: 'a' }),
      mk('todo', REPO_A, '2026-01-02T00:00:00Z', { id: 'b' }),
    ];
    const picked = selectDispatchableJobs(jobs, { maxPerRepo: 3 });
    expect(picked.map(j => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('respects the per-repo cap, counting jobs it selects in this same pass', () => {
    const jobs = [
      mk('todo', REPO_A, '2026-01-01T00:00:00Z', { id: 'a1' }),
      mk('todo', REPO_A, '2026-01-02T00:00:00Z', { id: 'a2' }),
      mk('todo', REPO_A, '2026-01-03T00:00:00Z', { id: 'a3' }),
    ];
    expect(selectDispatchableJobs(jobs, { maxPerRepo: 2 }).map(j => j.id)).toEqual(['a1', 'a2']);
  });

  it('counts already-running jobs against the cap', () => {
    const jobs = [
      mk('in-progress', REPO_A, '2026-01-01T00:00:00Z', { agentSessionId: 's1' }),
      mk('todo', REPO_A, '2026-01-02T00:00:00Z', { id: 'a2' }),
      mk('todo', REPO_A, '2026-01-03T00:00:00Z', { id: 'a3' }),
    ];
    expect(selectDispatchableJobs(jobs, { maxPerRepo: 2, liveSessionIds: new Set(['s1']) }).map(j => j.id))
      .toEqual(['a2']);
  });

  it('caps each repo independently', () => {
    const jobs = [
      mk('todo', REPO_A, '2026-01-01T00:00:00Z', { id: 'a1' }),
      mk('todo', REPO_B, '2026-01-02T00:00:00Z', { id: 'b1' }),
      mk('todo', REPO_A, '2026-01-03T00:00:00Z', { id: 'a2' }),
    ];
    expect(selectDispatchableJobs(jobs, { maxPerRepo: 1 }).map(j => j.id)).toEqual(['a1', 'b1']);
  });

  it('leaves a job queued when its repo is unavailable', () => {
    const jobs = [
      mk('todo', REPO_A, '2026-01-01T00:00:00Z', { id: 'a1' }),
      mk('todo', REPO_B, '2026-01-02T00:00:00Z', { id: 'b1' }),
    ];
    const picked = selectDispatchableJobs(jobs, { maxPerRepo: 5, availableRepos: new Set([REPO_B]) });
    expect(picked.map(j => j.id)).toEqual(['b1']);
  });

  it('never selects a job that is not in todo', () => {
    const jobs = [
      mk('in-progress', REPO_A, '2026-01-01T00:00:00Z', { agentSessionId: 's1' }),
      mk('review', REPO_A, '2026-01-02T00:00:00Z'),
    ];
    expect(selectDispatchableJobs(jobs, { maxPerRepo: 5 })).toEqual([]);
  });

});

// --- Prompt delivery ---

describe('buildJobCommand', () => {
  it('round-trips the prompt through parseCommand as a single argv', () => {
    const j = job({ title: 'Fix "quoted" bug', detail: 'Windows path C:\\temp\nand $HOME' });
    const parsed = parseCommand(buildJobCommand(j));
    expect(parsed.file).toBe('claude');
    expect(parsed.args[0]).toBe('--permission-mode');
    expect(parsed.args[1]).toBe(DEFAULT_PERMISSION_MODE);
    // The whole prompt is ONE argument: it can never be re-split into flags,
    // and no shell sees it, so $HOME is not expanded.
    expect(parsed.args).toHaveLength(3);
    expect(parsed.args[2]).toBe(buildJobPrompt(j));
    expect(parsed.args[2]).toContain('Fix "quoted" bug');
    expect(parsed.args[2]).toContain('C:\\temp');
    expect(parsed.args[2]).toContain('$HOME');
  });

  it('honours an overridden permission mode', () => {
    const parsed = parseCommand(buildJobCommand(job(), { permissionMode: 'bypassPermissions' }));
    expect(parsed.args[1]).toBe('bypassPermissions');
  });

  it('includes the title, the detail, and the ship instruction', () => {
    const prompt = buildJobPrompt(job({ title: 'T', detail: 'D' }));
    expect(prompt.startsWith('T')).toBe(true);
    expect(prompt).toContain('D');
    expect(prompt).toContain('/ship');
  });

  it('handles a job with no detail', () => {
    const prompt = buildJobPrompt(job({ title: 'Only a title', detail: '' }));
    expect(prompt).toContain('Only a title');
    expect(prompt).toContain('/ship');
  });
});

// --- Live status ---

describe('deriveJobStatus', () => {
  const now = 1_000_000_000;
  const inProgress = { state: 'in-progress' };

  it('is null for jobs that are not in progress', () => {
    expect(deriveJobStatus({ state: 'todo' }, null)).toBeNull();
    expect(deriveJobStatus({ state: 'review' }, { state: 'WAITING' })).toBeNull();
  });

  it('reports a missing or exited agent as gone', () => {
    expect(deriveJobStatus(inProgress, null)).toBe('gone');
    expect(deriveJobStatus(inProgress, { state: 'WAITING', exited: true })).toBe('gone');
  });

  it('reports MESSAGE as needs-input', () => {
    expect(deriveJobStatus(inProgress, { state: 'MESSAGE', lastOutputAt: now }, { now })).toBe('needs-input');
  });

  it('reports a busy agent as running', () => {
    expect(deriveJobStatus(inProgress, { state: 'WORKING', lastOutputAt: now }, { now })).toBe('running');
  });

  it('only calls a WAITING agent stalled once it has been quiet past the window', () => {
    const fresh = { state: 'WAITING', lastOutputAt: now - 1000 };
    expect(deriveJobStatus(inProgress, fresh, { now })).toBe('running');
    const quiet = { state: 'WAITING', lastOutputAt: now - STALLED_AFTER_MS - 1 };
    expect(deriveJobStatus(inProgress, quiet, { now })).toBe('stalled');
  });

  it('treats MESSAGE as needs-input regardless of how long it has been quiet', () => {
    const old = { state: 'MESSAGE', lastOutputAt: now - 10 * STALLED_AFTER_MS };
    expect(deriveJobStatus(inProgress, old, { now })).toBe('needs-input');
  });
});

// --- PR detection ---

describe('parsePrList', () => {
  it('returns the open PR', () => {
    const out = JSON.stringify([{ number: 42, url: 'https://github.com/o/r/pull/42', state: 'OPEN', isDraft: false }]);
    expect(parsePrList(out)).toEqual({ url: 'https://github.com/o/r/pull/42', number: 42, isDraft: false });
  });

  it('counts a draft PR as open', () => {
    const out = JSON.stringify([{ number: 7, url: 'u', state: 'OPEN', isDraft: true }]);
    expect(parsePrList(out).isDraft).toBe(true);
  });

  it('ignores closed and merged PRs', () => {
    const out = JSON.stringify([
      { number: 1, url: 'a', state: 'CLOSED' },
      { number: 2, url: 'b', state: 'MERGED' },
    ]);
    expect(parsePrList(out)).toBeNull();
  });

  it('returns null for no PRs, malformed JSON, or a non-array', () => {
    expect(parsePrList('[]')).toBeNull();
    expect(parsePrList('not json')).toBeNull();
    expect(parsePrList('{"a":1}')).toBeNull();
    expect(parsePrList('')).toBeNull();
  });
});

describe('JOB_STATES', () => {
  it('is exactly the three board columns, in order', () => {
    expect(JOB_STATES).toEqual(['todo', 'in-progress', 'review']);
  });
});

// --- Workspace-trust dialog detection ---
//
// These lines are copied verbatim from a real PTY capture of `claude` starting
// in a fresh git worktree, after stripAnsiComplete. The TUI positions words
// with cursor moves, so they arrive with no spaces between them — which is why
// the patterns use \\s* rather than literal spaces.
describe('workspace-trust dialog is detected as needing the user', () => {
  const CAPTURED = [
    'Securityguide',
    '\u276fNo,exit',
    'Yes,Itrustthisfolder',
    'Entertoconfirm\u00b7Esctocancel',
    '0q',
  ];

  const session = (over = {}) => ({
    exited: false, isTUI: true,
    lastOutputAt: Date.now() - 30_000,   // long past the WORKING window
    lastStrippedLine: '0q',
    recentStrippedLines: CAPTURED,
    ...over,
  });

  it('reports MESSAGE, not WAITING, for the trust dialog', () => {
    // Every board agent starts in a brand-new worktree and meets this dialog,
    // so without detection every dispatched job would look like it was working.
    expect(detectState(session())).toBe('MESSAGE');
  });

  it('feeds through to the job board as needs-input', () => {
    const s = session({ state: 'MESSAGE' });
    expect(deriveJobStatus({ state: 'in-progress' }, s)).toBe('needs-input');
  });

  it('still reports WAITING for an agent merely parked at its prompt', () => {
    expect(detectState(session({
      lastStrippedLine: '',
      recentStrippedLines: ['Doneandcommitted.', 'Anythingelse?'],
    }))).toBe('WAITING');
  });

  it('matches the generic confirm footer even with normal spacing', () => {
    expect(detectState(session({
      lastStrippedLine: 'Enter to confirm \u00b7 Esc to cancel',
      recentStrippedLines: ['Enter to confirm \u00b7 Esc to cancel'],
    }))).toBe('MESSAGE');
  });
});

// --- Branch naming ---

describe('branchSlugFromTitle', () => {
  it('reads like the job title', () => {
    expect(branchSlugFromTitle('Add rate limiting')).toBe('add-rate-limiting');
    expect(branchSlugFromTitle('UPPER Case-Thing')).toBe('upper-case-thing');
  });

  it('strips punctuation that git refs forbid', () => {
    // ~ ^ : ? * [ .. and a leading dash are all illegal in a ref name; keeping
    // to [a-z0-9-] side-steps the whole rule set rather than enumerating it.
    for (const title of ['Fix ~weird^ name:?', 'a..b', '--leading', 'trailing--', 'x[0]*y']) {
      const slug = branchSlugFromTitle(title);
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('bounds the length and never ends in a dash', () => {
    const slug = branchSlugFromTitle('word '.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(MAX_BRANCH_SLUG_LEN);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back rather than producing an empty ref', () => {
    // A title of pure punctuation or non-Latin script would otherwise slug to
    // '' and make `git worktree add -b <gituser>/` fail.
    expect(branchSlugFromTitle('———')).toBe('job');
    expect(branchSlugFromTitle('')).toBe('job');
    expect(branchSlugFromTitle('   ')).toBe('job');
    expect(branchSlugFromTitle(null)).toBe('job');
  });
});

// --- Dispatch defaults ---

describe('dispatch defaults', () => {
  it('scans every 5 minutes', () => {
    expect(DISPATCH_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('runs agents in auto mode', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('auto');
  });

  it('sends the agent to /ship when the work is finished', () => {
    const prompt = buildJobPrompt({ title: 'T', detail: 'D' });
    expect(prompt).toMatch(/when the work is finished, run \/ship/i);
  });

  it('forecloses running anything ahead of /ship', () => {
    // /ship already merges the base branch, tests, reviews and fix-loops. A
    // pass run before it repeats that work on a tree that is about to change.
    const prompt = buildJobPrompt({ title: 'T' });
    expect(prompt).toMatch(/nothing else needs running first/i);
  });

  it('names no skill but /ship', () => {
    // A dispatched agent arrives with no memory of the other skills. Naming
    // one — even to forbid it — is what puts it on the table, so the prompt
    // mentions /ship and nothing else.
    const prompt = buildJobPrompt({ title: 'T' });
    const skills = prompt.match(/\/[a-z][a-z-]*/g) || [];
    expect([...new Set(skills)]).toEqual(['/ship']);
  });

  it('forbids ending the turn before the PR exists', () => {
    // An agent finished its task and /review, then ended its turn with "Next is
    // /ship" — treating the sequence as a plan to report on rather than one to
    // finish. Nobody was there to say "continue", so the job stalled at a
    // prompt with all its work uncommitted. The instruction has to close that
    // stopping point off explicitly.
    const prompt = buildJobPrompt({ title: 'T' });
    expect(prompt).toMatch(/do not end your turn until \/ship/i);
    // And it must name the specific failure, not just assert the rule.
    expect(prompt).toMatch(/describe what you would do next/i);
  });

  it('still allows stopping for a real question or a hard failure', () => {
    // The rule must not read as "never stop", or an agent that genuinely needs
    // the user will thrash instead of asking.
    const prompt = buildJobPrompt({ title: 'T' });
    expect(prompt).toMatch(/question you genuinely cannot answer|failure you cannot get past/i);
  });
});

// --- Permission mode is argv, so it must be an allowlist ---

describe('permission mode validation', () => {
  it('accepts every mode claude actually supports', () => {
    for (const mode of PERMISSION_MODES) expect(isValidPermissionMode(mode)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['', null, undefined, 'AUTO', 'yolo', 42, {}]) {
      expect(isValidPermissionMode(bad)).toBe(false);
    }
  });

  it('cannot be used to smuggle extra flags onto the agent', () => {
    // buildJobCommand interpolates this into a command string that parseCommand
    // splits into argv. Unvalidated, "auto --dangerously-skip-permissions"
    // becomes a second flag on every dispatched agent.
    const cmd = buildJobCommand(job(), { permissionMode: 'auto --dangerously-skip-permissions' });
    const parsed = parseCommand(cmd);
    expect(parsed.args[1]).toBe(DEFAULT_PERMISSION_MODE);
    expect(parsed.args).toHaveLength(3);
    expect(cmd).not.toContain('dangerously');
  });

  it('falls back to the default rather than emitting an empty flag', () => {
    const parsed = parseCommand(buildJobCommand(job(), { permissionMode: '' }));
    expect(parsed.args[1]).toBe(DEFAULT_PERMISSION_MODE);
  });
});
