---
bump: minor
---
### Added

- **`agent-007 doctor` checks what Agent 007 needs and says how to fix it.** Run it as `agent-007 doctor`, `npx @bill10/agent-007 doctor` or `npm start -- doctor`. It prints one line per check, marked ✓, ✗ or – (not needed), with a fix line under every ✗, and exits 1 when anything is ✗. It checks:
  - Node and node-pty.
  - `claude` and `codex`: installed, their version, and whether they are logged in. A missing one, or one that is logged out, is ✗ only when Billion or a board card uses it.
  - `gh`: its signed-in accounts, and which one board workers use for each GitHub repo on the board.
  - git and each board repo: the path exists, it is a repo, it has an origin, and its base branch is on the remote. The remote check runs as that repo's account and never prompts. A local-only repo is fine unless a card on it needs a pull request.
  - The port: free, held by this Agent 007, or held by something else.
  - The settings files read, and whether `config.json` parses.
  - The version against npm's latest.
  - Whether the Telegram bot answers.
  - Stray local plugin registrations in board worktrees or deleted folders.

  It only reports. Nothing is written, installed, logged in or switched, and no token or file content is printed.
- **Every start runs the quick part of it.** Before the URL line, the offline checks run in parallel for at most two seconds: Node, node-pty, the CLIs and their logins, gh installed, the port and `config.json`. Only failures are printed, and the list ends with the doctor command to run for details. When everything passes, nothing is printed. The start reuses the doctor's CLI scan instead of running a second one.
