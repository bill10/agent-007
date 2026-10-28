---
bump: minor
---
### Added

- **A live step log under your message in the Billion tab.** While Billion works on your message, the box under it lists every step, each with its time, and highlights the newest with a running timer ("12 s"), so you can see it is working and what it has found. Each `set_status` adds a step instead of replacing the last, and the tools Billion uses show as plain phrases ("Running a command", "Reading STATE.md", "Checking the job board", "Posting a card"), never a command, its arguments or output, a file's contents, a secret or Billion's reasoning. The log scrolls on its own and folds into the reply's **Work details (N steps)** when Billion answers. Works on a phone and without Telegram; no new setting.
- **Queued versus being worked on, said plainly.** A message still in Billion's queue reads "Waiting for Billion to finish its current step"; one Billion has reads "Billion is working on this" (or, behind an older one, "Billion has this, and is answering your earlier message first"), in place of the old "Waiting to start…".
