---
bump: minor
---
### Changed

- **Each board worker gets the GitHub account that owns its repo, and nobody switches gh's account any more.** With several gh accounts signed in, a board worker in a github.com repo now gets `GH_TOKEN` for the account that can see it (the one named like the repo's owner, else the first that can read it, remembered per repo and re-checked at each spawn), and `git push` uses the same account through gh's credential helper. Before, the card prompt told workers to `gh auth switch`, which flipped the active account for the whole machine under the owner and every other agent. Claude Code workers are now denied `gh auth switch`, `login` and `logout`, every card prompt says never to run them, and Billion's charter says to pick the account per command with `GH_TOKEN=$(gh auth token -u <account>) gh …`.
