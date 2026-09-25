---
bump: patch
---
### Changed

- **A new card starts right away when its repo has room.** Posting a card, moving one back to To do, or a worker freeing its slot (card to Review or Done, or its agent gone) now triggers a dispatch pass within about two seconds, instead of waiting for the next 5-minute scan. Bursts coalesce into one pass, a stopped board still does nothing, and the periodic scan stays as the fallback.
