---
bump: patch
---
### Fixed

- **`agent007 update` no longer says "Already up to date" while the registry has a newer version.** On an npm install it asks the registry for `latest` directly (npm's own cache can lag by minutes), installs that exact version with `--prefer-online`, and checks the installed version matches. If the registry is unreachable or npm installed the old version, it says so and prints the command to retry instead of restarting.
