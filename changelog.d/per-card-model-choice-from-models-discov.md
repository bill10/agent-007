---
bump: minor
---
### Added

- **Each job card can pick its model.** A **Model** dropdown on the + Job form and the card editor lists the models the board discovers on this computer: Claude Code's aliases (`fable`, `opus`, `sonnet`, `haiku`) and the models in Codex's picker (read from `$CODEX_HOME/models_cache.json`). Nobody maintains a list, and "CLI default" stays the default. The card shows its model, a worker re-spawned after a restart keeps it, and unknown values are refused. `post_job` and `edit_job` take `model` and list what is available, and Billion's charter says when to spend a strong model and when a fast one will do.
