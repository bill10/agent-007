---
bump: patch
---
### Fixed

- **Closing an agent in one browser no longer leaves a red crashed tab in the others.** The server now tells every browser when an agent is closed, so its tab and office figure go away everywhere. A real crash or exit still keeps the tab so its output stays readable.
