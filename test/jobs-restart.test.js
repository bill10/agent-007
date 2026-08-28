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
    expect(job.agentName).toBeNull();
    expect(job.startedAt).toBe('2026-08-27T00:00:00Z');   // credit survives
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
