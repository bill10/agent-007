---
bump: patch
---
### Fixed

- **A finished card's worktree is released once its work is on main, even after a squash merge.** A worktree counted as "unpushed" whenever its branch had commits the local base branch lacked, so every squash-merged PR (its commits never land on main as-is, and its remote branch is deleted) and every run that branched from a newer `origin/main` than the local `main` was kept as an orphan. Now a branch is "unpushed" only when it has commits that are on neither its remote branch nor `origin/<base>`, unless every file it changed has since held exactly the branch's version on the base branch (what a squash or rebase merge leaves, compared by blob id, so an edit that differs only in whitespace still counts as unpushed). `origin/<base>` is fetched before that file test, and a failed fetch keeps the branch. Uncommitted files still keep the worktree, and so does anything git cannot decide. The startup pass re-checks existing "unpushed" orphans of finished cards under the new rule and releases those whose work is on main.

### Added

- **`agent007 doctor` lists stale orphans.** A new "Stale orphans" check (under Repos) names each orphaned worktree that is clean, whose work is already on the base branch and that no open card may re-adopt, with how to remove it: its delete button in the Explorer, or a restart for an "unpushed" one. Report only, from local refs, as the rest of doctor.
