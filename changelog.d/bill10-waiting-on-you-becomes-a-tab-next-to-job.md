---
bump: minor
---
### Added

- **Answer Billion's questions in the app.** Each open question in *Waiting on you* is a card with its choice buttons (the recommended one marked) and a reply line; a click or Send types `[Owner via app] Q3: <answer>` into Billion's terminal, with the start of the question for context. If Billion is not running the card says so and stays open. Answered questions fold into a collapsed Answered section.
- **Choices for `notify_owner`.** Billion can pass 2 to 5 short `choices` and mark one `recommended`; every question gets a short number (Q1, Q2 …). On Telegram the choices are buttons, and a text reply to a question's message answers that question; both reach Billion as `[Owner via Telegram] Q3: …`, and the message is edited to show the answer (or "Answered in app: …").

### Changed

- **Waiting on you is its own tab next to Jobs**, with a bell and a count of open questions, and a *Waiting* button in the phone's bottom bar. It used to be a list under Billion's row in the file explorer, which is easy to miss and hidden on phones. `waiting.json` written by earlier versions still loads.
