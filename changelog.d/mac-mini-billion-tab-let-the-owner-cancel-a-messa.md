---
bump: patch
---
### Added

- **Cancel a message before Billion gets it.** In the Billion tab, a message still waiting in Billion's queue reads "queued" and has a **× Cancel** link (tap twice to confirm). Cancelling takes it out of the queue so Billion never receives it and shows it struck through as "Cancelled — Billion never got it". The cancel is saved, so a reload or restart keeps it cancelled and delivers nothing. This works for typed messages, Talk to Billion voice turns, attachments and Telegram messages. If typing into Billion's terminal has already started, the message stays sent and the tab says "Already sent to Billion".
