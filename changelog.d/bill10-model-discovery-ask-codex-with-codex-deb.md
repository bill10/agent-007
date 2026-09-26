---
bump: micro
---
### Changed

- **The board asks Codex for its models with `codex debug models`.** Codex's official catalog command replaces reading its private `models_cache.json`, which is still read if the command is missing, fails, times out or prints something that is not a catalog. The server log says which one each refresh used.
