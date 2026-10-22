# voice-bench

The turn-taking and latency test behind docs/voice-calls-plan.md
("Turn-taking and latency"). Each script streams a clip to a voice agent in
real time from this machine, then silence, and prints one JSON line: when
the agent's audio bursts began (seconds from the clip's start), the first
audio's delay after speech ended, whether it spoke during the pause, its
interruption and turn events, and what it heard and said.

    pip install websockets                      # Python 3.10+
    scripts/voice-bench/make-clips.sh /tmp/vb   # latency.pcm, pause.pcm (macOS say + ffmpeg)

    # Gemini Live (GEMINI_API_KEY). Args: model clip speech_end [silence_ms|-] [pause_from pause_to]
    python3 -I scripts/voice-bench/gemini_live.py gemini-3.8-live /tmp/vb/latency.pcm 2.53
    python3 -I scripts/voice-bench/gemini_live.py gemini-3.8-live /tmp/vb/pause.pcm 6.55 - 2.31 3.84
    python3 -I scripts/voice-bench/gemini_live.py gemini-3.8-live /tmp/vb/pause.pcm 6.55 2000 2.31 3.84

    # ElevenLabs Agents (ELEVENLABS_API_KEY with the Agents permission). Args: agent_id clip speech_end [pause_from pause_to]
    python3 -I scripts/voice-bench/eleven_agent.py <agent_id> /tmp/vb/pause.pcm 6.55 2.31 3.84

`gemini_live.py` produced the Gemini rows on 2026-10-22. `eleven_agent.py`
has not run yet: the key we had could only do text-to-speech. It follows
ElevenLabs' WebSocket docs (signed URL, `user_audio_chunk`, ping/pong), so
expect to fix small things on its first run. Each run costs well under a
cent (Gemini) or about 15 seconds of agent time (ElevenLabs).
