---
bump: patch
---
### Fixed

- **A finished card's worktree is no longer kept as an "unpushed" orphan when its branch is on the remote.** A worker that pushed again from its worktree (a rebase fix, a force-with-lease) could leave the shared repo's `refs/remotes/origin/<branch>` on an old SHA, so cleanup saw HEAD differ from `@{u}` and kept the worktree. Cleanup now asks the remote (`git ls-remote`) whenever HEAD is not `@{u}`, not only when `@{u}` is missing. Only an exact SHA match counts; offline, an error or a different SHA still keeps the worktree.
- **Orphans already kept as "unpushed" are re-checked at startup.** Each one whose card is not in progress or in Review goes through the same cleanup rules, so one that is clean and matches the remote is released without a click. Dirty worktrees and branches the remote does not hold stay.
