---
bump: minor
---
### Added

- **A board-wide worker limit.** The job board now runs at most `jobBoard.maxWorkers` workers at once across every repo (5 unless set; **max total** in the toolbar), on top of `maxPerRepo`. Billion itself never counts. When the board is full, Billion's urgent cards (`post_job` with `urgent: true`) and the runs of a schedule go out first, then the oldest card.
- **Memory back-pressure.** Before starting a worker the board reads swap, macOS's memory pressure level, free disk and, when present, the mac-mini-guard watchdog's `current.json`. Under pressure (swap over 75%, under 15 GB free) it runs two workers fewer; when critical (swap over 90%, under 8 GB free) it starts none until memory recovers, and running workers carry on. To do says why ("Waiting: Mac memory is low"), a held card shows "delayed by memory", a delayed schedule run keeps its place and goes first, and the board looks again every minute. The toolbar shows running against the limit, and `agent007 doctor` shows the readings, the limit and the reason. `MEMORY_BACK_PRESSURE=0` turns it off.

### Fixed

- **A dropped connection no longer hides the owner's pending message.** While the Billion tab reconnects, a message still waiting for Billion keeps its "waiting" state and its progress box (marked "Reconnecting… your message is kept", not active) instead of looking answered, and the reconnect's replay brings it up to date without reloading the page.
