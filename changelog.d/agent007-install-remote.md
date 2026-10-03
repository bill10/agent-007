---
bump: minor
---
### Added

- **`agent007 install --remote` sets up remote access over Tailscale in one step.** It finds the Tailscale CLI (PATH, or inside the macOS app), runs `tailscale serve --bg <port>` (kept across reboots), adds this machine's ts.net name to `ALLOWED_ORIGINS` in `~/.agent-007/.env`, and restarts Agent 007 if it is running; then open `https://<machine>.<tailnet>.ts.net` on any device in your tailnet. Without a running, logged-in Tailscale it says what to do and changes nothing, it never replaces another site on the HTTPS port without asking, and it prints Tailscale's link when Serve is not enabled on the tailnet. `install --all` now includes it, plain `install` offers it when Tailscale is installed, and `--dry-run` prints what it would do.
