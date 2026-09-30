---
bump: micro
---
### Fixed

- **The Billion tab's text box, mic and Send are one height.** They were 31px, 40px and 25px on desktop; all three, and the "Read new messages aloud" toggle and voice picker above the thread, now share one control-height token (40px, 44px on phones) and one gap. A multi-line message grows the box while mic and Send stay by its last line, the mic's icon matches the header icons' line weight, and on a phone the voice picker gets its own full-width line.
