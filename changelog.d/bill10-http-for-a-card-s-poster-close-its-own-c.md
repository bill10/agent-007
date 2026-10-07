---
bump: minor
---
### Added

- **A card's poster can close it and message its worker over HTTP.** `POST /api/jobs/:id/close` (`{accept, note}`) and `POST /api/jobs/:id/message` (`{message}`) are open to whoever posted the card through `POST /api/jobs` or `post_job`, so a headless poller with Billion off can file its finished card as Done, send it back, or type a change request into the same worker. `GET /api/jobs/:id` tells it the card's state and whether its worker is still alive; a message to a card with none answers 409. Anyone else gets 403. Close is the same code as Billion's `close_job`, and messages go through `send_message`'s queue, length cap and rate limit. See README, "Job board HTTP API".
