---
bump: minor
---
### Changed

- **Telegram buzzes only for questions and for replies to a conversation on the phone.** Every `notify_owner` question still goes to Telegram, but a `tell_owner` reply (and a server notice such as an account-switch result) reaches the phone only when the owner's last message came over Telegram, or before they have written at all since the server started. Talking to Billion in the Billion tab keeps the replies there. The tool result tells Billion which way it went.
- **No "Billion: " prefix on Telegram.** The bot is Billion's own: questions read `Q3: …` (`! Q3: …` when blocking), replies are the text alone.
