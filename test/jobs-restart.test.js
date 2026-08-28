import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../server/config.js';
import { config } from '../server/state.js';
import { CONFIG_PATH, CONFIG_DIR } from '../server/state.js';

// loadConfig reads CONFIG_PATH, which test/setup.js has already redirected to a
// throwaway directory via AGENT007_CONFIG_DIR.
function writeConfig(jobs) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({
    version: 1, repos: [], orphans: [], activeSessions: [], jobs,
  }));
}

afterEach(() => {
  try { rmSync(CONFIG_PATH); } catch {}
});

describe('restart recovery for in-flight jobs', () => {
  it('keeps a job that already has a branch in in-progress', () => {
    // The agent may have pushed and opened the PR before the server died.
    // Sending it back to To do would dispatch a second agent onto a `-2`
    // branch to redo work that is already up for review, and open a duplicate
    // PR. checkPullRequests can still resolve it from the branch alone.
    writeConfig([{
      id: 'j1', title: 'shipped it', repoPath: '/r', state: 'in-progress',
      agentSessionId: 'session-9', agentName: 'Viper',
      branchName: 'bill/add-thing', startedAt: '2026-08-27T00:00:00Z',
    }]);
    loadConfig();
    const job = config.jobs[0];
    expect(job.state).toBe('in-progress');
    expect(job.branchName).toBe('bill/add-thing');
    // The dead session link must go, or the cap would count a PTY that is gone.
    expect(job.agentSessionId).toBeNull();
    // The NAME is history — "Viper did this work" stays true across a restart,
    // and it is the credit the card exists to show. Only the session link,
    // which cannot survive the process, is dropped.
    expect(job.agentName).toBe('Viper');
    expect(job.startedAt).toBe('2026-08-27T00:00:00Z');
    expect(job.lastError).toMatch(/bill\/add-thing/);
  });

  it('requeues a job that never got as far as a branch', () => {
    writeConfig([{
      id: 'j2', title: 'never started', repoPath: '/r', state: 'in-progress',
      agentSessionId: 'session-1', agentName: 'Apex', branchName: null,
      startedAt: '2026-08-27T00:00:00Z',
    }]);
    loadConfig();
    const job = config.jobs[0];
    expect(job.state).toBe('todo');
    expect(job.agentSessionId).toBeNull();
    expect(job.startedAt).toBeNull();
  });

  it('leaves todo and review jobs alone', () => {
    writeConfig([
      { id: 'a', title: 'queued', repoPath: '/r', state: 'todo' },
      { id: 'b', title: 'done', repoPath: '/r', state: 'review', prNumber: 3, branchName: 'bill/x' },
    ]);
    loadConfig();
    expect(config.jobs.map(j => j.state)).toEqual(['todo', 'review']);
    expect(config.jobs[1].prNumber).toBe(3);
  });

  it('survives a config with no jobs key at all', () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ version: 1, repos: [] }));
    loadConfig();
    expect(config.jobs).toEqual([]);
  });
});

describe('stale agent links after a restart', () => {
  it('clears the session link on a review job too, not just in-flight ones', () => {
    // Session ids are only unique within a process generation, so a link kept
    // on a finished card could resolve to an unrelated agent after a restart.
    writeConfig([{
      id: 'r1', title: 'shipped', repoPath: '/r', state: 'review',
      agentSessionId: 'session-5', agentName: 'Shadow',
      branchName: 'bill/x', prNumber: 20,
    }]);
    loadConfig();
    const job = config.jobs[0];
    expect(job.agentSessionId).toBeNull();
    expect(job.agentName).toBe('Shadow');   // credit kept
    expect(job.state).toBe('review');
    expect(job.prNumber).toBe(20);
  });

  it('clears it on a todo job as well', () => {
    writeConfig([{ id: 't1', title: 'queued', repoPath: '/r', state: 'todo', agentSessionId: 'session-2' }]);
    loadConfig();
    expect(config.jobs[0].agentSessionId).toBeNull();
  });
});
