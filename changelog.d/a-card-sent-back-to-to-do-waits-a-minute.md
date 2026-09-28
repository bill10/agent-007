---
bump: minor
---
### Added

- **A card sent back to To do waits a minute before it is dispatched again.** Moving a card back from In progress or Review, or Billion sending one back with `close_job`, used to hand it to a new worker within two seconds, before anyone could fix the text that sent it back. Now the card is held for 60 seconds and says "held · dispatching in Ns"; `edit_job` and the board's Edit work during the hold without lifting it, and **Dispatch now** on the card sends it at once. A freshly posted card still goes out straight away.
