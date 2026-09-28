---
bump: patch
---
### Fixed

- **On Windows, a keystroke that cannot reach a terminal no longer shuts the server down.** node-pty sends input through a pipe whose errors nothing handled, so a write that failed later ("write EAGAIN", when the pipe is full or its console is closing) exited the whole server. Now the input is dropped and logged, and the other terminals keep running. This was also what intermittently killed the Windows test run with `ERR_IPC_CHANNEL_CLOSED`.
