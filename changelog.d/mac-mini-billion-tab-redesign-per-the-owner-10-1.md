---
bump: minor
---
### Added

- **Billion comes to you twice a day, two questions per department.** `notify_owner` now queues a question under its project instead of showing it at once. At each round (08:30 and 15:30 your time by default; `rounds`, `roundMaxPerProject` and `roundsTimeZone` in `~/.agent-007/config.json`, `rounds: []` for the old behaviour) the server shows at most two per project, most important first, with Billion's brief on top and one Telegram message for the whole round. Whatever the previous round left unanswered is consolidated into *Earlier*, and Billion is told so it re-asks only what is still in a project's top two. Only a blocking question (or `telegram: true`) reaches you between rounds. New Billion tools: `list_round_queue`, `drop_queued`, `set_round_brief`, `set_status`, and `rank` on `notify_owner`.
- **The Billion tab opens on This round.** One section per project with its cards (tap a choice or type a reply; answered cards fold where they stand; "3 of 7 done"), nothing jumping while you read or type, and the chat thread moved to a **Chat** view beside it.
- **A status line on the Billion tab.** "Working: reviewing PR #120 · 3 workers running · next round 3:30 pm", and "Billion is working on your message…" from the moment you write until it replies.

### Changed

- **On the first start, open questions are consolidated.** Every open question except blocking ones moves to *Earlier*, and Billion is told which, so you start from a clean round. Restart with `node bin/agent-007.js` to pick this up.
