---
bump: minor
---
### Added

- **A "What's new" link when an update is available.** Settings' "Version x is available" line now links to a window listing every CHANGELOG section between the version you run and the latest, newest first, with Update and Close. The notes come from GitHub at the latest release's tag (`GET /api/update/changelog`), since the npm package doesn't ship CHANGELOG.md; if GitHub can't be reached, the window says so and links to the CHANGELOG instead.
