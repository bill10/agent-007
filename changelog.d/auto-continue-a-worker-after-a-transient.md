---
bump: minor
---
### Added

- **A board worker stopped by a transient API error is told to continue.** When a worker's turn dies on an API 429, 5xx, "Overloaded" or a dropped connection, it no longer sits stalled until morning: a minute after the error the board types `continue` into it, at most twice per card, and a turn that ends cleanly gives it both back. Each one is logged on the card (`autoContinues` in read_job) and in server.log. Usage limits and logins are left to account rotation and Billion's CLI switch, and agents started by hand are never touched. Idea from mattabate/life-distributable's `hub/internal/threads/retry.go`.
