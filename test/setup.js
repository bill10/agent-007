import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The suite tests the built-in defaults, so the host's own agent-007 settings
// must not leak in: a shell exporting CLAUDE_PERMISSION_MODE, AGENT_MESSAGING
// and friends (as a configured .env user's often does) failed tests that assume
// them unset. Every variable .env.example documents, commented out or not, is
// cleared; tests that exercise one set it themselves. This runs first so it
// can never undo the temp dirs set below.
for (const [, key] of readFileSync(join(import.meta.dirname, '../.env.example'), 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
  delete process.env[key];
}

// Point auth at a throwaway users path so the suite is hermetic: the file does
// not exist, so auth starts DISABLED regardless of the dev machine's real
// ~/.agent-007/users.json. Auth-specific tests create/remove users at this path.
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
