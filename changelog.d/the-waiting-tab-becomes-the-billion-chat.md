---
bump: minor
---
### Added

- **The Waiting tab is now the Billion tab: a chat with Billion.** Billion's terminal stays the work log, where board notices and worker messages keep arriving; the conversation with the owner moves to a thread in the browser, the web twin of the Telegram channel. Type in the box at the bottom (Enter sends, Shift+Enter is a new line) and it reaches Billion as `[Owner via app] ...`. Billion's `tell_owner` replies now always show there (with or without Telegram), its questions show as bubbles with their choices as buttons that collapse to "you answered: ..." once answered, and Telegram messages, voice notes included, join the same thread. While a question is open the box answers the oldest blocking one, else the oldest one, and says so (× sends a plain message instead). Open questions pin to a strip at the top, blocking first. The last 500 messages are kept in `~/.agent-007/chat.json`.
