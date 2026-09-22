// Point auth at a throwaway users path so the suite is hermetic: the file does
// not exist, so auth starts DISABLED regardless of the dev machine's real
// ~/.agent-007/users.json. Auth-specific tests create/remove users at this path.
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.AGENT007_USERS_PATH = join(mkdtempSync(join(tmpdir(), 'a007-test-')), 'users.json');

// Same idea for worktrees: createWorktree mkdirs and git-worktree-adds under
// WORKTREE_DIR, which defaults to the developer's live ~/.agent-007/worktrees.
// Without this a worktree test would litter (or collide with) a running server.
process.env.AGENT007_WORKTREE_DIR = mkdtempSync(join(tmpdir(), 'a007-worktrees-'));

// And the config file: saveConfig() serialises the whole in-memory config over
// ~/.agent-007/config.json, so any test that adds a repo, a job, or an orphan
// would otherwise wipe the developer's real repo list and orphan records.
process.env.AGENT007_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'a007-config-'));

// Node 25+ ships its own Web Storage globals (localStorage, sessionStorage,
// Storage); without --localstorage-file, localStorage is undefined. Vitest's
// happy-dom environment only copies window keys that are NOT already on the
// global, so under Node 26 the happy-dom storage never arrives and every
// client test touching localStorage fails. Install happy-dom's in their place.
if (globalThis.happyDOM) {
  const { Storage } = await import('happy-dom');
  for (const [key, value] of [['Storage', Storage], ['localStorage', new Storage()], ['sessionStorage', new Storage()]]) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}
