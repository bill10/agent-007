---
bump: minor
---
### Added

- **A queued agent message can be withdrawn or replaced before it is delivered.** `send_message` now returns a message id when the recipient is busy. The new `withdraw_message` tool takes a still-queued message back, and `send_message`'s `replaces` swaps new text into the old one's place in the queue, so a worker no longer acts on instructions that events have overtaken (a version bump for a PR that has since merged). Only the sender can touch its own messages; board notices and approval requests are out of reach. Billion's charter mentions both.
