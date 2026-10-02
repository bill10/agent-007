// "Talk to Billion": the Billion tab's hands-free voice conversation
// (docs/BILLION.md, "Talk to Billion"; the page is public/modules/talk.js).
// Voice only turns audio into an owner message and Billion's tell_owner reply
// into audio; Billion stays the only brain. The audio stays on this machine:
// each utterance is transcribed by whisper.cpp and each reply spoken by
// `say`, the same tools and limits as Telegram voice (server/voice.js).
//
// An utterance becomes a [Owner via app, voice] turn through ownerSays, keyed
// by the id the page gave it, so a retry or a revised transcript is the
// message already sent, never a second one. Audio is served only for a
// tell_owner reply bound (replyTo) to one of these voice turns: never a
// question, a server notice, a status line or terminal output.

import { whisperSetup, transcribe, speechUnavailable, synthesize, MAX_NOTE_SECONDS } from './voice.js';
import { chatMessages, ownerSays } from './owner.js';
import { plainForSpeech, chunkForSpeech, progressPhrase } from '../public/modules/readaloud.js';
import { statusPayload } from './billion-status.js';

// The page sends 16 kHz 16-bit mono WAV: Telegram's five minutes of it.
export const MAX_UTTERANCE_BYTES = MAX_NOTE_SECONDS * 16000 * 2 + 44;
// Pieces of a reply spoken one at a time, so playback starts after the first
// sentence and an interruption drops the rest.
export const SPEECH_CHUNK_CHARS = 300;
export const UTTERANCE_LIMIT = 30;      // utterances a minute
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

// What the page can use: whisper.cpp here (stt) and `say` here (tts), or why not.
export function talkSetup(env = process.env, platform = process.platform) {
  const whisper = whisperSetup(env);
  const speech = speechUnavailable(env, platform);
  return {
    stt: whisper.missing ? null : 'whisper',
    ...(whisper.missing ? { sttMissing: whisper.missing.replace(/; send text instead\.$/, '.').replace(/^Voice notes need/, 'Talking needs') } : {}),
    tts: speech ? null : 'say',
    ...(speech ? { ttsMissing: speech } : {}),
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

// One transcript in: { ok, id, duplicate? }, { ok, echo } when it was
// Billion's own voice (nothing sent), or { error }. echoOf: the reply that was
// playing when the owner started speaking.
export async function voiceSays(transcript, { utterance, echoOf, broadcast, env = process.env } = {}) {
  if (!validUtterance(utterance)) return { error: 'Bad utterance id.' };
  const text = typeof transcript === 'string' ? transcript.replace(/\s+/g, ' ').trim() : '';
  if (!text) return { error: 'No words were heard.', empty: true };
  const playing = typeof echoOf === 'string' && voiceReply(echoOf);
  if (playing && looksLikeEcho(text, plainForSpeech(playing.text))) return { ok: true, echo: true };
  return ownerSays(text, { voice: true, utterance, broadcast, env });
}

// An utterance retried while its first try is still being transcribed waits
// for that one: one transcription, one message.
const inflight = new Map();

// The page's recorded utterance (WAV bytes) → voiceSays's result, plus the transcript.
export function voiceUtterance(audio, { utterance, echoOf, broadcast, env = process.env, now = Date.now() } = {}) {
  if (!validUtterance(utterance)) return Promise.resolve({ error: 'Bad utterance id.' });
  const sent = chatMessages().find(m => m.utterance === utterance);
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
      return { ...await voiceSays(transcript, { utterance, echoOf, broadcast, env }), transcript, transcribeMs };
    } catch (err) {
      console.error('Talk: could not send an utterance:', err.message);
      return { error: 'Could not send that to Billion; say it again.' };
    }
  })().finally(() => inflight.delete(utterance));
  inflight.set(utterance, job);
  return job;
}

const cache = new Map();   // `${id}:${index}` or `status:${phrase}` -> Promise<Buffer>
function cached(key, make) {
  if (!cache.has(key)) {
    const made = make();
    made.catch(() => cache.delete(key));
    cache.set(key, made);
    while (cache.size > CACHE_PIECES) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

// Piece `index` of a voice reply, spoken by `say`: { audio, count } or
// { status, error }. Reply id
// 'status' is a short progress update made from Billion's status line now.
export async function voiceAudio(id, index, { env = process.env, platform = process.platform, now = Date.now() } = {}) {
  const phrase = id === 'status' ? progressPhrase(statusPayload(now)) : '';
  const pieces = id === 'status' ? (phrase ? [phrase] : []) : speechPieces(voiceReply(id)?.text ?? '');
  if (!pieces.length) return { status: 404, error: 'No such reply.' };
  if (!(Number.isInteger(index) && index >= 0 && index < pieces.length)) return { status: 404, error: 'No such piece.' };
  const off = speechUnavailable(env, platform);
  if (off) return { status: 503, error: off };
  if (!allow('audio', AUDIO_LIMIT, now)) return { status: 429, error: 'Too much audio this minute.' };
  try {
    return { audio: await cached(phrase ? `status:${phrase}` : `${id}:${index}`, () => synthesize(pieces[index], env, 'm4a')), count: pieces.length };
  } catch (err) {
    console.error('Talk: could not speak a reply:', err.message);
    return { status: 503, error: 'say could not speak it' };
  }
}

// For the tests: a fresh run.
export function _resetTalk() {
  recent.utterance = [];
  recent.audio = [];
  inflight.clear();
  cache.clear();
}
