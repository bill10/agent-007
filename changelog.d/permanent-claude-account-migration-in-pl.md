---
bump: minor
---
### Added

- **Move to another Claude account in place, from the app.** A **Claude account** panel at the foot of the left panel takes the folder a new account was logged in with (`CLAUDE_CONFIG_DIR=~/.claude-new claude`), shows both emails, and offers **Switch now**, **Arm: switch when the current account is used up**, **Roll back** and **Retire the new folder**, each behind a confirm. Off by default: nothing happens until you press one, and Billion has no tool for it. A switch backs the current login up (0600, under `~/.agent-007/account-backup/`), writes the new token into the Keychain item Claude Code itself uses (`.credentials.json` on Linux) and the account block into `~/.claude.json`, keeps everything else, verifies with `claude auth status --json` and rolls back by itself if the new email does not show. Armed, it runs at Billion's first hard usage limit, before any switch to Codex, and Billion restarts on the new account. The new folder is never deleted; retiring renames it. For a permanent move, not for rotating past usage limits.
