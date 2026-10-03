---
bump: minor
---
### Added

- **Settings shows the version and an Update button.** The top of the Settings panel names the running version and, when npm has a newer one, offers Update, which runs `agent007 update` in the background (npm install -g, or git pull for a clone), then restarts once busy workers finish. The panel follows it through Updating…, Waiting for busy workers…, Restarting… and the new version, or shows the error from `~/.agent-007/logs/update.log` with the terminal command to run instead. The gear gets a dot while an update is out. The registry is asked at most every 10 minutes; npx copies show no button. Owner only, like the Claude account switch.
