---
bump: patch
---
### Fixed

- **Reconcile an interrupted scheduled run with its active recovery worker.** Billion can use `reconcile_job` for its gone no-PR run without an orphan, preserving its card, partial results, and worktree. The replacement must explicitly name the original card in its instructions. The schedule stays held through recovery Review until a reviewer accepts the recovery and its worker retires. Interrupted and recovery history is excluded from automatic supersession and pruning.
