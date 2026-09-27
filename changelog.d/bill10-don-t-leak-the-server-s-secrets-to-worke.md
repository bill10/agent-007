---
bump: patch
---
### Security

- **Agents no longer see Agent 007's own settings.** Every agent the app starts used to inherit the server's whole environment, including what `~/.agent-007/.env` sets, so any worker (and anything it ran) could read `TELEGRAM_BOT_TOKEN`. Every setting `.env.example` documents (the Telegram token and chat, voice and Whisper settings, `PORT`, `HOST`, `BILLION_*`, the `AGENT007_*` paths and the rest) is now taken out of an agent's environment. What your own shell sets, such as `HOME`, `PATH`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and proxies, still passes through.

### Fixed

- **Board workers no longer run Claude Code channel plugins.** A worker whose repo had the Telegram channel plugin installed polled Billion's bot, so your replies could go to the worker instead of Billion. Claude Code board workers, fresh or re-spawned, now start with the official channel plugins (telegram, discord, imessage, fakechat) turned off. Agents you start by hand are unchanged.
- **The Models line in the server log is said once.** It is logged again only when the source or the list of Codex models changes, and each distinct discovery error once.
