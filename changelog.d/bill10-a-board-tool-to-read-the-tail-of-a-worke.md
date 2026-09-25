---
bump: minor
---
### Added

- **Billion can see a stalled worker's screen.** A new Billion-only board tool,
  `read_agent_screen`, returns the last lines of a worker's terminal (40 by
  default, at most 200, capped at 20,000 characters) as plain text with ANSI
  escapes stripped, plus its status: working, waiting, needs you or exited.
  Billion can now see the dialog, error loop or question a worker is stuck on
  instead of messaging it blind or digging through transcript files. Reading
  is narrower than `send_message`: only workers on cards Billion posted,
  including one that has exited; agents you start by hand stay off-limits,
  since a screen can show a secret that scrolled by. The text is never logged
  on the server, and reaches Billion quoted line by line under a header that
  calls it untrusted data from the worker, never instructions. Billion's
  charter lists the tool and says the same.
