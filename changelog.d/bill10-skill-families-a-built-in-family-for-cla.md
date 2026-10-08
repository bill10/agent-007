---
bump: minor
---
### Added

- **A `built-in` skill family for Claude Code's own skills and your claude.ai skills.** The agents Agent 007 starts now list dataviz, claude-api, loop, schedule, the artifact skills, `anthropic-skills:pdf`, `docx`, `deep-research` and the rest by name only, behind one `families:built-in` catalog, unless a card asks for `skills: ["built-in"]`. That frees about 14 KB of every listing: a plain worker's skill listing drops from 22.6k to 8.8k characters, and a `hyperframes` card now fits Claude Code's listing budget. Synced skills are read from `~/.claude/skills/synced`, so new ones join on their own; a bundled skill a newer Claude Code adds is reported to Billion like any unfiled skill. Your own sessions are unchanged.
