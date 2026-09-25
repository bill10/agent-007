---
bump: micro
---
### Fixed

- **The branch-sync test no longer flakes on slow runners.** It waited fixed times for scan ticks, but the next tick is only scheduled after the previous scan finishes, so slow git on Windows could outlast the sleep. It now waits for the scans themselves.
