# Streams a 16 kHz PCM clip to an ElevenLabs agent over its WebSocket in
# real time, then silence, and reports when the agent's audio arrived.
# usage: python3 -I eleven_agent.py <agent_id> <clip.pcm> <speech_end_s> [pause_from pause_to]
import asyncio, base64, json, os, sys, time, urllib.request
import websockets

agent, clip, speech_end = sys.argv[1], sys.argv[2], float(sys.argv[3])
pause = (float(sys.argv[4]), float(sys.argv[5])) if len(sys.argv) > 5 else None
key = os.environ['ELEVENLABS_API_KEY']
CHUNK = 3200  # 100 ms

def signed_url():
    req = urllib.request.Request(f'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id={agent}', headers={'xi-api-key': key})
    return json.load(urllib.request.urlopen(req))['signed_url']

async def main():
    audio = open(clip, 'rb').read() + b'\0' * (16000 * 2 * 7)
    async with websockets.connect(signed_url(), max_size=None) as ws:
        await ws.send(json.dumps({'type': 'conversation_initiation_client_data'}))
        while True:
            m = json.loads(await ws.recv())
            if m.get('type') == 'conversation_initiation_metadata':
                conv = m['conversation_initiation_metadata_event'].get('conversation_id'); break
        t0 = time.perf_counter()
        events, heard, said = [], [], []
        async def send():
            for i in range(0, len(audio), CHUNK):
                await asyncio.sleep(max(0, t0 + i / 32000 - time.perf_counter()))
                await ws.send(json.dumps({'user_audio_chunk': base64.b64encode(audio[i:i + CHUNK]).decode()}))
        async def recv():
            try:
                while True:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=len(audio) / 32000 + 1))
                    t, k = time.perf_counter() - t0, m.get('type')
                    if k == 'ping':
                        await ws.send(json.dumps({'type': 'pong', 'event_id': m['ping_event']['event_id']}))
                    elif k == 'audio': events.append(('audio', t))
                    elif k == 'interruption': events.append(('interruption', t))
                    elif k == 'user_transcript': heard.append(m['user_transcription_event']['user_transcript']); events.append(('user_transcript', t))
                    elif k == 'agent_response': said.append(m['agent_response_event']['agent_response']); events.append(('agent_response', t))
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                pass
        await asyncio.gather(send(), recv())
    audio_t = [t for k, t in events if k == 'audio']
    bursts = [round(t, 2) for i, t in enumerate(audio_t) if i == 0 or t - audio_t[i - 1] > 0.5]
    print(json.dumps({'conversation': conv, 'bursts': bursts,
                      'first_after_speech_ms': round((audio_t[0] - speech_end) * 1000) if audio_t else None,
                      'spoke_during_pause': bool(pause and any(pause[0] <= t <= pause[1] + 0.3 for t in audio_t)),
                      'events': [(k, round(t, 2)) for k, t in events if k != 'audio'],
                      'heard': heard, 'said': said}))

asyncio.run(main())
