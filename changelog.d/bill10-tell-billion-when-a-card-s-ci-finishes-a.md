---
bump: minor
---
### Added

- **Billion hears when CI finishes on its cards, and merged cards leave the
  board within a minute.** Every Review card with a pull request is now checked
  every 60 seconds with `gh pr view`, through the same GitHub accounts the
  board already uses to find PRs. No webhooks, so it works on a laptop behind
  NAT. When every check on the PR's latest commit has finished, a card Billion
  posted sends it `[Job board] CI finished on "<title>" (card <id>, PR #n):
  all passed`, or `failed: <check names>`. It comes once per commit, and again
  after a new push or a re-run of a failed job. Billion's charter now says to
  merge on that notice after its diff review, instead of running
  `gh pr checks --watch`, and to re-run a job that failed for a reason
  unrelated to the change (a known flaky test) before sending the card back. A PR found merged or
  closed is filed on that same check, instead of waiting up to 5 minutes for
  the next board scan. Its worker and worktree are released under the same
  rules as before. A PR that can't be read is checked less and less often, down
  to once every 15 minutes. The checks run only while the board is started.

### Fixed

- **Stopping the board during a scan no longer leaves a second scan loop
  running.** A scan that was still in progress when the dispatcher stopped
  scheduled its next run anyway.
