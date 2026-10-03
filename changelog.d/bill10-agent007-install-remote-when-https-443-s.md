---
bump: patch
---
### Changed

- **`agent007 install --remote` no longer asks before touching HTTPS 443.** When another app (say a dashboard) already uses Tailscale Serve's port 443, it leaves it alone, serves Agent 007 on the first free HTTPS port (8443, then 10000), adds `<name>:<port>` to ALLOWED_ORIGINS and prints `Open https://<name>:<port>`. If all three are taken it says what uses them and changes nothing. `agent007 doctor` recognises names on those ports.
