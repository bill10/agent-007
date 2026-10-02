---
bump: minor
---
### Changed

- **Billion always knows its CLI and the models it may pick.** Every start prompt (first run, restart, handover) now says whether Billion runs on Claude Code or Codex and lists the models available per CLI, and `post_job`'s `agent` field tells the caller which CLI it runs as. Billion's start waits up to 15 s for the first model discovery, so a fresh conversation no longer loads a `post_job` that says Codex has no models; past that it starts anyway and points to `billion-tools.json`, which now carries the lists and is rewritten when they change. The charter has Billion name both `agent` and `model` on every card instead of leaving the model to the CLI's default.
