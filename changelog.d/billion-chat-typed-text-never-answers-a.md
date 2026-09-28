---
bump: minor
---
### Fixed

- **Typing in the Billion chat never answers a question you did not pick.** With questions open, a typed line used to be filed as the answer to the oldest one, so ordinary messages closed questions they had nothing to do with. Now it is always a plain message to Billion, like on Telegram; to answer by typing, tap *Reply* under the question (or its chip in the strip) and the box says "Answers Q3". Choice buttons still answer with one tap.

### Added

- **Undo an answer, and `reopen_question`.** *Undo* sits beside "you answered: ..." for a minute: the question opens again and Billion is told the answer no longer stands. After that, Billion puts a wrongly answered question back with its new `reopen_question` board tool (by number or id; nothing is sent to Telegram).
