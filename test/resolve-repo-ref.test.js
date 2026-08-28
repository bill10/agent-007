// resolveRepoRef — the board's own form sends an exact path, but an agent
// calling post_job types whatever it knows. Every branch that produces an ERROR
// matters more than the happy path: the message is what the agent reads and
// acts on, and a wrong repo means a card the dispatcher skips for ever.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, basename } from 'path';

const { config } = await import('../server/state.js');
const { resolveRepoRef } = await import('../server/jobs.js');

const ROOT_A = mkdtempSync(join(tmpdir(), 'a007-refa-'));
const ROOT_B = mkdtempSync(join(tmpdir(), 'a007-refb-'));
// Two repos that share a basename, in different parents — the ambiguous case.
const TWIN_A = join(ROOT_A, 'app');
const TWIN_B = join(ROOT_B, 'app');
mkdirSync(TWIN_A, { recursive: true });
mkdirSync(TWIN_B, { recursive: true });
const SOLO = mkdtempSync(join(tmpdir(), 'a007-solo-'));

beforeEach(() => { config.repos = [{ path: SOLO }]; });

describe('what it accepts', () => {
  it('takes an exact path', () => {
    expect(resolveRepoRef(SOLO).path).toBe(SOLO);
  });

  it('takes a bare folder name, case-insensitively', () => {
    expect(resolveRepoRef(basename(SOLO)).path).toBe(SOLO);
    expect(resolveRepoRef(basename(SOLO).toUpperCase()).path).toBe(SOLO);
  });

  it('expands a ~/ path', () => {
    const under = join(homedir(), 'code', 'thing');
    config.repos = [{ path: under }];
    expect(resolveRepoRef('~/code/thing').path).toBe(under);
  });
});

describe('what it refuses, and what it says', () => {
  it('names the repos it knows when the reference misses', () => {
    // The agent gets one shot to correct itself; a bare "unknown repo" would
    // make it guess.
    const err = resolveRepoRef('/not/a/repo').error;
    expect(err).toMatch(/Unknown repository/);
    expect(err).toContain(basename(SOLO));
  });

  it('asks which repository when none is given and none can be defaulted', () => {
    const err = resolveRepoRef('').error;
    expect(err).toMatch(/Which repository/i);
    expect(err).toContain(basename(SOLO));
  });

  it('says so plainly when the board has no repos at all', () => {
    // Otherwise the message would be "unknown repository, known repositories: "
    // with an empty list, which reads like a bug.
    config.repos = [];
    expect(resolveRepoRef(SOLO).error).toMatch(/No repositories are configured/);
  });

  it('refuses an ambiguous folder name instead of picking one', () => {
    // Two repos can share a basename. Guessing would queue the job into the
    // wrong tree, and the agent would never know.
    config.repos = [{ path: TWIN_A }, { path: TWIN_B }];
    const err = resolveRepoRef('app').error;
    expect(err).toMatch(/matches more than one repository/);
    expect(err).toMatch(/pass the full path/);
  });

  it('disambiguates by parent folder, not by leaking the absolute path', () => {
    // Every other branch reports basenames only, and this reply goes out to
    // whatever called the tool.
    config.repos = [{ path: TWIN_A }, { path: TWIN_B }];
    const err = resolveRepoRef('app').error;
    expect(err).toContain(join(basename(ROOT_A), 'app'));
    expect(err).toContain(join(basename(ROOT_B), 'app'));
    expect(err).not.toContain(TWIN_A);
  });

  it('still takes the exact path when the basename is ambiguous', () => {
    config.repos = [{ path: TWIN_A }, { path: TWIN_B }];
    expect(resolveRepoRef(TWIN_B).path).toBe(TWIN_B);
  });

  it('treats a non-string reference as absent rather than stringifying it', () => {
    for (const ref of [null, undefined, 42, {}]) {
      expect(resolveRepoRef(ref).error).toBeTruthy();
    }
  });
});
