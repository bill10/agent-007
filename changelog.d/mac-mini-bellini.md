---
bump: minor
---
### Added

- **Rotate through selected Claude accounts at usage limits.** Settings now supports discovery, account order, inclusion, automatic rotation, manual switching, and optional Codex fallback. Refreshed credentials and cooldowns persist; Claude conversations resume by exact session ID while settings and history stay in place. Failed and interrupted switches have a recovery path. Rotation turns on by default once two accounts are added, while preserving saved off settings.

### Changed

- **Preserve more conversation context between Claude and Codex.** Billion's handover includes recent tool calls and results alongside dialogue, labels truncation, and points to the original transcript. A failed handover write now prevents the CLI switch. Billion's existing Git directory continues to hold its state and pending work.
