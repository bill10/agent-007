---
bump: patch
---
### Changed

- **The job board runs from a fresh install.** A first card no longer sits in To do until you find Start on the board toolbar. An install that has already saved a setting keeps it. When the board is stopped and a card is waiting, To do says so, with a Start button beside it.

### Fixed

- **A card that needs a pull request says up front when its repo has no GitHub remote**, as soon as it is posted or dispatched, instead of after the worker finishes. The job still runs.
- **Phone fixes:** the read-aloud voice picker wraps to its own line instead of being clipped, the stopped-Billion placeholder fits on one line ("Start Billion to send"), and the Terminal button opens your first agent when none is selected, instead of "No agent selected".
- **The Billion tab no longer says "Nothing here yet. Say something to Billion." under a notice that Billion can't hear you.**
