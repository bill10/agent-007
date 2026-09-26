---
bump: minor
---
### Added

- **`resolve_question` closes a question the owner answered elsewhere.** When you answer Billion in its terminal instead of the Waiting tab or Telegram, Billion marks that question answered: it moves to Answered in every browser, the badge drops, and your phone's copy shows the answer. Billion-only.

### Changed

- **Every question to the owner goes through the Waiting tab.** Billion's charter now makes it a hard rule: anything that needs your answer, escalation or not, is a `notify_owner` call, so it never lives only in the terminal where your phone can't see it.
