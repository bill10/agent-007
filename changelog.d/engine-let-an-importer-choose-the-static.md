---
bump: minor
---
### Added

- **`AGENT007_STATIC_DIR` picks the directory the web UI is served from.** An app that imports the engine (such as Star Quest) can serve its own UI without replacing the HTTP server's request listener. Unset, it serves the bundled `public/` as before.
