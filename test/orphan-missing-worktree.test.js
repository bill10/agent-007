import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../server/config.js';
import { config, orphans, CONFIG_PATH, CONFIG_DIR } from '../server/state.js';

afterEach(() => {
  try { rmSync(CONFIG_PATH); } catch {}
  orphans.clear();
});

describe('orphans at startup', () => {
  it('drops an orphan whose worktree folder no longer exists', () => {
    const here = mkdtempSync(join(tmpdir(), 'orphan-here-'));
    const gone = join(tmpdir(), 'orphan-gone-does-not-exist');
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({
      version: 1, repos: [], activeSessions: [], jobs: [],
      orphans: [
        { id: 'o1', name: 'Viper', worktreePath: here },
        { id: 'o2', name: 'Cobra', worktreePath: gone },
      ],
    }));
    loadConfig();
    expect([...orphans.keys()]).toEqual(['o1']);
    expect(config.orphans.map(o => o.id)).toEqual(['o1']);
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).orphans.map(o => o.id)).toEqual(['o1']);
    rmSync(here, { recursive: true });
  });
});
