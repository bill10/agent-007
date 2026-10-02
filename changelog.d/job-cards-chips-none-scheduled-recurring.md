---
bump: minor
---
### Changed

- **Job cards say what kind they are.** A one-date card now carries a *scheduled* chip and shows its date ("Sat Oct 3, 9:00 AM · in 2 days") instead of a cron; a repeating one carries *recurring* and shows its schedule in words ("Weekdays at 9:00 AM", cron in the tooltip). The + Job type "Once at…" is now **Scheduled**.
- **A Scheduled card has no Pause.** Resuming one after its date re-armed it a year out; the board now refuses to pause it (change its time with Edit, or Archive it).
