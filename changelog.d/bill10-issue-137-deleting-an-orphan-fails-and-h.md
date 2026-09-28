---
bump: patch
---
### Fixed

- **Deleting an orphan with a big `node_modules` no longer fails and leaves the worktree half deleted.** The worktree folder is now moved to a trash folder (instant), git's record is pruned, and the files are deleted in the background, so no git timeout can cut the delete off halfway. Deleting an orphan whose folder is already partly or fully gone now finishes the job instead of failing. Closing an agent and releasing a job's worktree use the same path. (#137)
