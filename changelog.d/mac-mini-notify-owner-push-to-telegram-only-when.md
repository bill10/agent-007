---
bump: minor
---
### Changed

- **Only blocking questions buzz the owner's phone.** `notify_owner` used to push every question to Telegram; now only `urgency: "blocking"` ones go there, and normal and low questions wait in the Billion tab (thread, open-questions strip, badge) without buzzing the phone. A new optional `telegram` flag overrides it: `true` pushes a non-blocking question Billion judges super urgent, `false` keeps even a blocking one in the tab. The tool result says which happened ("Put in the owner's Billion tab as Q12; not sent to Telegram (urgency normal)"). `tell_owner` is unchanged.
