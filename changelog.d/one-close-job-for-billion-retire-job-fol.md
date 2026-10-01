---
bump: minor
---
### Changed

- **Billion closes any finished card with one tool: `retire_job` folds into `close_job`.** On a card in Review, `close_job` is still the verdict on the work (accept files a no-PR card as Done, send back returns it to To do with the note). On one of Billion's own To do cards, accept with a note drops it unrun: archived to Finished jobs with the note as the reason, the same path as the Jobs tab's Archive. Send back on a To do card is refused, and an In progress card is refused with what to do instead. Billion now has 24 tools, not 25.
