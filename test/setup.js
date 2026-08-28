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
