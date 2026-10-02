---
bump: patch
---
### Fixed

- **Several jobs starting at once in one repo no longer fail to create their worktrees.** Two `git worktree add` runs at the same moment could trip over each other's half-written entry (`failed to read .git/worktrees/…/commondir`), most often on Windows, and the job failed to start. Worktree creation in one repo now takes turns; different repos still start in parallel.
