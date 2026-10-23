// "Talk to Billion": the Billion tab's hands-free voice conversation
// (docs/BILLION.md, "Talk to Billion"; the page is public/modules/talk.js).
// Voice only turns audio into an owner message and Billion's tell_owner reply
// into audio; Billion stays the only brain. The owner's audio stays on this
// machine: each stretch of speech is transcribed by whisper.cpp, the same
// tool and limits as Telegram voice (server/voice.js). Replies are spoken by
// ElevenLabs, streamed as they are made, when ELEVENLABS_API_KEY is set
// (server/elevenlabs.js: only the reply's text goes there), else by `say`.
//
// The page gathers a turn from one or more stretches of speech (segments,
// transcribed here as they end, sent nowhere), then sends the whole turn once:
// a [Owner via app, voice] turn through ownerSays, keyed by the id the page
// gave it, so a retry is the message already sent, never a second one. Words
// the owner adds before the reply continue that turn (ownerSays' continues).
// Audio is served only for a tell_owner reply bound (replyTo) to one of these
// voice turns, a short acknowledgment from ACKS, or a progress line: never a
// question, a server notice or terminal output.

import { whisperSetup, transcribe, speechUnavailable, synthesize, MAX_NOTE_SECONDS } from './voice.js';
import { elevenSetup, elevenStream, MIME as ELEVEN_MIME } from './elevenlabs.js';
import { chatMessages, ownerSays, byUtterance } from './owner.js';
import { CONFIG_DIR } from './state.js';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { plainForSpeech, chunkForSpeech, progressSpeech } from '../public/modules/readaloud.js';
import { statusPayload } from './billion-status.js';

// The page sends 16 kHz 16-bit mono WAV: Telegram's five minutes of it.
export const MAX_UTTERANCE_BYTES = MAX_NOTE_SECONDS * 16000 * 2 + 44;
// Pieces of a reply spoken one at a time, so playback starts after the first
// sentence and an interruption drops the rest.
export const SPEECH_CHUNK_CHARS = 300;
// Segments a minute: a turn with pauses in it is several.
export const UTTERANCE_LIMIT = 60;
export const AUDIO_LIMIT = 120;         // audio pieces a minute
const WINDOW_MS = 60 * 1000;
const CACHE_PIECES = 24;

const ID_RE = /^[\w-]{8,64}$/;
export const validUtterance = (id) => typeof id === 'string' && ID_RE.test(id);

const recent = { utterance: [], audio: [] };
// false when this kind has had its fill for the minute.
function allow(kind, limit, now = Date.now()) {
  recent[kind] = recent[kind].filter(t => now - t < WINDOW_MS);
  if (recent[kind].length >= limit) return false;
  recent[kind].push(now);
  return true;
}

// What the page says the moment a turn ends, while Billion works on the
// reply: short, varied (the page never picks the same one twice in a row),
// and made once per voice (kept on disk for ElevenLabs). The page gets their
// words from talkSetup, their audio as reply id `ack-<n>`.
export const ACKS = [
  'Got it, one sec.',
  'Okay, let me check.',
  'Sure, give me a moment.',
  'On it.',
  'Mm-hm, one moment.',
  'Alright, checking now.',
  'Okay, looking into it.',
  'Give me a second.',
];
const ACK_RE = /^ack-(\d+)$/;
const ackPhrase = (id) => ACKS[Number(ACK_RE.exec(id ?? '')?.[1] ?? -1)] ?? null;

// What the page can use: whisper.cpp here (stt), and ElevenLabs or `say` here
// (tts), or why not.
export function talkSetup(env = process.env, platform = process.platform) {
  const whisper = whisperSetup(env);
  const eleven = elevenSetup(env);
  const speech = eleven ? null : speechUnavailable(env, platform);
  return {
    stt: whisper.missing ? null : 'whisper',
    ...(whisper.missing ? { sttMissing: whisper.missing.replace(/; send text instead\.$/, '.').replace(/^Voice notes need/, 'Talking needs') } : {}),
    tts: eleven ? 'elevenlabs' : speech ? null : 'say',
    ...(eleven ? { voice: eleven.voice } : {}),
    ...(speech ? { ttsMissing: speech } : {}),
    acks: ACKS,
  };
}

const words = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
export const ECHO_RUN_WORDS = 6;

