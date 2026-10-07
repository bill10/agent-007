---
bump: minor
---
### Added

- **`auto_done` on post_job and `POST /api/jobs`.** A no-PR card posted with `auto_done: true` (HTTP also takes `autoDone`) goes straight to Done when its worker calls `finish_job`: summary kept, agent retired, worktree and local branch released, the same path as Billion's `close_job` accept. For headless pollers with Billion off, whose cards otherwise sat in Review forever. Refused on a PR card or a schedule. The archive shows it as "finished … (auto)".
