// The permission mode a board agent is spawned with, end to end: the constant
// in lib/jobs.js, the per-card override, the stored board setting it falls
// back to, and the argv dispatchOnce builds from the pair.
//
// The default is `auto` because its classifier is the only thing that reviews
// a dispatched agent's actions before they run, and a board agent's prompt is
// a card's detail text plus whatever it reads out of the repo. Where auto mode
// is unavailable -- an unsupported model on Bedrock/Vertex, or
// permissions.disableAutoMode -- Claude Code starts the session in Manual
// instead of failing, and the job stalls visibly on `needs-input`; the answer
// to that is the board setting below, not a less safe default.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import {
  dispatchOnce, addJob, updateJob, updateSettings, boardSettings, allJobs,
  postJobForAgent, editJobForAgent,
} from '../server/jobs.js';
import { parseCommand } from '../lib/helpers.js';
import { buildJobCommand, createJob, resolveJobPermissionMode, dispatchPermissionMode, DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from '../lib/jobs.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-jobperm-'));
const noopBroadcast = () => {};

function resetBoard() {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
}

// Valid modes that are NOT the default, so an assertion on one fails if the
// value is dropped on the floor. A previous test asserted the mode that had
// just become the default and quietly turned into a tautology.
const OTHER_MODE = 'plan';
const THIRD_MODE = 'acceptEdits';

function fakeCreateSession(calls) {
  return async (command, name, repoPath, branch, ownerId, meta) => {
    calls.push({ command });
    const session = {
      id: `session-${calls.length}`, name: 'Agent1', command, repoPath,
      state: 'WORKING', exited: false, lastOutputAt: Date.now(),
      spawnedBy: meta?.spawnedBy, jobId: meta?.jobId,
    };
    sessions.set(session.id, session);
    return { session };
  };
}

describe('the default', () => {
  it('is auto, and auto is in the allowlist', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('auto');
    expect(PERMISSION_MODES).toContain(DEFAULT_PERMISSION_MODE);
  });
});

describe('resolveJobPermissionMode', () => {
  it('reads nothing as unset rather than as the default', () => {
    // The distinction is load-bearing: a card that stores null follows the
    // board setting at dispatch, and a card that stored a copy of the board
    // value would stop following it the moment the board changed.
    for (const empty of [undefined, null, '']) {
      expect(resolveJobPermissionMode(empty)).toEqual({ permissionMode: null });
    }
  });

  it('refuses a mode outside the allowlist instead of falling back', () => {
    expect(resolveJobPermissionMode('yolo').error).toMatch(/Unknown permission mode/);
    // Interpolated into argv, so a second token must be refused outright and
    // never reach buildJobCommand as extra flags.
    expect(resolveJobPermissionMode('auto --dangerously-skip-permissions').error).toBeTruthy();
    expect(resolveJobPermissionMode('yolo').permissionMode).toBeUndefined();
  });
});

