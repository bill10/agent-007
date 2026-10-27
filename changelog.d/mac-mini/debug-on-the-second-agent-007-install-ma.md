---
bump: patch
---
### Fixed

- **A message you sent Billion survives a restart.** Billion's queue lived only in the server's memory, so a message still waiting when Agent 007 or Billion restarted was never typed in. The Billion tab showed it "queued" for good, and as the oldest message waiting for a reply it took Billion's next reply, leaving every later answer bound one message too early. When Billion starts, the owner's messages still marked queued go back in its queue, oldest first, and Cancel still works on them.
