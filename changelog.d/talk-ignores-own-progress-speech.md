---
bump: patch
---
### Fixed

- **Talk no longer sends its own spoken progress lines as your words.** On speakers, the mic could pick up "Working on your message" and Billion received it as a voice turn. The server now drops a transcript that matches a progress phrase it handed the page in the last 10 seconds.
