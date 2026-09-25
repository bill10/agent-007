---
bump: patch
---
### Fixed

- **A long agent message is acted on, not questioned.** Claude Code turned any message over a few hundred characters into "pasted content", which it treats as maybe not from the user, so a worker handed a long coordination message from Billion asked whether to act on it and waited. Messages, board notices and approval requests now go in as a series of short bracketed pastes, a line or less each, and arrive as an ordinary typed turn. The sender header, the quoted body and the text itself are unchanged.
