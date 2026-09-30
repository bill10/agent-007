---
bump: minor
---
### Added

- **An Open questions panel in the Billion tab, grouped by project.** The strip of open questions is now one button ("7 open questions ▾", "tap to see all" the first time): tap it or the tab's badge and a panel slides over the thread with a section per project (blocking first, then oldest), each question a row with its urgency, number, first line and age, answered in place with its choices or *Reply*; tap the text to jump to its bubble, × or Esc to go back. Full screen on a phone; open or closed is remembered per browser.
- **`notify_owner` takes a `project`.** Billion names the repo a question is about (its folder name on the board, or `general`); left out, the server reads it off a GitHub PR/issue/repo URL or a board repo's name in the text, else `general`. Questions saved before read as `general`.
