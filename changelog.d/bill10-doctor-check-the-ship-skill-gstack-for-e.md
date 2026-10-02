---
bump: minor
---
### Added

- **`agent-007 doctor` checks the ship skill for each CLI.** A card that needs a pull request finishes with gstack's ship skill; doctor now says ✗ (with the gstack setup command) when Billion or such a card uses `claude` or `codex` and no working ship skill is installed, and reports skill links in `~/.claude/skills` and `~/.codex/skills` that point nowhere. `agent-browser` is listed as recommended, never ✗. The start's quick check includes both.
