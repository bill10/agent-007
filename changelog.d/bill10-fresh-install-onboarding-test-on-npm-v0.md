---
bump: minor
---
### Fixed

- **A new install's introduction finishes from the chat.** Billion now gives its introduction in the Billion tab's chat (`tell_owner`) rather than only in its hidden terminal. Your answers reach it during the introduction; other mail still waits for `billion_ready`. Before, your reply in the chat waited for a `billion_ready` that was itself waiting for your reply.
- **The Billion tab opens on Chat until the first round.** That is where the introduction happens, and where the chat explains a missing or logged-out Claude Code. A new install used to open on an empty "This round" view. Once a round has been released, the tab opens on This round, and your own choice wins either way.
- **Day one doesn't wait for 08:30.** Until the first round comes due (or you start one early), Billion's questions show as it asks them, under *Open questions*. After that they come in rounds as before.
- **A card that can't open its pull request says why.** The card's CLI having no ship skill now shows on the card, next to the existing no-GitHub-remote note, with the gstack install. Both notes go once the card has its pull request.

### Changed

- The README Quick Start describes what a first run really looks like: the chat, the introduction, logging in to Claude Code, and what a pull-request card needs. Requirements now lists these too.
- doctor's "newer version" line suggests `agent007 update`. The Settings Telegram line says `agent007 init` creates `~/.agent-007/.env`. The start-up line about Codex approvals no longer prints when Codex isn't installed.
