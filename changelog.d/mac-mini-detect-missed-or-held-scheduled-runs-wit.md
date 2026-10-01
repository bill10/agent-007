---
bump: patch
---
### Added

- **See why a schedule has not posted its next run.** Jobs now distinguishes overdue posting, active or queued holds, and gone or stalled prior workers, with a link to the blocking run and timestamped firing evidence. Detection is passive: it never retries work or changes recovery decisions.
