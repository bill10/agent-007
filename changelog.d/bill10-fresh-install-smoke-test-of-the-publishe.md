---
bump: patch
---
### Fixed

- **The Billion tab says why Billion can't talk yet, with a button to fix it.** On a first run without Claude Code, or with it installed but logged out, the chat used to say "Nothing here yet. Say something to Billion." A message sent to a logged-out Billion then waited, unexplained, for good. A bar above the text box now gives the reason: the CLI is missing (with a Start button), Billion is stopped, or Billion is waiting at its sign-in (with a button that opens its terminal). The bar goes away once Billion is ready.
- **A phone opens on the Billion chat**, as a desktop does, instead of on the office.
- **A job card says "gh is not installed" and where to get it**, instead of `spawn gh ENOENT (tried 1 account: signed-in account)`.
- **Settings lists Claude Code and Codex when they are missing**, each with its install command. An installed CLI with no login folder shows "no login found".
- **+ Agent starts on your only repo.** When you have one repo, the form fills it in. Before, a blank field started the agent in your home folder.
- **"No repos yet" says how to add one**, and a fresh install no longer logs a "Could not pre-trust" error because `~/.claude.json` doesn't exist yet.
