---
bump: minor
---
### Added

- **Billion hears about repo skills only one CLI can see.** Codex reads a repo's `.agents/skills` and `.codex/skills` (from its working directory up to the repo root), never `.claude/skills`, so a skill kept only in `.claude/skills` is Claude Code's alone. On the board's repos, Agent 007 now tells Billion once per such skill per server run, naming the repo, the skill and the fix: keep the folder in `.agents/skills` and commit a relative link to it in `.claude/skills`. It changes nothing in a repo. The README's "One skill store" documents where each CLI looks, the shared layout, and what Windows needs (`core.symlinks`).
