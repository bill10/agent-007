---
bump: patch
---
### Added

- **Billion is told about duplicate and superseded skills.** The skill scan now spots the same skill name in more than one place (`~/.claude/skills`, `~/.agents/skills`, a board repo's `.claude/skills`, plugins), byte-identical skill folders under different names, and a skill whose description says it replaces, supersedes or deprecates another installed one. Billion gets one notice per finding per server run naming both paths and suggesting the removal; Agent 007 deletes nothing. gstack's intentional aliases are left out.
