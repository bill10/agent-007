---
bump: minor
---
### Added

- **Talk to Billion over Telegram, and hear it answer, free and on your own
  machine.** Send the bot a voice note and it is transcribed locally by
  whisper.cpp and typed into Billion's terminal as
  `[Owner via Telegram, voice] <transcript>` (a caption you add is kept).
  Billion's messages to you can come back as voice notes, spoken by macOS
  `say` and encoded with ffmpeg, always with the same text as the caption so
  links stay tappable. Nothing leaves the machine but the Telegram calls
  themselves, and there is no paid transcription. `TELEGRAM_VOICE=mirror` (the
  default) answers in the mode of your last message and remembers it across
  restarts; `always` and `never` fix it. A message over about a minute of
  speech (900 characters), or one that is mostly links, code or paths, always
  goes as text. Without `say` or ffmpeg (Linux, Windows) Billion sends text and
  the log says why once. Until whisper.cpp and a model (`WHISPER_MODEL`) are
  set up, a voice note gets a one-line reply on how to turn it on, and nothing
  reaches Billion. Notes over 5 minutes or 20 MB are refused. Setup is in
  docs/BILLION.md, "Voice". Billion's charter now says a voice transcript is
  the owner's words with possible transcription errors, and to ask back when
  something is ambiguous and risky.
