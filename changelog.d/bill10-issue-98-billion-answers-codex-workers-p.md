---
bump: minor
---
### Added

- **Billion answers Codex workers' permission requests too.** A Codex worker on one of Billion's cards now asks Billion before it asks you, as Claude Code workers already did. Its `PermissionRequest` hook goes in as two `-c` flags for that run, the hook and its trusted hash, so nothing is written to `~/.codex/config.toml` and no trust prompt appears. The server asks Codex itself for the hash when it starts (`codex app-server`, `hooks/list`); if `codex` is missing or the answer isn't exactly our hook, Codex workers keep asking you. If you have your own `PermissionRequest` hook in `~/.codex/hooks.json`, both run and a deny from either wins.
