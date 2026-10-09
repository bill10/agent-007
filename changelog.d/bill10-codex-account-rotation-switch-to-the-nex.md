---
bump: minor
---
### Added

- **Codex account rotation, like Claude's.** With two or more Codex logins (`~/.codex` and `~/.codex-*` folders with an `auth.json`), **Settings → Auto-switch accounts** now has a Codex list next to the Claude one, with the same controls: Find logged-in accounts, order, on/off, Switch now, Restore previous login. At a hard Codex usage limit on Billion or a Codex worker, the app saves the current login's refreshed `auth.json`, writes the next account's over `~/.codex/auth.json` (config, sessions, skills and history stay put), restarts Codex's background server so it picks the new login up, and resumes each Codex session on `codex resume <id>`. A limited account is retried at the "try again at …" time Codex prints, else after 30 minutes. Billion hands over to Claude Code only once every Codex account is unavailable, and Codex workers rotate instead of waiting. Other tools that read `~/.codex/auth.json` follow the switch.
