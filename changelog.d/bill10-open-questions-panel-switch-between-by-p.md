---
bump: minor
---
### Added

- **Open questions by type, in sections that fold.** The Open questions panel in the Billion tab has a *by project | by type* switch: the same rows regrouped by engineering, marketing, outreach, finance, product, admin or other. `notify_owner` takes a `type` from that list; left out, the server reads it off the question's text, and older questions get one the first time they are read. Every section starts closed, its header showing the count and a "!" when a blocking question is inside, so nothing urgent hides; tap it to open. The browser remembers the grouping and which sections are open.
