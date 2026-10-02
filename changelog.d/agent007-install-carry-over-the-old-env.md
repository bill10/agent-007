---
bump: patch
---
### Fixed

- **`agent007 install` keeps remote access working.** The service runs in `~/.agent-007`, so a `.env` in the folder you used to start Agent 007 from (`ALLOWED_ORIGINS` for your tailnet name, `PORT`, `HOST`, Telegram) stopped applying and remote browsers were turned away. Install now copies every key that `~/.agent-007/.env` lacks from the current folder's `.env`, never overwriting one, and names the keys it copied (never their values).
- **`agent007 doctor` checks `tailscale serve`.** When it proxies a tailnet name to this port and `ALLOWED_ORIGINS`, as the server reads it, does not list that name, doctor says so and gives the line to add.
