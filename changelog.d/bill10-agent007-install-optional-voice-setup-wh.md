---
bump: minor
---
### Added

- **`agent007 install` can set up voice.** `install` asks once whether to set up voice too (only in a terminal), `install --voice` sets up voice alone without touching the service (Windows included), and `install --all` does both. Voice setup installs whisper.cpp and ffmpeg (Homebrew on macOS; instructions on Linux and Windows), downloads a speech model you confirm to `~/.agent-007/whisper/`, sets `WHISPER_MODEL` in `~/.agent-007/.env`, tests it, and offers a restart. doctor and the Talk button's "not set up" note now point to it.
