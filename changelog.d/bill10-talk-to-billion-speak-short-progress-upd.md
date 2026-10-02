---
bump: patch
---
### Added

- **Talk to Billion speaks short progress updates while Billion works.** During a call, while your voice turn waits for its answer, each new `set_status` line is spoken in a few plain words (code, links, paths and file names left out): nothing in the first 3 seconds, at most one every 9 seconds, never the same line twice, and the answer always cuts in ahead of an update. The long silence between your question and the answer now tells you work is happening.
