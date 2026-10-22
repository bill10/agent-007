---
bump: micro
---
### Added

- **A plan for Billion phone calls** (docs/voice-calls-plan.md). It researches how Billion could call the owner's phone and hold a natural conversation, and recommends ElevenLabs Agents with a Twilio number, at about $0.10 a minute plus $1.15 a month. It covers how calls plug into briefings, questions and the chat, the safety rules (one number only, no secrets read aloud), a proof of concept and the candidate voices. It also has measured turn-taking and latency (Gemini Live cuts in on a 1.5-second pause and needs 1.3 seconds to answer) and a plan to fix the in-app Talk to Billion. That fix keeps a turn open through pauses, folds in what the owner adds, and acknowledges him at once. It is a plan only: nothing is built or bought yet.
- **`scripts/voice-bench/`**: the test that measures how fast a voice agent answers and whether it cuts in when the owner pauses mid-sentence.
