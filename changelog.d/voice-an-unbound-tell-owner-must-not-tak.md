---
bump: patch
---
### Fixed

- **A status note no longer gets read out as the answer to a voice turn.** A `tell_owner` without `reply_to` now answers only a waiting typed message, never a "Talk to Billion" turn; voice turns are answered by a `tell_owner` whose `reply_to` names them.
