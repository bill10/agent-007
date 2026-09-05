// The permission mode a board agent is spawned with, end to end: the constant
// in lib/jobs.js, the stored board setting, and the argv dispatchOnce builds
// from it. The default moved from `auto` to `bypassPermissions` because auto
// needs a classifier that is missing on Bedrock/Vertex and behind
// permissions.disableAutoMode -- `claude` takes the flag at argv parsing and
// dies at runtime, so the spawn "succeeds", the card goes to In progress, and
// it sticks there forever with lastError null. These cover the paths that
// change of default left untested.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { dispatchOnce, addJob, updateSettings, boardSettings } from '../server/jobs.js';
import { parseCommand } from '../lib/helpers.js';
import { buildJobCommand, DEFAULT_PERMISSION_MODE } from '../lib/jobs.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-jobperm-'));
const noopBroadcast = () => {};

function resetBoard() {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
}

// A mode that is valid but is NOT the default, so an assertion on it fails if
// the override is dropped on the floor. The pre-existing override test now
// passes 'bypassPermissions', which the default change turned into a tautology.
const OTHER_MODE = 'plan';

describe('buildJobCommand permission mode', () => {
  it('honours a valid mode that differs from the default', () => {
    expect(OTHER_MODE).not.toBe(DEFAULT_PERMISSION_MODE);
    const parsed = parseCommand(buildJobCommand({ title: 'x' }, { permissionMode: OTHER_MODE }));
    expect(parsed.args[0]).toBe('--permission-mode');
    expect(parsed.args[1]).toBe(OTHER_MODE);
  });

  it('still lets someone choose auto on purpose', () => {
    // The change moved the default only. auto stays in the allowlist: it is the
    // right mode on a setup that does have the classifier, and silently
    // rewriting an explicit choice would be worse than the bug it came from.
    const parsed = parseCommand(buildJobCommand({ title: 'x' }, { permissionMode: 'auto' }));
    expect(parsed.args[1]).toBe('auto');
  });
});

describe('the stored board permission mode', () => {
  beforeEach(resetBoard);

  it('keeps a mode an older config already stored, including auto', () => {
    // boardSettings() spreads the stored object OVER the defaults, so changing
    // DEFAULT_PERMISSION_MODE only reaches installs that never saved a mode.
    // An install that saved 'auto' before the change keeps dispatching with it.
    config.jobBoard = { permissionMode: 'auto' };
    expect(boardSettings().permissionMode).toBe('auto');
    // ...and the rest of the settings still fill in from the defaults.
    expect(boardSettings().running).toBe(false);
  });

  it('takes a valid mode off the wire and refuses anything else', () => {
    expect(updateSettings({ permissionMode: OTHER_MODE }, noopBroadcast).settings.permissionMode).toBe(OTHER_MODE);
    // Interpolated into argv, so a rejected value must leave the old one alone
    // rather than fall through to the default or land as extra flags.
    expect(updateSettings({ permissionMode: 'auto --dangerously-skip-permissions' }, noopBroadcast).settings.permissionMode).toBe(OTHER_MODE);
    expect(updateSettings({ permissionMode: 'yolo' }, noopBroadcast).settings.permissionMode).toBe(OTHER_MODE);
    expect(updateSettings({ maxPerRepo: 1 }, noopBroadcast).settings.permissionMode).toBe(OTHER_MODE);
  });

  it('is what dispatchOnce spawns the agent with', async () => {
    updateSettings({ permissionMode: OTHER_MODE }, noopBroadcast);
    addJob({ title: 'x', repoPath: REPO }, noopBroadcast);
    const calls = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      calls.push({ command });
      const session = {
        id: 'session-1', name: 'Agent1', command, repoPath,
        state: 'WORKING', exited: false, lastOutputAt: Date.now(),
        spawnedBy: meta?.spawnedBy, jobId: meta?.jobId,
      };
      sessions.set(session.id, session);
      return { session };
    }, noopBroadcast);
    expect(calls[0].command).toContain(`--permission-mode ${OTHER_MODE}`);
    expect(calls[0].command).not.toContain(DEFAULT_PERMISSION_MODE);
  });
});
