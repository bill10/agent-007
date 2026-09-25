---
bump: patch
---
### Changed

- **Parallel PRs no longer conflict on VERSION and CHANGELOG.md.** A PR now
  adds its release notes as its own file, `changelog.d/<branch-name>.md`, with
  a `bump:` level (`major`, `minor`, `patch` or `micro`) in its front matter,
  and never edits `VERSION`, `package.json`'s version or `CHANGELOG.md`. When
  it merges, the release workflow runs `scripts/release.js`, which picks the
  next version from the fragments, writes `VERSION`, `package.json`,
  `package-lock.json` and the `CHANGELOG.md` section, deletes the fragments and
  commits that to `main`; the tag, GitHub Release and npm publish follow as
  before, with the same npm version mapping. Two or three workers running at
  once used to cost a rebase-and-renumber round trip each. `AGENTS.md` (read
  by Codex, and by Claude Code through `CLAUDE.md`) tells agents to skip
  /ship's version bump and write the fragment instead; CONTRIBUTING.md
  "Releases" has the details. A PR that still bumps `VERSION` by hand is
  released as before.
