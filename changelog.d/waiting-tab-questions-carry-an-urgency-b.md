---
bump: minor
---
### Added

- **Billion's questions say how urgent they are.** `notify_owner` takes an optional `urgency` (`blocking`, `normal` by default, or `low`). The Waiting on you tab lists blocking questions first, then normal, then low, oldest first within each; a bold `!` marks a blocking one (`! Q24`) and a low one's number is dimmed. Blocking questions reach Telegram with a leading `! `. Questions saved before this read as normal.
