---
bump: patch
---
### Fixed

- **Queued jobs advance past failed worker spawns.** Each scan tries a card at most once and rechecks live repository capacity before starting the next eligible card, while retaining failures on their cards.
- **Repeated job titles no longer exhaust 50 branch names.** Worker branches use collision-checked random suffixes after a taken name, with bounded retries and existing branches preserved.
