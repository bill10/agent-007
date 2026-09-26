---
bump: patch
---
### Fixed

- **Billion hears when a board tool changes under a resumed conversation.** Claude Code keeps each tool's definition from when the conversation first loaded it, so after an upgrade Billion went on reading the old `notify_owner` (no one-tap choices) with nothing to say it had changed. Each start now saves the current board tool definitions to `billion-tools.json` in the config folder, and the restart prompt names the tools that changed since the last start and tells Billion to read them there.