describe('buildJobCommand permission mode', () => {
  it('honours a valid board mode that differs from the default', () => {
    expect(OTHER_MODE).not.toBe(DEFAULT_PERMISSION_MODE);
    const parsed = parseCommand(buildJobCommand({ title: 'x' }, { permissionMode: OTHER_MODE }));
    expect(parsed.args[0]).toBe('--permission-mode');
    expect(parsed.args[1]).toBe(OTHER_MODE);
  });

  it('lets the card override the board setting', () => {
    const cmd = buildJobCommand({ title: 'x', permissionMode: THIRD_MODE }, { permissionMode: OTHER_MODE });
    expect(parseCommand(cmd).args[1]).toBe(THIRD_MODE);
  });

  it('inherits the board setting when the card names no mode', () => {
    for (const unset of [null, undefined]) {
      const cmd = buildJobCommand({ title: 'x', permissionMode: unset }, { permissionMode: OTHER_MODE });
      expect(parseCommand(cmd).args[1]).toBe(OTHER_MODE);
    }
  });

  it('falls back to the BOARD setting when a stored card mode is invalid', () => {
    // createJob and updateJob both refuse an unrecognised mode before it ever
    // reaches a job record, but buildJobCommand is the last door before argv --
    // the comment above it says so -- so a card holding a bad value some other
    // way (hand-edited config, a mode dropped from the allowlist by a later
    // release) must still come out safe.
    //
    // Safe means the BOARD's mode, not the built-in default: skipping past the
    // board level would defeat a board deliberately set strict, which is the
    // safety net this case should land in. Only when the board setting is
    // unusable too does the default apply -- both halves are asserted, and the
    // board mode here is not the default, so the distinction can fail.
    const bad = 'auto --dangerously-skip-permissions';
    expect(OTHER_MODE).not.toBe(DEFAULT_PERMISSION_MODE);
    const cmd = buildJobCommand({ title: 'x', permissionMode: bad }, { permissionMode: OTHER_MODE });
    const parsed = parseCommand(cmd);
    expect(parsed.args[1]).toBe(OTHER_MODE);
    expect(parsed.args).toHaveLength(3);
    expect(cmd).not.toContain('dangerously');

    // Neither level usable -- now, and only now, the default.
    const both = buildJobCommand({ title: 'x', permissionMode: bad }, { permissionMode: 'yolo' });
    expect(parseCommand(both).args[1]).toBe(DEFAULT_PERMISSION_MODE);
    expect(parseCommand(both).args).toHaveLength(3);
  });

  it('resolves the same answer buildJobCommand puts in the argv', () => {
    // dispatchOnce asks dispatchPermissionMode directly to check nothing
    // retuned the card while its agent spawned, so the two must not drift.
    for (const [job, board] of [
      [{ permissionMode: THIRD_MODE }, OTHER_MODE],
      [{ permissionMode: null }, OTHER_MODE],
      [{ permissionMode: 'yolo' }, OTHER_MODE],
      [{ permissionMode: 'yolo' }, 'yolo'],
    ]) {
      expect(parseCommand(buildJobCommand({ title: 'x', ...job }, { permissionMode: board })).args[1])
        .toBe(dispatchPermissionMode(job, board));
    }
  });
});

describe('a card carrying its own mode', () => {
  beforeEach(resetBoard);

  it('is created unset by default', () => {
    expect(createJob({ title: 'x', repoPath: REPO }).job.permissionMode).toBeNull();
  });

  it('stores a valid mode and refuses an invalid one at creation', () => {
    expect(createJob({ title: 'x', repoPath: REPO, permissionMode: OTHER_MODE }).job.permissionMode).toBe(OTHER_MODE);
    const bad = createJob({ title: 'x', repoPath: REPO, permissionMode: 'auto --dangerously-skip-permissions' });
    expect(bad.error).toMatch(/Unknown permission mode/);
    expect(bad.job).toBeUndefined();
  });

  it('can be set, changed and cleared back to inheriting while in To do', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO, permissionMode: OTHER_MODE }, noopBroadcast);
    expect(updateJob(job.id, { permissionMode: THIRD_MODE }, noopBroadcast).job.permissionMode).toBe(THIRD_MODE);
    // '' is the form's "Board default" option, and it has to reach null.
    expect(updateJob(job.id, { permissionMode: '' }, noopBroadcast).job.permissionMode).toBeNull();
  });

  it('keeps the stored mode when an edit is refused', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO, permissionMode: OTHER_MODE }, noopBroadcast);
    expect(updateJob(job.id, { permissionMode: 'yolo' }, noopBroadcast).error).toMatch(/Unknown permission mode/);
    expect(allJobs()[0].permissionMode).toBe(OTHER_MODE);
  });

  it('is what dispatchOnce spawns that job with, over the board setting', async () => {
    updateSettings({ permissionMode: OTHER_MODE }, noopBroadcast);
    addJob({ title: 'own mode', repoPath: REPO, permissionMode: THIRD_MODE }, noopBroadcast);
    addJob({ title: 'inherits', repoPath: REPO }, noopBroadcast);
    const calls = [];
    await dispatchOnce(fakeCreateSession(calls), noopBroadcast);
    expect(calls[0].command).toContain(`--permission-mode ${THIRD_MODE}`);
    expect(calls[1].command).toContain(`--permission-mode ${OTHER_MODE}`);
  });
});

