// Billion's workers come back after a restart: the startup pass re-spawns each
// orphan the restart made on one of Billion's In-progress cards, within the
// cap, and respawn_agent lets Billion bring back one by name.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { respawnBoardWorkers, respawnAgent } from '../server/ws.js';
import { addJob, deleteJob, allJobs, boardSettings } from '../server/jobs.js';
import { config, sessions, orphans } from '../server/state.js';
import { pendingMessages } from '../server/messages.js';
import { toolsFor } from '../server/mcp.js';
import { BILLION_NAME } from '../lib/jobs.js';

// A fake `codex` first on PATH (posix only, like server.test.js's), so the
// re-spawned session is a real PTY that resumes nothing.
const posix = process.platform !== 'win32';
let bin, savedPath, savedCodexHome, repoPath;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'a007-rbw-bin-'));
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'a007-rbw-codex-'));
  repoPath = mkdtempSync(join(tmpdir(), 'a007-rbw-repo-'));
  config.repos = [...config.repos, { path: repoPath }];
});
afterAll(() => {
  process.env.PATH = savedPath;
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
  rmSync(bin, { recursive: true, force: true });
});

const made = { jobs: [], dirs: [] };
afterEach(async () => {
  for (const [id, s] of sessions) {
    clearInterval(s.stateCheckInterval);
    clearTimeout(s.scanTimer);
    try { s.pty.kill(); } catch {}
    sessions.delete(id);
  }
  orphans.clear();
  config.activeSessions = [];
  for (const id of made.jobs.splice(0)) await deleteJob(id, () => {});
  for (const d of made.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  boardSettings().maxPerRepo = 2;
});

let n = 0;
// An orphan on `card` (or none), as recoverCrashedSessions leaves it.
function orphan({ card = null, reason = 'server-restart', worktree = true, ownerId = null } = {}) {
  const i = ++n;
  const worktreePath = mkdtempSync(join(tmpdir(), 'a007-rbw-wt-'));
  made.dirs.push(worktreePath);
  if (worktree) writeFileSync(join(worktreePath, '.git'), 'not a gitfile\n');
  else rmSync(worktreePath, { recursive: true, force: true });
  const branchName = card?.branchName || `b/rbw-${i}`;
  const o = {
    id: `orphan-rbw-${i}`, name: `Rbw${i}`, repoPath, repoSlug: 'rbw', worktreePath, branchName,
    color: '#fff', ownerId, agent: 'codex', permissionFlags: [], origin: card ? 'board' : 'user',
    jobId: card?.id || null, approvalsToBillion: !!card?.postedByBillion, reason, createdAt: new Date().toISOString(),
  };
  orphans.set(o.id, o);
  return o;
}
function card({ state = 'in-progress', billion = true } = {}) {
  const { job } = addJob({ title: `rbw card ${++n}`, repoPath, agent: 'codex', postedByBillion: billion }, () => {});
  made.jobs.push(job.id);
  Object.assign(job, { state, branchName: `b/rbw-card-${n}`, agentSessionId: null });
  return job;
}
const live = () => [...sessions.values()].filter(s => !s.exited).map(s => s.name);
const billion = { id: 'billion', name: BILLION_NAME, isBillion: true, ownerId: null };

describe.skipIf(!posix)('startup re-spawn', () => {
  it('brings back only the restart orphans on Billion\'s In-progress cards, as their board workers', async () => {
    const mine = card();
    const back = orphan({ card: mine });
    const inReview = orphan({ card: card({ state: 'review' }) });
    const hand = orphan();
    const owners = orphan({ card: card({ billion: false }) });
    const closed = orphan({ card: card(), reason: 'unpushed' });

    expect(await respawnBoardWorkers({ paceMs: 0 })).toEqual([back.name]);
    expect(live()).toEqual([back.name]);
    const session = [...sessions.values()][0];
    expect(session).toMatchObject({ spawnedBy: 'board', jobId: mine.id, worktreePath: back.worktreePath });
    expect(allJobs().find(j => j.id === mine.id).agentSessionId).toBe(session.id);
    expect(pendingMessages(session.id)).toBe(1);   // the one "continue your card" nudge
    expect([...orphans.keys()].sort()).toEqual([inReview.id, hand.id, owners.id, closed.id].sort());
  }, 15000);

  it('respects the per-repo cap and leaves the extras for the next pass', async () => {
    boardSettings().maxPerRepo = 1;
    orphan({ card: card() });
    orphan({ card: card() });
    expect(await respawnBoardWorkers({ paceMs: 0 })).toHaveLength(1);
    expect(orphans.size).toBe(1);
    // The next pass still finds the repo full.
    expect(await respawnBoardWorkers({ paceMs: 0 })).toEqual([]);
    expect(orphans.size).toBe(1);
  }, 15000);

  it('does nothing with RESPAWN_BOARD_WORKERS=0', async () => {
    orphan({ card: card() });
    expect(await respawnBoardWorkers({ paceMs: 0, env: { RESPAWN_BOARD_WORKERS: '0' } })).toEqual([]);
    expect(orphans.size).toBe(1);
    expect(live()).toEqual([]);
  });
});

describe.skipIf(!posix)('respawn_agent', () => {
  it('is Billion\'s tool only', async () => {
    expect(toolsFor(billion).map(t => t.name)).toContain('respawn_agent');
    expect(toolsFor({ id: 'w', name: 'Cobra' }).map(t => t.name)).not.toContain('respawn_agent');
    const o = orphan({ card: card() });
    expect((await respawnAgent({ id: 'w', name: 'Cobra' }, o.name)).error).toMatch(/Only Billion/);
  });

  it('refuses a missing orphan, a hand-started agent, someone else\'s card and a vanished worktree', async () => {
    expect((await respawnAgent(billion, 'Nobody')).error).toMatch(/No orphaned agent named "Nobody"/);
    const hand = orphan();
    expect((await respawnAgent(billion, hand.name)).error).toMatch(/not on a card you posted/);
    const owners = orphan({ card: card({ billion: false }) });
    expect((await respawnAgent(billion, owners.name)).error).toMatch(/not on a card you posted/);
    const gone = orphan({ card: card(), worktree: false });
    expect((await respawnAgent(billion, gone.name)).error).toMatch(/worktree is gone/);
    expect(orphans.has(gone.id)).toBe(true);   // reported, not dropped or rebuilt
    expect(live()).toEqual([]);
  });

  it('re-spawns one of Billion\'s orphans within the cap', async () => {
    boardSettings().maxPerRepo = 1;
    const a = orphan({ card: card() });
    const b = orphan({ card: card({ state: 'review' }) });
    const result = await respawnAgent(billion, a.name);
    expect(result.name).toBe(a.name);
    expect(live()).toEqual([a.name]);
    expect((await respawnAgent(billion, b.name)).error).toMatch(/cap/);
  }, 15000);
});