// Billion's own reply picked up by the mic: what was heard holds a run of at
// least six of the reply's words in its order. Shorter echoes ("merge PR 196
// now" said back to confirm) count as the owner: losing a real turn is worse
// than Billion answering a stray fragment of itself.
export function looksLikeEcho(heard, spoken) {
  const said = words(spoken), got = words(heard);
  let best = 0;
  // ponytail: O(n·m) longest common run; both are a few hundred words at most.
  for (let i = 0; i < got.length; i++) {
    for (let j = 0; j < said.length; j++) {
      let n = 0;
      while (got[i + n] !== undefined && got[i + n] === said[j + n]) n++;
      if (n > best) best = n;
    }
  }
  return best >= ECHO_RUN_WORDS;
}

// The reply a voice turn may hear: Billion's tell_owner answer bound to an
// app voice message. The message, or null.
function voiceReply(id) {
  const messages = chatMessages();
  const reply = messages.find(m => m.id === id && m.from === 'billion' && m.replyTo && !m.notice && !m.q);
  if (!reply) return null;
  return messages.some(m => m.id === reply.replyTo && m.from === 'owner' && m.via === 'app' && m.voice) ? reply : null;
}

export const speechPieces = (text) => chunkForSpeech(plainForSpeech(text), SPEECH_CHUNK_CHARS);

// Whether what was heard is what was playing when the owner started
// speaking: the reply (six of its words in order), or the acknowledgment
// (all of it, or a run of two or more of its words, never a sentence of the
// owner's that only shares some: "no, give me a second" is theirs).
function heardPlaying(text, echoOf) {
  const ack = ackPhrase(echoOf);
  if (ack) {
    const got = words(text).join(' '), phrase = words(ack).join(' ');
    return !!got && (got === phrase || (got.includes(' ') && phrase.includes(got)));
  }
  const playing = typeof echoOf === 'string' && voiceReply(echoOf);
  return !!playing && looksLikeEcho(text, plainForSpeech(playing.text));
}

// Whether a whole turn is the page's own voice: what was playing, or a
// progress phrase said lately.
function ownVoice(text, echoOf, now) {
  if (heardPlaying(text, echoOf)) return true;
  if (heardProgress(text, now)) {
    console.log('Talk: dropped speech that was the page\'s own progress phrase.');
    return true;
  }
  return false;
}

// One whole turn in: { ok, id, duplicate?, merged? }, { ok, echo } when it
// was Billion's own voice (nothing sent), or { error }. echoOf: what was
// playing when the owner started speaking. continues: the turn of this
// conversation still waiting for its reply, which these words add to.
export async function voiceSays(transcript, { utterance, echoOf, continues, broadcast, env = process.env, now = Date.now() } = {}) {
  if (!validUtterance(utterance)) return { error: 'Bad utterance id.' };
  const text = typeof transcript === 'string' ? transcript.replace(/\s+/g, ' ').trim() : '';
  if (!text) return { error: 'No words were heard.', empty: true };
  if (ownVoice(text, echoOf, now)) return { ok: true, echo: true };
  return ownerSays(text, { voice: true, utterance, continues: typeof continues === 'string' ? continues : undefined, broadcast, env });
}

// Progress phrases handed to the page lately: the mic hears them too, and they
// carry no echo id. A transcript that is one of them (or, at two words or
// more, part of one) is the page's own voice, and so is a short one that is
// mostly their words: whisper mishears "message" as "best".
const PROGRESS_ECHO_MS = 10_000;
const progressSpoken = [];   // { at, words }
// heard is phrase (its words, space-joined), part of it, or mostly its words.
const soundsLike = (heard, phrase) => {
  const w = words(heard), got = w.join(' ');
  // ponytail: word-set overlap, no ordering; swap for edit distance if it drops real turns.
  const mostly = w.length > 1 && w.length <= 8 && w.filter(x => phrase.split(' ').includes(x)).length >= 0.6 * w.length;
  return !!got && (got === phrase || (got.includes(' ') && phrase.includes(got)) || mostly);
};
const heardProgress = (text, now) => {
  while (progressSpoken.length && now - progressSpoken[0].at > PROGRESS_ECHO_MS) progressSpoken.shift();
  return progressSpoken.some(p => soundsLike(text, p.words));
};

// An utterance retried while its first try is still being transcribed waits
// for that one: one transcription, one message.
const inflight = new Map();

