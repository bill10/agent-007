---
bump: minor
---
### Added

- **Connect Telegram from the browser.** With no chat set, a message to the bot from any chat shows in the Billion tab as "Telegram: a message from <name> (chat <id>). Use it for Billion?". Press **Use this chat** and it is connected at once, no `.env` edit and no restart; the bot says "Connected to Agent 007." there. Only the owner's browser sees the offers, none is adopted by itself, and `TELEGRAM_CHAT_ID` still wins when set.
- **Group chats say who spoke.** When the connected chat is a Telegram group, Billion reads `[Owner via Telegram (Alice)] ...` (voice and answers too), and the thread shows "Alice on Telegram" and "Alice answered: Merge". Private chats are unchanged. The server logs a hint when a group's bot still has privacy mode on.
