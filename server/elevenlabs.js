// ElevenLabs streaming text-to-speech for "Talk to Billion" (server/talk.js,
// docs/BILLION.md "Talk to Billion"). On when ELEVENLABS_API_KEY is set (in
// ~/.agent-007/.env); the reply's text goes to ElevenLabs and MP3 comes back
// as it is made, so the page starts playing after the first few hundred
// milliseconds. The key only ever travels in the xi-api-key header: it is
// never logged, never put in an error, never sent to the page.

const API = 'https://api.elevenlabs.io/v1';
// Flash is ElevenLabs' lowest-latency model (~75 ms model time).
export const DEFAULT_MODEL = 'eleven_flash_v2_5';
export const DEFAULT_VOICE = 'Eric';
// The premade voices' ids are the same on every account.
const PREMADE = { eric: 'cjVigY5qzO86Huf0OWal' };
const VOICE_ID_RE = /^[A-Za-z0-9]{20}$/;
export const FORMAT = 'mp3_44100_64';
export const MIME = 'audio/mpeg';
const TIMEOUT_MS = 15_000;

// { key, voice, model } when ElevenLabs is set up, else null.
export function elevenSetup(env = process.env) {
  const key = (env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return null;
  return {
    key,
    voice: (env.ELEVENLABS_VOICE || '').trim() || DEFAULT_VOICE,
    model: (env.ELEVENLABS_MODEL || '').trim() || DEFAULT_MODEL,
  };
}

// ELEVENLABS_VOICE is a voice id or a name from the account's voice list
// ("Eric" matches "Eric - Smooth, Trustworthy"). Looked up once per name; a
// name that is not there falls back to Eric, and the log says so once. A
// lookup that failed (network, a 5xx) speaks with Eric this time and is
// tried again next time.
const ids = new Map();   // name -> Promise<id>
export function voiceId(setup, fetchImpl = fetch) {
  const wanted = setup.voice;
  if (VOICE_ID_RE.test(wanted)) return Promise.resolve(wanted);
  const name = wanted.toLowerCase();
  if (!ids.has(name)) {
    const found = fetchImpl(`${API}/voices`, { headers: { 'xi-api-key': setup.key }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`voices HTTP ${res.status}`))))
      .then(({ voices = [] }) => {
        const id = voices.find(v => {
          const n = String(v.name || '').toLowerCase();
          return n === name || n.startsWith(`${name} `);
        })?.voice_id;
        if (id) return id;
        if (PREMADE[name]) return PREMADE[name];
        console.log(`  Talk: ElevenLabs voice "${wanted}" is not on this account; using ${DEFAULT_VOICE}.`);
        return PREMADE.eric;
      }, () => {
        ids.delete(name);
        return PREMADE[name] || PREMADE.eric;
      });
    ids.set(name, found);
  }
  return ids.get(name);
}

// text → MP3 chunks (Buffers) as ElevenLabs makes them. Throws, before the
// first chunk, with a short reason that never holds the key.
export async function* elevenStream(text, setup, { fetchImpl = fetch, signal } = {}) {
  const voice = await voiceId(setup, fetchImpl);
  const res = await fetchImpl(`${API}/text-to-speech/${voice}/stream?output_format=${FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': setup.key, 'Content-Type': 'application/json', Accept: MIME },
    body: JSON.stringify({ text, model_id: setup.model }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.json().then(j => j?.detail?.status || j?.detail?.message || '').catch(() => '');
    throw new Error(`ElevenLabs HTTP ${res.status}${detail ? ` (${String(detail).slice(0, 80)})` : ''}`);
  }
  for await (const chunk of res.body) yield Buffer.from(chunk);
}

// For the tests.
export function _resetEleven() { ids.clear(); }
