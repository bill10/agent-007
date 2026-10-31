---
bump: patch
---
### Fixed

- **Server git calls no longer run repo hooks or fsmonitor, and no longer see server-only secrets.** A worker can write the shared `.git`, so a `post-checkout` hook or `core.fsmonitor` fired by `git worktree add` used to run with the server's `TELEGRAM_BOT_TOKEN` and friends in its env. Git now runs with `core.hooksPath` and `core.fsmonitor` off and the same env stripping workers get.
