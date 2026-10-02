---
bump: patch
---
### Changed

- **`agent007 doctor` streams its report in sections.** Checks are grouped under System, Agents, GitHub, Repos, Skills, Settings & service, Telegram & voice and Recommended; each section prints as soon as it and those before it are done, so a slow network check no longer holds back the fast ones. It ends with "N problems, M notes" (or "All good"), and the exit code is still 1 on any ✗.
- **Doctor is colored on a terminal.** ✓ green, ✗ and its fix red, – dim, headings bold. Piped output stays plain; `NO_COLOR` turns it off and `FORCE_COLOR` turns it on.
