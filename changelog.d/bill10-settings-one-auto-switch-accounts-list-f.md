---
bump: minor
---
### Changed

- **One Auto-switch accounts list for Claude and Codex.** Settings → Auto-switch accounts now shows a single list of every account, each tagged Claude or Codex, with one on/off switch, one Find logged-in accounts (it finds both CLIs' logins), one Add an account folder manually (pick the CLI next to the folder) and one Save settings. The list order is the switch order. The two "Fall back to …" checkboxes are gone: Billion hands over to the other CLI when its own accounts run out only if the list has a selected account of that CLI. Existing settings carry over, Claude accounts first, then Codex.
