---
bump: minor
---
### Changed

- **Talk to Billion sounds like a person, waits for you to finish, and answers at once.** With `ELEVENLABS_API_KEY` in `~/.agent-007/.env`, replies are spoken by ElevenLabs (voice Eric, the Flash model; `ELEVENLABS_VOICE` and `ELEVENLABS_MODEL` change them) and play as they stream in; without it, `say` as before. A turn now ends only after a real pause (about 1.2 s after a finished sentence, 1.5 s usually, 2.6 s after an unfinished phrase like "...and the"), and words you add before Billion answers join the same turn instead of making a second one. The moment a turn ends, a short acknowledgment ("Got it, one sec.", never the same twice in a row) plays while Billion works on the reply. Speaking over Billion ducks it at once and stops it a few frames in. See docs/BILLION.md "Talk to Billion".
