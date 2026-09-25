# Agent notes

Read CONTRIBUTING.md. The rule that most often trips an agent:

**Do not bump `VERSION`, `package.json`'s version or `package-lock.json`'s
version, and do not edit `CHANGELOG.md`.** This overrides /ship's version-bump
and CHANGELOG steps: skip them, and add `changelog.d/<branch-name>.md` instead
(front matter `bump: major|minor|patch|micro`, then the release notes; see
`changelog.d/README.md`). Title the PR `<type>: <summary>` with no version
prefix. The release workflow picks the version when the PR merges, so parallel
PRs never conflict on it.
