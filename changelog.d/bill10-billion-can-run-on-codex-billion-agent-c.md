---
bump: minor
---
### Added

- **Billion can run on Codex.** `BILLION_AGENT=codex` in `.env` (default `claude`) starts Billion as `codex --dangerously-bypass-approvals-and-sandbox` in its folder, with the board tools and the folder's trust passed per run, resuming its own Codex session by id after a restart. Codex reads `AGENTS.md`, so the server writes one on every start from the charter and your `CLAUDE.md`, your rules still last and still winning; `CLAUDE.md` is only read.
- **A switch button next to Billion's name.** It writes `HANDOVER.md` (the last 20 messages of the old CLI's conversation, read off its transcript, no model involved), stops Billion, and starts the other CLI in a new conversation that reads `STATE.md` and `HANDOVER.md` first. Waiting mail moves with it; the Waiting tab, Telegram and the board tools keep working. The choice is saved in `~/.agent-007/billion-agent.json` and holds until you change `BILLION_AGENT`. `agent-007 handover` writes the file on demand.
- **The server runs Billion's operating loop, on both CLIs.** It types `Run one operating cycle as defined in CHARTER.md.` into Billion's terminal every 30 minutes, every 3 while one of its cards is In progress or in Review, never mid-turn and never within 2 minutes of you typing there. Billion paces itself with the new `set_next_wake` tool (3–60 minutes) instead of `/loop`, which the charter now tells it not to start.
