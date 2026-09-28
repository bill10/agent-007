---
bump: patch
---
### Fixed

- **Closing an agent's session now stops what it left running in the background.** A scratch server an agent started with `&` used to keep its port after the tab closed, because the agent's shell dying hands its children to launchd/init. Now killing a session (closing the tab, filing or retiring a card) sends SIGTERM to every process group under the agent's PTY, including the detached groups Claude Code runs its Bash commands in, and SIGKILL to any left after three seconds. Nothing outside that tree is touched. The server log says how many processes it stopped, and how many groups needed SIGKILL. Windows is unchanged: ConPTY already takes the console's whole tree.
