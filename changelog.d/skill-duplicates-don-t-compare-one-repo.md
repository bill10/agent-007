---
bump: patch
---
### Fixed

- **Skill duplicates no longer compare one repo's skills against another's.** A repo's `.claude/skills` only loads inside that repo, so two repos each having their own `qa-browser` is not a duplicate. Repo vs global, repo vs plugin and two copies in one repo are still reported.
