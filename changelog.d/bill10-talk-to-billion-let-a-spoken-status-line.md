---
bump: patch
---
### Fixed

- **Talk lets a spoken status line finish before the answer.** The status phrase is no longer cut off mid-word when the reply arrives: it ends (or stops after 3 s), a newer queued status is dropped, and the reply plays right after. Speaking over Billion still stops everything at once.
