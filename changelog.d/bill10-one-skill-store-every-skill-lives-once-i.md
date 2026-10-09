---
bump: minor
---
### Added

- **One skill store: every skill installed once, for Claude Code and Codex.** Turn on **Settings → One skill store** (a dry run shows first) and each skill lives once in `~/.agents/skills`, which Codex reads, with a link in `~/.claude/skills` for Claude Code. Skill folders in `~/.claude/skills` or `~/.codex/skills` move into the store, at start and before every agent starts, so a skill installed later for either CLI reaches both. Nothing is deleted: replaced folders go to `~/.agent-007/skill-backup/`, two different copies of one name are left alone and Billion is told, and links, gstack, `synced`, `.system`, plugins and repo skills are never touched. `agent007 skills sync [--dry-run]` runs it from a terminal; `claudeOnly` / `codexOnly` in `skill-families.json` opt a skill out.
