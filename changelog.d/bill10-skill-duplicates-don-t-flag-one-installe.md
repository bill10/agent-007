---
bump: patch
---
### Fixed

- **Skill duplicates no longer flags a skill the `skills` installer mirrored on purpose.** An identical copy in `~/.claude/skills` and `~/.agents/skills` whose name is in `~/.agents/.skill-lock.json` is one install, so it is skipped. Copies whose contents differ, and identical copies of unlocked skills, are still reported.
