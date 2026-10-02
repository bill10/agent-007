// Where Claude Code and Codex keep their skills, and finding one by name: the
// doctor's gstack check, and the job board's note on a card whose worker has
// no ship skill to open its pull request with.
import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export const skillHomes = (env = process.env, home = homedir()) => ({
  claudeDir: env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude'),
  codexDir: env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex'),
  agentsDir: join(home, '.agents'),
});

const readable = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const skillName = (text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '')?.[1].match(/^name:[ \t]*["']?([^"'\r\n]*?)["']?[ \t]*$/m)?.[1];
export const skillsDirs = (p, cli) => cli === 'claude' ? [join(p.claudeDir, 'skills')] : [join(p.codexDir, 'skills'), join(p.agentsDir, 'skills')];

// Where the skill whose front matter says `name: <name>` is installed and
// readable for the CLI, or null. Claude's gstack ship is also found by folder.
export function skillDir(p, cli, name) {
  const dirs = skillsDirs(p, cli);
  if (cli === 'claude' && readable(join(dirs[0], name, 'SKILL.md')) !== null) return join(dirs[0], name);
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir); } catch { /* no such folder */ }
    const n = names.find(n => skillName(readable(join(dir, n, 'SKILL.md'))) === name);
    if (n) return join(dir, n);
  }
  return null;
}
