---
bump: minor
---
### Added

- **Slash commands from the Billion chat.** A message starting with `/` (say `/model opus`) is typed bare into Billion's terminal at its next prompt, so it runs on whichever CLI Billion uses; the thread marks it *Command*, waits for no reply, and shows Billion's screen a few seconds later. A picker it opens (a bare `/model`) is shown and closed, so give the argument. `//` sends a literal `/` message. Works from your private Telegram chat too, never from a group or an agent.
