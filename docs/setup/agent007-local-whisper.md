# Agent007 local Whisper setup receipt

Verified 2026-10-02 on the owner's Mac. Reused Homebrew whisper.cpp **1.9.4**;
no installation, upgrade, model download, paid call, or source change was needed.

Durable supported settings in `/Users/samslung/.agent-007/.env`:

```dotenv
WHISPER_CPP_BIN=/opt/homebrew/bin/whisper-cli
WHISPER_MODEL=/Users/samslung/.cache/hyperframes/whisper/models/ggml-small.en.bin
```

The existing small.en English model (487,614,201 bytes) was selected for reasonable
local latency. Its validity was confirmed by successful inference. Both keys were
previously absent. Appending them preserved every previous byte, ownership, and
permissions (`0600`). Neither repository's `.env` was changed. Agent007 loads the
shared file at startup; existing environment and repository settings take precedence.

## Verification

- Homebrew reports `whisper.cpp 1.9.4`; the absolute CLI symlink resolves to that
  installed version. ffmpeg is available at `/opt/homebrew/bin/ffmpeg`.
- A fresh Node process in `/Users/samslung/Projects/agent-007` called the supported
  `server/settings.js:loadSettings()`, then `server/voice.js:whisperSetup()`.
  It resolved the configured CLI and model without missing dependencies.
- macOS `say -v Samantha -r 160 -o <temporary AIFF>` generated the known phrase
  **“The quick brown fox jumps over the lazy dog.”** directly to a file, without
  speaker playback or microphone recording.
- That AIFF's bytes passed through the installed checkout's real
  `server/voice.js:transcribe()`: ffmpeg conversion to 16 kHz mono PCM, then
  whisper-cli with `-m MODEL -f WAV -nt -np`. Actual transcript:
  **“The quick brown fox jumps over the lazy dog.”** Words matched exactly after
  case/punctuation normalization; transcription took **1,286 ms**. Temporary
  fixture and conversion files were removed.
- Fresh settings-loaded `server/talk.js:talkSetup()` returned
  `{"stt":"whisper","tts":"say"}`. The worktree's settings loader independently
  resolved the same valid Whisper setup.

## Live activation

The existing server (PID 27836, port 7007, working directory
`/Users/samslung/Projects/agent-007`) returned **HTTP 404** for
`GET /api/talk` with `X-Agent007-Talk: 1`. Fresh-process readiness does not establish
readiness of that already running process. Settings load at startup; no supported
runtime settings reload was found. No restart, signal, or session interruption
was performed because board workers are active.

Billion was notified through the board (message `msg-195`): coordinate a safe
restart preserving workers and sessions, then verify:

```bash
curl --silent --show-error -H 'X-Agent007-Talk: 1' http://127.0.0.1:7007/api/talk
```

Expected response includes `"stt":"whisper"`. Do not force a restart with
`--now`. Live activation remains pending; no transcription HTTP POST was sent
because that route delivers an owner message to Billion.

No Telegram or owner message, browser interaction, or microphone recording was
performed. No existing local `LawsonBillMacMini/Agent007` folder was found in the
home/project/document/desktop directory inspection, so this committed receipt is
the owner artifact rather than creating a new unrelated folder.
