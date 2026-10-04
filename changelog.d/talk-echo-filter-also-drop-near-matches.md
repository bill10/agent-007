---
bump: patch
---
### Fixed

- **Talk to Billion no longer answers a mishearing of its own progress line.** "Working on your best" (whisper's take on the spoken "Working on your message") was sent as a voice turn. A short transcript that mostly overlaps a progress phrase spoken in the last 10 seconds is now dropped as echo; real short turns like "stop" still go through.
