---
bump: patch
---
### Fixed

- **Retire an exact stale saved worker attempt without claiming its work finished.** The single-player Billion can use `retire_saved_attempt` after external verification, with the saved-record token from `read_job`. A durable audit receipt preserves the record and blocks restart conversion, rediscovery and orphan adoption while retaining the original card and worktree. Live, parked, orphaned, adopting, changed or ambiguous attempts are refused. Schedule replacement remains a separate supported operation.
