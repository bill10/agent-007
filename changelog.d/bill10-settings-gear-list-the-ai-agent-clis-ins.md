---
bump: minor
---
### Added

- **A Settings gear lists the AI agent CLIs on this machine and the accounts each is logged in with.** Next to the light/dark toggle, the gear opens "Agents & accounts": for each CLI found on the PATH (Claude Code, Codex, Gemini CLI, opencode, aider, Hermes, Cursor Agent, Amp, goose, Qwen Code, Crush) its version and path, and under Claude Code, Codex and Gemini CLI each login folder (the default marked) with its email, plan and logged-in state. Scanned once at start; Refresh rescans. Read-only: it only runs each CLI's local status check and reads the email from its login file, and never returns or logs a token.
