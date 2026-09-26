---
bump: patch
---
### Fixed

- **Codex agents answer agent messages through the board again.** Codex 0.157 has a built-in `send_message` of its own, and a message's "Reply with the send_message tool" line sent Codex's reply there, where it failed. The reply line, and the line telling a worker on Billion's cards how to ask Billion, now name the `agent-007-board` tool, and Codex uses it.
