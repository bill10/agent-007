---
bump: patch
---
### Fixed

- **Codex workers on Billion's cards report back without a dialog.** Every `send_message` or `finish_job` call a Codex worker made opened "Allow the agent-007-board MCP server to run tool …?" for you, so an unattended job stalled until someone clicked. Those two tools are now pre-allowed for that run, the same two Claude Code workers get; any other board tool still asks, and `~/.codex/config.toml` is untouched.
