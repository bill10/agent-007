---
bump: micro
---
### Changed

- **The Telegram poller logs going offline and coming back, not every retry.** A Mac sleeping, waking or changing network used to fill the server log with `getUpdates failed` lines. Now a brief blip is silent; an outage past three failures or a minute logs one `Telegram: offline (no network / DNS / timeout / HTTP n), retrying quietly` line, and recovery logs `Telegram: back online after <duration>`. A 401 (wrong or revoked token) or 409 (another process polling this bot) logs right away with a hint.
