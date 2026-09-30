---
bump: minor
---
### Added

- **Show Billion a screenshot or a file from the Billion tab.** Paste an image, drop files anywhere on the tab, or pick them with the new paperclip beside the mic; they show as chips above the box and go with the next message (files alone send too). Billion's turn ends with `(attached: <absolute paths>)` so it reads them with its file tools. They are saved owner-only under `~/.agent-007/chat-files/<message id>/` with the job form's limits (10MB a file, 20 files and 50MB a message), and your bubble keeps them as thumbnails and download links, served only from that folder.

### Fixed

- **A screenshot pasted in the Billion tab no longer uploads to whichever agent was last selected.**
