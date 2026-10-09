---
bump: minor
---
### Changed

- **One Accounts list in Settings.** "Agents & accounts" and "Auto-switch accounts" are now one **Accounts** section: one row per login, led by its CLI (Claude, Codex, Gemini), then its email, plan and one status (Active, Available, Limited · until …, Logged in or Logged out, plus Default for the CLI's default folder). Claude and Codex rows come first in switch order and keep their status, checkbox, Move up/down and Switch now; other CLIs' logins and logged-out folders show read-only after them. **Find logged-in accounts** is gone: every logged-in Claude and Codex login the scan finds (at start and on **Refresh**) joins the switch list on its own. **Add an account folder manually** stays for folders the scan misses. Each agent CLI's version, path and Update now sit on one compact line below the list, CLIs with no accounts included. With user accounts on, the list still shows, read-only.
