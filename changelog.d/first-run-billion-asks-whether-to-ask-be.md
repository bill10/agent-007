---
bump: patch
---
### Changed

- **Billion asks in its introduction whether to ask before merging a PR that deploys, and your answer is the rule.** It is written into its `CLAUDE.md` as a standing rule ("ask first", "never ask", "ask only for production", per-repo exceptions). Without a rule, Billion asks when `merge_check` reports a deploy or can't tell.

### Removed

- **The per-repo "deploy merges" setting in the Jobs toolbar.** Your rule in Billion's `CLAUDE.md` replaces it; a leftover `deployMergePolicy` in `config.json` is ignored. `merge_check` no longer reports `policy` or `should_ask`, only what deploys.
