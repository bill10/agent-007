---
bump: minor
---
### Added

- **Billion checks whether a merge deploys before it merges, and asks you first.** A revert undoes a merge but not a deploy it set off. The new Billion-only board tool `merge_check` reads the repo's `.github/workflows` at the PR's base branch (read-only) and reports which workflows the merge runs (push with matching branch and path filters, `pull_request` closed, `workflow_run` chains, tag workflows only when something makes a tag) and which jobs deploy (an `environment:`, deploy/release/publish job names, known deploy actions, `docker push`, `npm publish`, `vercel`, `netlify`, `fly deploy`, `gh release create`), with anything it could not read listed as unknown rather than "no deploy". Billion's charter now runs it before every merge and asks you with `notify_owner` when it says to. Per repo, the Jobs tab's *deploy merges* control (or `jobBoard.deployMergePolicy` in `config.json`) sets ask (default), never ask, or ask for production only. (#192)
