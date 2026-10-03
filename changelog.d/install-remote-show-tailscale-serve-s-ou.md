---
bump: patch
---
### Fixed

- **`agent007 install --remote` no longer hangs silently when Serve isn't enabled.** `tailscale serve` prints a link to enable Serve and waits; its output now shows live, the wait is capped at 5 minutes (the link and the command to re-run are printed if it runs out), and Ctrl-C stops cleanly. The `ts.net` name it found is printed before serve runs.
