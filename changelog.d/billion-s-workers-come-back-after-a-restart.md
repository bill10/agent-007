---
bump: minor
---
### Added

- **Billion's workers come back after a restart.** A worker on one of Billion's cards that is still In progress is re-spawned by itself when the server starts: it resumes its own worktree and conversation, gets its card back and one nudge to continue. They come back one every couple of seconds, within the board's per-repo cap; any over the cap wait in the orphans list for the next scan. Cards in Review, agents you started by hand and other people's cards are left alone. `RESPAWN_BOARD_WORKERS=0` in `.env` turns it off.
- **`respawn_agent` for Billion.** Billion can bring back an orphaned worker on one of its own cards by name, through the same path as the Re-spawn button. It never makes a new worktree, reports a worktree that has gone instead, and respects the cap.
