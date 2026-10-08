---
bump: minor
---
### Added

- **Skill families: agents see one line per family of skills, and a card picks the families its job needs.** Claude Code fits every installed skill's description into about 1% of the context window, so with 150-odd skills most showed as bare names and got missed. For the Claude Code agents Agent 007 starts, installed skills are now grouped into families (by `~/.agents/.skill-lock.json` source, gstack's folder, and an `engineering` family carved out of gstack and Claude Code's own), each with a generated catalog skill (`families:marketing`); members are listed by name only and still run by name. A card's new **Skills** field (`skills` on `post_job`, `edit_job` and `POST /api/jobs`) keeps its families fully listed; a card that ends in a pull request gets `engineering`, Billion gets `marketing` and the review skills. Everything goes in per spawn, never in `~/.claude/settings.json`. Change the grouping in `~/.agent-007/skill-families.json`; Billion is told about skills no family takes. `SKILL_FAMILIES=0` turns it off. See the README's "Skill families".
