---
bump: patch
---
### Fixed

- **Filing a card closes its worker even when that worker's CLI has already exited.** Before, the exited tab was only unlinked from the card. It stayed in the saved session list, and the next server restart turned it into an orphan of a card that had moved on. This applies when a card moves to Done or back to To do, when its PR merges, and in the closed-PR sweep. Its files are never discarded on the way out, even for a superseded scheduled run, since a CLI that died mid-run may hold work its summary does not. A worker paused for an account switch is not treated as idle. A filed card also no longer keeps a link to a session that is gone.
- **server.log names every worker the board closes** when its card is filed or sent back, for example `Shadow-2: closed, its card "…" moved to Finished`.
