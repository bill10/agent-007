---
bump: patch
---
### Fixed

- **`agent007 install` finds your old `.env` wherever you run it from.** It used to copy settings only from the current folder's `./.env`, so an install run outside the old checkout lost `ALLOWED_ORIGINS` and broke Tailscale remote access. The server now records the folder it runs in and the `.env` files it loaded (`server.json`, plus `last-server.json`, which stays after the server stops). Install copies from `./.env`, then from those files, then, for a server too old to record them, from the folder a running Agent 007 was started in. It names each file it copied from and the keys, never the values. If `tailscale serve` still points at the port and `ALLOWED_ORIGINS` doesn't list its name, install prints the exact line to add.
