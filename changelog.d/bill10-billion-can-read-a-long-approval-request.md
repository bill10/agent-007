---
bump: minor
---
### Added

- **Billion can read a long approval request in full with `read_approval`.** A worker's permission request with long input (a multi-line script, a file write) is typed into Billion's terminal cut short, so an allow on it used to go to the owner. Billion can now read the whole request (tool, full input, worker, card, time left), quoted under the untrusted-data banner, and once it has, its allow stands. Requests over 20 KB (as quoted, in UTF-8 bytes, so the reply stays under Claude Code's MCP output cap) still go to the owner on allow.
