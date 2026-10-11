---
bump: micro
---
### Fixed

- **Leftover agents whose worktree folder is gone no longer linger.** If a leftover agent's worktree was removed outside the app (for example with `git worktree remove`), it is now dropped from the office at startup instead of showing forever.
