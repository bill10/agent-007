---
bump: patch
---
### Changed

- **The built-in skill family comes from what this machine's Claude Code actually lists.** At server start, and whenever `claude --version` changes, Agent 007 runs `claude -p` once against a stand-in API on 127.0.0.1 and reads the skill listing out of the request: no fixed list of bundled skills in code, nothing sent to Anthropic, no usage spent, request headers never read or kept. The result is cached per version in `~/.agent-007/skill-listing.json`. Built-in is that listing minus installed, plugin and engineering skills, each with the listing's own one-liner. If the probe fails there is no built-in family on that machine, so nothing is hidden, and Billion gets one notice saying why.
