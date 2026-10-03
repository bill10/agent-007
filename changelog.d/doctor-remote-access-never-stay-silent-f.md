---
bump: patch
---
### Fixed

- **`agent007 doctor` always says something about remote access.** It now finds the Tailscale CLI inside the macOS app (`/Applications/Tailscale.app`) when `tailscale` is not on PATH, reports when Tailscale is missing or `tailscale serve` does not proxy this port (listing what it serves), and shows the `ALLOWED_ORIGINS` the service reads.
