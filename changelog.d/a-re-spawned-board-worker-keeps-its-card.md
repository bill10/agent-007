---
bump: patch
---
### Fixed

- **A re-spawned board worker is a board worker again.** After a restart, Re-spawn on a board worker's orphan now brings back its card link (saved jobId, or the card on its branch for older records), its Billion approval routing and its folder trust. It counts toward the per-repo cap, gets one "Agent 007 restarted and you were re-spawned. Continue your card where you left off." line while its card is In progress, and when the board files its card its tab closes and it walks out, rather than leaving a crossed-out tab behind.
