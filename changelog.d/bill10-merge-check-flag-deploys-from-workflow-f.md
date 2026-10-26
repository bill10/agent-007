---
bump: patch
---
### Fixed

- **`merge_check` sees deploys in workflow files the PR itself adds or edits.** It read `.github/workflows` only at the base branch, but a merge runs the workflows as the PR leaves them, so a PR adding a push-to-main deploy workflow came back "no deploy". Changed workflow files are now read at the PR's head (a fork's too), a deleted one drops out, one it cannot read there is unknown, and the result notes which workflow files the PR changes.