describe('the stored board permission mode', () => {
  beforeEach(resetBoard);

  it('resets a stored mode nobody ever chose, including one from a newer default', () => {
    // This assertion is the reverse of the one this file used to carry ("keeps
    // a mode an older config already stored"). That behaviour was the bug:
    // boardSettings() spreads the stored object OVER the defaults and persists
    // the result, so the first dispatcher start wrote the then-current default
    // into config.json for ever. Nobody had a control to choose a mode with
    // until this version, so every value stored up to now is a default rather
    // than a decision -- and without this reset, a board whose first run was on
    // v0.3.33.0 would keep dispatching with bypassPermissions unasked.
    config.jobBoard = { permissionMode: 'bypassPermissions' };
    expect(boardSettings().permissionMode).toBe(DEFAULT_PERMISSION_MODE);
    config.jobBoard = { permissionMode: 'acceptEdits' };
    expect(boardSettings().permissionMode).toBe(DEFAULT_PERMISSION_MODE);
    // ...and the rest of the settings still fill in from the defaults.
    expect(boardSettings().running).toBe(false);
  });

  it('keeps a mode a human actually picked', () => {
    config.jobBoard = { permissionMode: OTHER_MODE, permissionModeChosen: true };
    expect(boardSettings().permissionMode).toBe(OTHER_MODE);
  });

  it('falls back when a chosen mode was hand-edited into nonsense', () => {
    config.jobBoard = { permissionMode: 'yolo', permissionModeChosen: true };
    expect(boardSettings().permissionMode).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('takes a valid mode off the wire, records the choice, and refuses anything else', () => {
    expect(updateSettings({ permissionMode: OTHER_MODE }, noopBroadcast).settings.permissionMode).toBe(OTHER_MODE);
    expect(boardSettings().permissionModeChosen).toBe(true);
    // Interpolated into argv, so a rejected value must leave the old one alone
    // rather than fall through to the default or land as extra flags.
    expect(updateSettings({ permissionMode: 'auto --dangerously-skip-permissions' }, noopBroadcast).settings.permissionMode).toBe(OTHER_MODE);
    expect(updateSettings({ permissionMode: 'yolo' }, noopBroadcast).settings.permissionMode).toBe(OTHER_MODE);
    expect(updateSettings({ maxPerRepo: 1 }, noopBroadcast).settings.permissionMode).toBe(OTHER_MODE);
  });

  it('is what dispatchOnce spawns an inheriting card with', async () => {
    updateSettings({ permissionMode: OTHER_MODE }, noopBroadcast);
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    const calls = [];
    await dispatchOnce(fakeCreateSession(calls), noopBroadcast);
    expect(calls[0].command).toContain(`--permission-mode ${OTHER_MODE}`);
    expect(calls[0].command).not.toContain(DEFAULT_PERMISSION_MODE);
  });
});

describe('the controls in public/index.html', () => {
  // public/ cannot import lib/jobs.js, so the option lists are a copy. A mode
  // added to the allowlist and not to the markup would be unreachable from the
  // app, which is the gap this whole change exists to close.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  function optionsOf(selectId) {
    const block = html.slice(html.indexOf(`id="${selectId}"`));
    return [...block.slice(0, block.indexOf('</select>')).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  }

  it('offers every allowlisted mode on the board setting', () => {
    expect(optionsOf('job-permission-mode').sort()).toEqual([...PERMISSION_MODES].sort());
  });

  it('still has the mode the client singles out as dangerous', () => {
    // public/modules/jobs.js hard-codes DANGEROUS_MODE = 'bypassPermissions'
    // to colour it apart from the five benign options. Renaming or dropping it
    // from the allowlist without touching that copy would silently leave the
    // warning attached to a mode nobody can pick.
    expect(PERMISSION_MODES).toContain('bypassPermissions');
    const client = readFileSync(new URL('../public/modules/jobs.js', import.meta.url), 'utf8');
    expect(client).toContain("DANGEROUS_MODE = 'bypassPermissions'");
  });

  it('offers the same modes on a card, plus an empty "board default"', () => {
    const opts = optionsOf('job-permission-mode-field');
    expect(opts[0]).toBe('');
    expect(opts.slice(1).sort()).toEqual([...PERMISSION_MODES].sort());
  });
});

describe('a mode retuned while the agent is spawning', () => {
  beforeEach(resetBoard);

  // createSession takes seconds (a worktree plus a PTY), and the card stays in
  // To do for all of it -- editableInPlace gates on state, and the state only
  // flips once the session comes back. So a WS job-update lands happily in the
  // middle of a dispatch. The argv was fixed before that await, so without a
  // recheck the agent would run under a mode the card no longer says, while
  // the board showed the new one: the store and the live process disagreeing
  // about the one field that decides what the agent may do.
  //
  // The remedy is the one every other mid-dispatch change already gets --
  // abandon the spawn, leave the card in To do, let the next tick re-dispatch
  // it with the mode that now applies.
  function racingCreateSession(calls, mutate) {
    return async (command, name, repoPath, branch, ownerId, meta) => {
      calls.push({ command });
      const session = {
        id: `session-${calls.length}`, name: 'Agent1', command, repoPath,
        state: 'WORKING', exited: false, lastOutputAt: Date.now(),
        spawnedBy: meta?.spawnedBy, jobId: meta?.jobId,
      };
      sessions.set(session.id, session);
      mutate();                       // stands in for the WS handler
      return { session };
    };
  }

  it('does not claim a card whose own mode changed mid-spawn, and kills the agent', async () => {
    const { job } = addJob({ title: 'retuned', repoPath: REPO, permissionMode: 'bypassPermissions' }, noopBroadcast);
    const calls = [];
    const killed = [];
    await dispatchOnce(
      racingCreateSession(calls, () => updateJob(job.id, { permissionMode: OTHER_MODE }, noopBroadcast)),
      noopBroadcast,
      { killSession: async (id) => { killed.push(id); } },
    );
    // It really did spawn with the pre-edit mode -- that is the hazard.
    expect(calls[0].command).toContain('--permission-mode bypassPermissions');
    // ...so the card is not claimed and the agent does not survive.
    expect(killed).toEqual(['session-1']);
    expect(allJobs()[0].state).toBe('todo');
    expect(allJobs()[0].agentSessionId).toBeNull();
    expect(allJobs()[0].permissionMode).toBe(OTHER_MODE);
  });

  it('does the same when the BOARD is retuned mid-spawn', async () => {
    updateSettings({ permissionMode: 'bypassPermissions' }, noopBroadcast);
    addJob({ title: 'inherits', repoPath: REPO }, noopBroadcast);
    const calls = [];
    const killed = [];
    await dispatchOnce(
      racingCreateSession(calls, () => updateSettings({ permissionMode: OTHER_MODE }, noopBroadcast)),
      noopBroadcast,
      { killSession: async (id) => { killed.push(id); } },
    );
    expect(calls[0].command).toContain('--permission-mode bypassPermissions');
    expect(killed).toEqual(['session-1']);
    expect(allJobs()[0].state).toBe('todo');
  });

  it('claims the card normally when nothing changed', async () => {
    addJob({ title: 'quiet', repoPath: REPO, permissionMode: OTHER_MODE }, noopBroadcast);
    const calls = [];
    const killed = [];
    await dispatchOnce(racingCreateSession(calls, () => {}), noopBroadcast, {
      killSession: async (id) => { killed.push(id); },
    });
    expect(killed).toEqual([]);
    expect(allJobs()[0].state).toBe('in-progress');
    expect(allJobs()[0].agentSessionId).toBe('session-1');
  });
});

describe('an agent cannot pick its own permission mode through the MCP door', () => {
  beforeEach(resetBoard);

  // postJobForAgent and editJobForAgent are the two functions an MCP-connected
  // agent's tool calls reach (server/http.js's /mcp and /api/jobs routes both
  // funnel through them). Neither destructures permissionMode out of its
  // arguments, so a card posted or edited this way must always come out
  // unset/unchanged no matter what the caller sent -- letting one through would
  // be a way for a hostile board agent to hand its own next run a looser mode
  // than the board or its own session was given.
  it('ignores a permission mode on a card posted for an agent', () => {
    const result = postJobForAgent({ title: 'x', repo: REPO, permissionMode: OTHER_MODE }, noopBroadcast);
    expect(result.error).toBeUndefined();
    expect(result.job.permissionMode).toBeNull();
    expect(allJobs()[0].permissionMode).toBeNull();
  });

  it('ignores a permission mode on a card edited for an agent', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    const result = editJobForAgent({ id: job.id, title: 'renamed', permissionMode: OTHER_MODE }, noopBroadcast);
    expect(result.error).toBeUndefined();
    expect(allJobs()[0].title).toBe('renamed');
    expect(allJobs()[0].permissionMode).toBeNull();
  });
});
