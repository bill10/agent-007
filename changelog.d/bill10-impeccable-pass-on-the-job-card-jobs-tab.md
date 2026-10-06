---
bump: patch
---
### Changed

- **Job cards read better, on a desktop and on a phone.** The title comes first in bold with its chips on a row under it, then the card's status: the live badge (running, needs you, quiet, agent gone) and the PR link now sit together right under the title as matching pills. Card text is a step larger and meets 4.5:1 contrast in both themes; error and status text no longer fall short in the dark theme or the light one. Chips keep their case (`claude-opus-5-5`, `bypassPermissions`), long repo and branch names truncate with a tooltip instead of breaking mid-word, and the agent line reads "Viper · started 12m ago" with the branch under it. Attachments get a drawn paperclip instead of the emoji, and everything on a card shares one focus ring.
- **On a phone the board scrolls as one list.** Each column used to be its own clipped scroller a third of the screen tall. Card actions now always show on a touch screen, at 40px tall, instead of hiding until hover.
- **Every To do card says who posted it and when it runs.** "posted by Billion · 2h ago" (or "posted by bill") replaces "bill · via Billion", and a run line reads "runs Tue 8:00 PM · in 5h" on a schedule or a card with a start time, "runs next" while its repo has a free slot, "runs when a slot frees (1 ahead)" behind a full one, and "queued · board stopped" while the board is stopped.
