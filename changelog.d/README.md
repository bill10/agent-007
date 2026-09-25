# changelog.d

Each PR adds one file here, `changelog.d/<branch-name>.md`, and never edits
`VERSION`, `package.json`'s version or `CHANGELOG.md`:

```markdown
---
bump: patch
---
### Added

- **What changed, in bold.** Why it matters and how to use it.
```

`bump` is `major`, `minor`, `patch` or `micro`. On merge, the release workflow
turns every fragment into the next version's CHANGELOG section, then tags,
releases and publishes it. See CONTRIBUTING.md "Releases".
