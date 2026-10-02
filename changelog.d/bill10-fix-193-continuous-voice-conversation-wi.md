---
bump: minor
---
### Added

- **Talk to Billion: a hands-free voice conversation in the Billion tab.** Tap
  Talk to Billion, allow the mic, and speak: each utterance is detected in the
  browser (Silero VAD, served by the app), transcribed on your machine by
  whisper.cpp and sent once as `[Owner via app, voice]`; Billion's reply to that
  message is spoken by the same `say` voice as Telegram, and it listens again.
  Talk over it to interrupt. Listening, thinking, speaking, muted and
  disconnected states, Mute and End, and the chat thread as the transcript. No
  audio leaves the machine; without whisper.cpp or `say` it falls back to the
  browser's speech, and says so. See docs/BILLION.md, "Talk to Billion".
