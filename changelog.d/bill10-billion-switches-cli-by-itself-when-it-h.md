---
bump: minor
---
### Added

- **Billion switches CLI by itself at a usage limit.** The server reads the bottom of Billion's screen (only Billion's) for Claude Code's and Codex's own limit notices. Past 75% and again past 90% of a limit it tells Billion to bring `STATE.md` up to date and commit; at a hard limit ("You're out of usage credits", "You've hit your session limit", Codex's "You've hit your usage limit") it waits for Billion to go quiet, switches it to the other CLI with a `HANDOVER.md`, saves the reason in `billion-agent.json` and tells you on Telegram. It never switches back on a timer and never twice within 30 minutes; if the other CLI is spent too, missing or logged out, Billion stays put and "Billion paused: both Claude Code and Codex are at their limits" goes to *Waiting on you* and Telegram. `BILLION_AUTO_SWITCH=0` turns it off.
