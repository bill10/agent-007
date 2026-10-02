---
bump: minor
---
### Changed

- **A scheduled job is one card.** A job for one date is now an ordinary one-time card with a start time: it waits in To do showing its date under a *scheduled* chip, the board dispatches that same card when the time comes, and it moves through In progress, Review and Done like any other. No more separate run card, and no schedule archiving itself. **Run now** on the card starts it early; Edit moves its time, Now clears it, Recurring makes it a schedule. Agents still post it with `run_at` (or a schedule plus `once: true`). On start, the server converts every once schedule that has not fired yet into such a card, keeping its id, text, repo, agent, model and attachments, and logs each one.
