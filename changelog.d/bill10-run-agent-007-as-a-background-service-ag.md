---
bump: minor
---
### Added

- **`agent007 install`: run Agent 007 as a background service.** On macOS (a LaunchAgent) and Linux (a systemd `--user` unit), it starts at login, comes back if it stops, and keeps running after you close the terminal. It runs the copy you installed from with an absolute `node` and your login shell's `PATH`, captured at install time, so `claude`, `codex`, `gh` and an nvm node are found. `--dry-run` prints the file; it refuses while a server already runs in a terminal. `agent007 uninstall` removes it and keeps `~/.agent-007`.
- **`agent007 status`, `restart`, `logs`, `update`.** `status`: running or not, as a service or in a terminal, pid, version, port, uptime, workers mid-step. `restart` waits for those workers to finish their step (`--now` skips the wait), and works in a terminal too, where the server restarts in place. `logs [-f]` tails `~/.agent-007/logs/server.log` (capped at 5 MB plus one older copy). `update` pulls a clone (`git pull --ff-only`, `npm install` only when the lock changed) or runs `npm install -g @bill10/agent-007@latest`, prints old → new version, then restarts.
- **`agent007` is the command's name.** `agent-007` still works, and `npm start -- <command>` in a clone.
- **doctor checks an installed service**: its node and bin still exist, and `claude`, `codex` and `gh` resolve on its `PATH`; the fix is `agent007 install`, which captures the `PATH` anew.
