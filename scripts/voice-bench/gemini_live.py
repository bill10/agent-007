# Streams a 16 kHz PCM clip to Gemini Live in real time, then silence, and
# reports when the model's first audio arrived relative to the clip.
# usage: python3 -I gemini_live.py <model> <clip.pcm> <speech_end_s> [silence_ms] [pause_from_s pause_to_s]
import asyncio, base64, json, os, sys, time
import websockets

model, clip, speech_end = sys.argv[1], sys.argv[2], float(sys.argv[3])
silence_ms = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != '-' else None
pause = (float(sys.argv[5]), float(sys.argv[6])) if len(sys.argv) > 6 else None
key = os.environ['GEMINI_API_KEY']
URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
CHUNK = 640  # 20 ms

async def main():
    audio = open(clip, 'rb').read() + b'\0' * (16000 * 2 * 6)  # then 6 s of silence
    setup = {'model': f'models/{model}',
             'generationConfig': {'responseModalities': ['AUDIO']},
             'systemInstruction': {'parts': [{'text': 'You are Billion, a chief of staff on a phone call with your boss. Answer in one short sentence.'}]},
             'inputAudioTranscription': {}, 'outputAudioTranscription': {}}
    if silence_ms:
        setup['realtimeInputConfig'] = {'automaticActivityDetection': {'silenceDurationMs': silence_ms, 'endOfSpeechSensitivity': 'END_SENSITIVITY_LOW'}}
    async with websockets.connect(URL, additional_headers={'x-goog-api-key': key}, max_size=None) as ws:
        await ws.send(json.dumps({'setup': setup}))
        first = json.loads(await ws.recv())
        if 'setupComplete' not in first:
            print('setup failed', first); return
        t0 = time.perf_counter()
        events = []
        async def send():
            for i in range(0, len(audio), CHUNK):
                target = t0 + i / 32000
                await asyncio.sleep(max(0, target - time.perf_counter()))
                await ws.send(json.dumps({'realtimeInput': {'audio': {'data': base64.b64encode(audio[i:i + CHUNK]).decode(), 'mimeType': 'audio/pcm;rate=16000'}}}))
        async def recv():
            heard, said = [], []
            try:
                while True:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=len(audio) / 32000 + 2))
                    t = time.perf_counter() - t0
                    sc = msg.get('serverContent', {})
                    for p in sc.get('modelTurn', {}).get('parts', []):
                        if 'inlineData' in p: events.append(('audio', t))
                    if sc.get('inputTranscription'): heard.append(sc['inputTranscription'].get('text', ''))
                    if sc.get('outputTranscription'): said.append(sc['outputTranscription'].get('text', ''))
                    if sc.get('interrupted'): events.append(('interrupted', t))
                    if sc.get('turnComplete'): events.append(('turnComplete', t))
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                pass
            return ''.join(heard), ''.join(said)
        _, (heard, said) = await asyncio.gather(send(), recv())
    audio_t = [t for k, t in events if k == 'audio']
    first_audio = audio_t[0] if audio_t else None
    during_pause = bool(pause and any(pause[0] <= t <= pause[1] + 0.3 for t in audio_t))
    bursts = [round(t, 2) for i, t in enumerate(audio_t) if i == 0 or t - audio_t[i - 1] > 0.5]
    print(json.dumps({'bursts': bursts, 'events': [(k, round(t, 2)) for k, t in events if k != 'audio'], 'model': model, 'clip': os.path.basename(clip), 'silence_ms': silence_ms,
                      'first_audio_s': round(first_audio, 2) if first_audio else None,
                      'latency_after_speech_ms': round((first_audio - speech_end) * 1000) if first_audio else None,
                      'spoke_during_pause': during_pause,
                      'turns': sum(1 for k, _ in events if k == 'turnComplete'),
                      'interrupted': sum(1 for k, _ in events if k == 'interrupted'),
                      'heard': heard.strip(), 'said': said.strip()}))

asyncio.run(main())
