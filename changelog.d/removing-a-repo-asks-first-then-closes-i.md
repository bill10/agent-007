---
bump: minor
---
### Changed

- **Removing a repo now asks first, then closes its agents and deletes their worktrees.** The × on a repo's header opens a dialog naming the agents that will close, and warning about any with uncommitted changes or unpushed commits ("Raven has 3 unpushed commits; they will be lost."). Cancel is the default. On confirm, every agent of the repo is closed with nothing kept, its orphans and their worktrees and local branches are deleted, and every browser clears the tabs, office figures and left panel. The repo folder on disk is never touched, nor is Billion's own folder. A card In progress in that repo goes back to To do with the note "repo removed from Agent 007". A repo that is not on the list (a hand-edited config) still shows its orphans, labelled "· not on the board".
