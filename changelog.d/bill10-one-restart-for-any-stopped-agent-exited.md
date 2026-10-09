---
bump: minor
---
### Added

- **One Restart for any agent that is not running.** An agent whose CLI quit by itself (Codex's update, a crash, a stray `/exit`) now shows Restart across the bottom of its terminal and on its left-panel row. It comes back in place, in the same tab and worktree and on the same card, resuming its own conversation: `codex resume <its session id>` or `claude --resume <its conversation id>`, with the model and permission flags it ran with. An orphan's Re-spawn is now that same Restart. A board worker whose CLI exits keeps its tab instead of vanishing, and closing a stopped agent's tab now really closes it, so it no longer comes back on a reload.
- **Codex no longer offers to update inside an agent's terminal.** That prompt installed the update and exited, leaving a dead agent. Every Codex Agent 007 starts gets `-c check_for_update_on_startup=false` (your `~/.codex/config.toml` is untouched). Settings now lists Claude Code and Codex under Agent 007's own version, installed against latest, with an Update that runs the CLI's own `update`. Running agents pick the new version up on their next Restart.