// One stretch of the owner's speech (WAV bytes) → { text, transcribeMs },
// { text: '', echo: true } when it was what was playing as it began, or { error }.
// Nothing reaches Billion: the page sends the whole turn (voiceSays) once the
// owner has finished. A retry while it is transcribed waits for that one.
export function voiceSegment(audio, { segment, echoOf, env = process.env, now = Date.now() } = {}) {
  if (!validUtterance(segment)) return Promise.resolve({ error: 'Bad segment id.' });
  const key = `segment:${segment}`;
  if (inflight.has(key)) return inflight.get(key);
  if (!Buffer.isBuffer(audio) || !audio.length) return Promise.resolve({ error: 'No audio arrived.' });
  if (audio.length > MAX_UTTERANCE_BYTES) return Promise.resolve({ error: `An utterance can be up to ${MAX_NOTE_SECONDS / 60} minutes.` });
  const setup = whisperSetup(env);
  if (setup.missing) return Promise.resolve({ error: talkSetup(env).sttMissing, noWhisper: true });
  if (!allow('utterance', UTTERANCE_LIMIT, now)) return Promise.resolve({ error: 'Too many utterances this minute; wait a moment.' });
  const job = (async () => {
    const started = Date.now();
    let text;
    try { text = (await transcribe(audio, setup)).replace(/\s+/g, ' ').trim(); } catch (err) {
      console.error('Talk: could not transcribe speech:', err.message);
      return { error: 'Could not transcribe that; say it again.' };
    }
    const transcribeMs = Date.now() - started;
    // Only what was playing when this stretch began: a fragment of the
    // owner's own turn can share words with a progress phrase, so those are
    // checked on the whole turn (voiceSays).
    if (text && heardPlaying(text, echoOf)) return { text: '', echo: true, transcribeMs };
    return { text, transcribeMs };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// The page's recorded utterance (WAV bytes) → voiceSays's result, plus the transcript.
export function voiceUtterance(audio, { utterance, echoOf, broadcast, env = process.env, now = Date.now() } = {}) {
  if (!validUtterance(utterance)) return Promise.resolve({ error: 'Bad utterance id.' });
  const sent = byUtterance(utterance);
  if (sent) return Promise.resolve({ ok: true, id: sent.id, duplicate: true, transcript: sent.text });
  if (inflight.has(utterance)) return inflight.get(utterance);
  if (!Buffer.isBuffer(audio) || !audio.length) return Promise.resolve({ error: 'No audio arrived.' });
  if (audio.length > MAX_UTTERANCE_BYTES) return Promise.resolve({ error: `An utterance can be up to ${MAX_NOTE_SECONDS / 60} minutes.` });
  const setup = whisperSetup(env);
  if (setup.missing) return Promise.resolve({ error: talkSetup(env).sttMissing, noWhisper: true });
  if (!allow('utterance', UTTERANCE_LIMIT, now)) return Promise.resolve({ error: 'Too many utterances this minute; wait a moment.' });
  // Never rejects: the route awaits it, and Express 4 would not catch a rejection.
  const job = (async () => {
    const started = Date.now();
    let transcript;
    try { transcript = await transcribe(audio, setup); } catch (err) {
      console.error('Talk: could not transcribe an utterance:', err.message);
      return { error: 'Could not transcribe that; say it again.' };
    }
    const transcribeMs = Date.now() - started;
    try {
      return { ...await voiceSays(transcript, { utterance, echoOf, broadcast, env, now }), transcript, transcribeMs };
    } catch (err) {
      console.error('Talk: could not send an utterance:', err.message);
      return { error: 'Could not send that to Billion; say it again.' };
    }
  })().finally(() => inflight.delete(utterance));
  inflight.set(utterance, job);
  return job;
}

// One piece of audio, made once: { type, first, read() }. read() yields its
// chunks from the start, those still being made as they come, so a page can
// play a piece while ElevenLabs is still making it.
function made(type, source) {
  const chunks = [];
  let done = false, failed = null, wake = [];
  const woken = () => { for (const w of wake.splice(0)) w(); };
  let gotFirst;
  const first = new Promise((resolve, reject) => { gotFirst = { resolve, reject }; });
  const whole = (async () => {
    try {
      for await (const c of source) {
        chunks.push(c);
        if (chunks.length === 1) gotFirst.resolve();
        woken();
      }
      if (!chunks.length) throw new Error('no audio came back');
    } catch (err) { failed = err; }
    done = true;
    gotFirst.reject(failed || new Error('no audio'));   // a no-op once resolved
    woken();
    if (failed) throw failed;
    return Buffer.concat(chunks);
  })();
  whole.catch(() => {});
  async function* read() {
    for (let i = 0; ; ) {
      if (i < chunks.length) { yield chunks[i++]; continue; }
      if (failed) throw failed;
      if (done) return;
      await new Promise(r => wake.push(r));
    }
  }
  return { type, first: first.then(() => undefined), read, whole };
}
const once = async function* (buf) { yield await buf; };

const cache = new Map();   // `${id}:${index}`, `status:${phrase}` or `ack:${n}` -> Promise<made>
function cached(key, make) {
  if (!cache.has(key)) {
    const piece = make();
    piece.then(p => p.whole.then(() => { if (p.tooLong) cache.delete(key); })).catch(() => cache.delete(key));
    cache.set(key, piece);
    while (cache.size > CACHE_PIECES) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

// The acknowledgments in ElevenLabs' voice, kept on disk: made once per
// voice and model, not once per server start.
const ackDir = () => join(CONFIG_DIR, 'talk-voice');
// Flash now and then says a short phrase twice ("just a sec, just a sec"):
// audio far longer than the words is not kept, so the next start makes it
// again. 64 kb/s MP3 is 8 KB a second; a second plus 0.15 s a character is
// generous for a few words.
export const ackTooLong = (text, bytes) => bytes > (1 + 0.15 * text.length) * 8000;
const ackFile = (text, eleven) => join(ackDir(), `${createHash('sha256').update(`${eleven.voice}\n${eleven.model}\n${text}`).digest('hex').slice(0, 24)}.mp3`);

let elevenFailLogged = false;
// text → a made piece: ElevenLabs when it is set up, `say` when it is not or
// fails before its first byte (the log says why, once).
async function speakPiece(text, { env, platform, ack = false }) {
  const eleven = elevenSetup(env);
  if (eleven) {
    const file = ack ? ackFile(text, eleven) : null;
    if (file) { try { return made(ELEVEN_MIME, once(readFileSync(file))); } catch {} }
    const piece = made(ELEVEN_MIME, elevenStream(text, eleven));
    try {
      await piece.first;
      if (file) {
        piece.whole.then(buf => {
          if (ackTooLong(text, buf.length)) {
            console.log(`Talk: ElevenLabs' "${text}" came out too long; it is made again next time.`);
            piece.tooLong = true;
            return;
          }
          mkdirSync(ackDir(), { recursive: true });
          writeFileSync(file, buf);
        }).catch(() => {});
      }
      return piece;
    } catch (err) {
      if (!elevenFailLogged) console.error(`Talk: ElevenLabs could not speak, so say does: ${err.message}`);
      elevenFailLogged = true;
      if (speechUnavailable(env, platform)) throw err;
    }
  }
  const piece = made('audio/mp4', once(synthesize(text, env, 'm4a')));
  await piece.first;
  return piece;
}

// Piece `index` of a voice reply, spoken: { type, count, audio } (all of it),
// { type, count, stream } (an async iterable of chunks, as they are made), or
// { status, error }. Reply id 'status' is a short progress update made from
// Billion's status line now; 'ack-<n>' is acknowledgment n.
export async function voiceAudio(id, index, { env = process.env, platform = process.platform, now = Date.now() } = {}) {
  const phrase = id === 'status' ? progressSpeech(statusPayload(now)) : '';
  const ack = ackPhrase(id);
  const pieces = id === 'status' ? (phrase ? [phrase] : []) : ack ? [ack] : speechPieces(voiceReply(id)?.text ?? '');
  if (!pieces.length) return { status: 404, error: 'No such reply.' };
  if (!(Number.isInteger(index) && index >= 0 && index < pieces.length)) return { status: 404, error: 'No such piece.' };
  if (phrase) progressSpoken.push({ at: now, words: words(phrase).join(' ') });
  const off = elevenSetup(env) ? null : speechUnavailable(env, platform);
  if (off) return { status: 503, error: off };
  if (!allow('audio', AUDIO_LIMIT, now)) return { status: 429, error: 'Too much audio this minute.' };
  const key = phrase ? `status:${phrase}` : ack ? `ack:${id}` : `${id}:${index}`;
  try {
    const piece = await cached(key, () => speakPiece(pieces[index], { env, platform, ack: !!ack }));
    return { type: piece.type, count: pieces.length, stream: piece.read() };
  } catch (err) {
    console.error('Talk: could not speak a reply:', err.message);
    return { status: 503, error: 'Could not speak it' };
  }
}

// voiceAudio's whole piece as one Buffer, for the tests.
export async function voiceAudioBuffer(id, index, opts) {
  const result = await voiceAudio(id, index, opts);
  if (result.error) return result;
  const chunks = [];
  for await (const c of result.stream) chunks.push(c);
  return { type: result.type, count: result.count, audio: Buffer.concat(chunks) };
}

// For the tests: a fresh run.
export function _resetTalk() {
  recent.utterance = [];
  recent.audio = [];
  inflight.clear();
  cache.clear();
  progressSpoken.length = 0;
  elevenFailLogged = false;
}
