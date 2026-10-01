---
bump: minor
---
### Fixed

- **The Jobs and Billion tabs keep your place when they refresh.** Scrolling down To do (or Finished jobs, or the Billion chat and its Open questions panel) and then a board broadcast or the 30-second clock tick no longer throws you back to the top, on a phone or a desktop. Lists now update in place: an unchanged card stays exactly as it is, a changed one is swapped where it stands, and the chat only follows new messages while you are already at the bottom.

### Added

- **One-time schedules.** `post_job` and `edit_job` take `run_at` (an ISO date-time, at most a year ahead) or `once: true` with a schedule: the card runs a single time and is then archived to Finished jobs by itself, with its run card going through the board as usual. On the next server start, every one-date schedule (`0 10 24 9 *`) that has already run is archived and logged, so cards like "follow-up September 24" stop showing "next 9/24/2027".
- **Archive a To do card without running it.** An **Archive** action on To do cards in the Jobs tab (with a confirm) files the card to Finished jobs with a note; Billion gets `retire_job` (id, reason) to do the same for its own cards. Nothing is deleted.
