---
bump: minor
---
### Added

- **`agent-007 doctor` checks what Agent 007 needs and says how to fix it.** One line per check, ✓ / ✗ / – (not needed): Node and node-pty; `claude` and `codex` installed, their version and whether they are logged in (a missing one counts only when Billion or a board card uses it); `gh`, its signed-in accounts and which one reaches each GitHub repo on the board; git and each board repo's path, origin and base branch on the remote; whether the port is free, held by this Agent 007 or by something else; which settings files were read and that `config.json` parses; the version against npm; whether the Telegram bot answers; and stray local plugin registrations in board worktrees or deleted folders. Every ✗ has a fix line, and it exits 1 when anything is ✗. It only reports: nothing is written, installed, logged in or switched, and no token is printed. Run it as `agent-007 doctor`, `npx @bill10/agent-007 doctor` or `npm start -- doctor`.
- **Every start runs the quick part of it.** Before the URL line, the offline checks (Node, node-pty, the CLIs and their logins, gh installed, the port, `config.json`) run in parallel for at most two seconds, and only failures are printed, ending with the doctor command to run for details. Nothing prints when all pass.
