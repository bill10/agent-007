---
bump: minor
---
### Added

- **Cards can switch a marketplace plugin on for their worker, Vanta first.** A `"plugins"` map in `~/.agent-007/skill-families.json` names plugins by a short name (Vanta is built in: `{"plugins": {"vanta": "vanta-mcp-plugin@claude-plugins-official"}}`). Every Claude Code agent Agent 007 starts gets those off through `enabledPlugins` in its `--settings`, and a card whose `skills` names one (`["vanta"]`) gets it on. Plugins outside the map stay as you set them, and `~/.claude/settings.json` is never written. If a named plugin isn't installed, the worker starts anyway and the card says so. The card form's Skills suggestions include the plugin names.

### Fixed

- **The card form's Skills and Schedule fields take the row's width again.** A more specific rule had them sizing to their hint text, which ran past the panel edge at phone width.
