---
bump: patch
---
### Fixed

- **On Windows, closing a terminal while input to it is still in flight no longer shuts the server down.** node-pty writes keystrokes through a pipe whose errors nothing handled, and closing the terminal made a pending write fail ("write EAGAIN" or "write EOF"), which exited the whole server. Now that input is dropped and logged, and the other terminals keep running. This was also what intermittently killed the Windows test run with `ERR_IPC_CHANNEL_CLOSED`.
