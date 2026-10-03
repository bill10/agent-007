// "Talk to Billion": a hands-free voice conversation in the Billion tab
// (server/talk.js, docs/BILLION.md "Talk to Billion"). One tap, then turns:
// the owner speaks, the voice detector (Silero VAD, served by this app from
// /vendor) hears the utterance end, its audio goes to the server once (an id
// per utterance: a retry is never a second message), Billion's tell_owner
// reply bound to that message is spoken, and it listens again.
//
// Only a reply whose replyTo is one of this conversation's own messages is
// spoken; replies to typed or Telegram messages stay in the thread, silent.
// Speaking while Billion talks stops it (and drops the pieces not yet played);
// stopping playback never cancels Billion's work.
//
// Audio stays on the machine running Agent 007 when it has whisper.cpp (and
// `say` for the voice). Without whisper.cpp the browser's own speech
// recognition is the fallback, after a one-time notice that it may send audio
// to the browser's maker; without `say`, the browser's speechSynthesis.
import { chatMessages, billionStatus } from './state.js';
import { stopVoice } from './voice.js';
import { stopReading, plainForSpeech, chunkForSpeech, pickVoice, progressPhrase, progressSpeech } from './readaloud.js';

const HEADERS = { 'X-Agent007-Talk': '1' };
const SETUP_DOCS = 'https://github.com/bill10/agent-007/blob/main/docs/BILLION.md#voice';
const STORE_KEY = 'agent007-talk';              // sessionStorage: survives the reload a reconnect does
const CONSENT_KEY = 'agent007-talk-browser-stt'; // localStorage: the one-time notice was accepted
export const IDLE_END_MS = 10 * 60 * 1000;
// Progress updates while a turn waits: the first after a short quiet, then
// each new status line as soon as nothing else is playing, never the same twice.
export const PROGRESS_QUIET_MS = 800;
const RETRY_FOR_MS = 2 * 60 * 1000;
const SAMPLE_RATE = 16000;
// The detector's bar for speech: higher while Billion talks, so what is left
// of its own voice after echo cancellation does not cut it off.
const SPEECH_THRESHOLD = 0.5;
const SPEECH_THRESHOLD_PLAYING = 0.8;

// --- Pure helpers, exported for tests ---

// 16 kHz float samples → a 16-bit mono WAV file, what whisper.cpp reads.
export function encodeWav(samples, rate = SAMPLE_RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// A chat message this conversation should speak: Billion's tell_owner reply
// to one of its own messages, not spoken yet.
export const shouldSpeak = (m, awaiting, spoken) =>
  !!m && m.from === 'billion' && !!m.replyTo && !m.notice && !m.q && awaiting.has(m.replyTo) && !spoken.has(m.id);

// How long until this progress phrase may be spoken (0: now), or null when
// it never should: nothing to say, or what was said last.
// p: { since: when the turn was sent, said }.
export function progressWait(phrase, p, now) {
  if (!phrase || phrase === p.said) return null;
  return Math.max(0, p.since + PROGRESS_QUIET_MS - now);
}

// The one word the bar shows, from what is going on.
export function talkState(s) {
  if (!s.on) return 'off';
  if (s.consent) return 'consent';
  if (s.starting) return 'starting';
  if (!s.connected) return 'disconnected';
  if (s.playing) return 'speaking';
  if (s.muted) return 'muted';
  if (s.hidden) return 'paused';
  if (s.uploads || s.awaiting) return 'thinking';
  return 'listening';
}

const LABELS = {
  consent: 'Before you talk',
  starting: 'Starting the microphone…',
  disconnected: 'Reconnecting…',
  speaking: 'Speaking',
  muted: 'Muted',
  paused: 'Paused (tab hidden)',
  thinking: 'Thinking…',
  listening: 'Listening…',
};

// --- State ---

let on = false;
let starting = false;
let consent = false;
let muted = false;
let hidden = false;
let connected = true;
let mode = null;          // 'whisper' (VAD + server) or 'browser' (SpeechRecognition)
let tts = 'say';          // 'say' (server) or 'browser' (speechSynthesis)
let vad = null;
let rec = null;
let uploads = 0;
let playing = null;       // id of the reply being spoken, 'status' for a progress update
let playingReply = null;  // that reply's message, to play again after a hidden tab
let playGen = 0;
let stopPlay = null;      // ends the piece playing now
let fetches = null;       // AbortController for the pieces being fetched
let replyQueue = [];
let echoOf = null;        // the reply that was playing when the owner started speaking
let hearing = false;      // the detector hears the owner speaking now: no update talks over them
let note = '';
let noteLink = false;
let audioEl = null;
let audioCtx = null;      // the detector's, made inside the tap so iOS lets it run
let silentUrl = null;     // a silent clip, played inside the tap to unlock audioEl
let startGen = 0;         // bumped by every start and End: a start that awaited past one gives up
let idleTimer = null;
let progressTimer = null;
let progress = { since: 0, said: '' };
let resumable = false;
let startedAt = 0;
let clockTimer = null;
// Messages of this conversation still waiting for a reply, and replies spoken.
const awaiting = new Set();
const spoken = new Set();
// Turns from before a reload: their reply is still spoken if it comes, but
// they show no "Thinking…" (a turn cut off by a server
// restart may never be answered; it waits in the thread).
const restored = new Set();
const thinkingFor = () => [...awaiting].filter(id => !restored.has(id)).length;
// Progress updates: never a reply, so never an echo to report.
const filler = (id) => id === 'status';
const marks = new Map();  // message id → latency marks

const restore = () => { try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch { return null; } };
function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ on, awaiting: [...awaiting], spoken: [...spoken].slice(-50) }));
  } catch {}
}
{
  const saved = typeof sessionStorage !== 'undefined' ? restore() : null;
  if (saved) {
    for (const id of saved.awaiting || []) { awaiting.add(id); restored.add(id); }
    for (const id of saved.spoken || []) spoken.add(id);
    resumable = !!saved.on;
  }
}

export const talkOn = () => on;

// --- The bar ---

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (cls, text, onclick) => {
  const b = el('button', `talk-btn chat-control ${cls}`, text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
};

const PHONE_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 2h2.3l1.2 3-1.5 1a8 8 0 0 0 4.8 4.8l1-1.5 3 1.2v2.3a1.5 1.5 0 0 1-1.6 1.5A11.5 11.5 0 0 1 1.7 3.6 1.5 1.5 0 0 1 3.2 2z"/></svg>';
const MIC_SVG = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" aria-hidden="true"><rect x="5" y="1.5" width="4" height="6.5" rx="2"/><path d="M2.8 6.5a4.2 4.2 0 0 0 8.4 0"/><line x1="7" y1="10.7" x2="7" y2="12.5"/>';
const MIC_ICON = `${MIC_SVG}</svg>`;
const MIC_OFF_ICON = `${MIC_SVG}<line x1="1.5" y1="1.5" x2="12.5" y2="12.5"/></svg>`;
// The same handset turned down, for End.
const HANGUP_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 9.5c0-1 1-2.100 6.500-2.100s6.500 1.100 6.500 2.100v1.200a.8.8 0 0 1-.9.8l-2.300-.4a.8.8 0 0 1-.7-.8V8.900a9 9 0 0 0-4.200 0v1.400a.8.8 0 0 1-.7.8l-2.300.4a.8.8 0 0 1-.9-.8z"/></svg>';

// The phone button in the composer row: starts a conversation. Its home is
// waiting.js, beside the mic and Send.
export function talkButton() {
  const b = el('button', 'chat-mic chat-control talk-phone');
  b.id = 'chat-talk';
  b.type = 'button';
  b.innerHTML = PHONE_SVG;
  b.title = 'Talk to Billion: a hands-free conversation (speak, hear its reply, speak again)';
  b.setAttribute('aria-label', 'Talk to Billion');
  b.onclick = () => startTalk();
  return b;
}

// Above the composer row: the notices (consent, setup, errors) and, during a
// conversation, the call bar that stands in for the row.
export function talkBar() {
  const bar = el('div', 'talk-bar');
  bar.id = 'talk-bar';
  const notes = el('div', 'talk-notes');
  const detail = el('span', 'talk-detail');
  const start = button('talk-start', 'Talk to Billion', () => startTalk());
  const privacy = el('div', 'talk-privacy');
  notes.append(detail, start, privacy);
  const call = el('div', 'talk-call');
  const state = el('span', 'talk-state');
  state.setAttribute('role', 'status');
  state.setAttribute('aria-live', 'polite');
  const timer = el('span', 'talk-timer');
  timer.setAttribute('role', 'timer');
  const skip = button('talk-skip', 'Interrupt', () => interrupt());
  const mute = button('talk-mute', '', () => setMuted(!muted));
  const end = button('talk-end', '', () => endTalk());
  end.innerHTML = `${HANGUP_SVG}<span>End</span>`;
  end.title = 'End the conversation (Esc)';
  end.setAttribute('aria-label', 'End');
  const gap = el('span', 'talk-gap');
  call.append(state, timer, gap, skip, mute, end);
  bar.append(notes, call);
  queueMicrotask(paint);
  return bar;
}

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
function tick() {
  const t = document.querySelector('#talk-bar .talk-timer');
  if (t) t.textContent = clock(Date.now() - startedAt);
}

function paint() {
  const bar = document.getElementById('talk-bar');
  if (!bar) return;
  const s = talkState({ on, consent, starting, connected, playing, muted, hidden, uploads, awaiting: thinkingFor() });
  bar.dataset.state = s;
  const q = (c) => bar.querySelector(c);
  // The call bar stands in for the text box row while a conversation runs.
  const inCall = on && !consent;
  q('.talk-call').hidden = !inCall;
  const row = document.getElementById('chat-compose-row');
  const wasHidden = row?.hidden;
  if (row) row.hidden = inCall;
  if (inCall && !wasHidden) q('.talk-end').focus();
  else if (!inCall && wasHidden) document.getElementById('chat-input')?.focus();
  const phone = document.getElementById('chat-talk');
  if (phone) {
    phone.title = resumable ? 'Resume talking to Billion' : 'Talk to Billion: a hands-free conversation (speak, hear its reply, speak again)';
    phone.setAttribute('aria-label', resumable ? 'Resume talking' : 'Talk to Billion');
  }
  const start = q('.talk-start');
  start.hidden = !(consent || (resumable && !on));
  start.textContent = consent ? 'Continue' : 'Resume talking';
  const stateEl = q('.talk-state');
  stateEl.textContent = inCall ? LABELS[s] : '';
  const detail = q('.talk-detail');
  detail.textContent = '';
  const working = s === 'thinking' && billionStatus?.text ? `Still working: ${billionStatus.text}` : '';
  const text = note || working;
  if (text) detail.append(text);
  if (noteLink) {
    const a = el('a', null, 'How to set up whisper.cpp');
    a.href = SETUP_DOCS;
    a.target = '_blank';
    a.rel = 'noopener';
    detail.append(' ', a);
  }
  detail.hidden = !detail.textContent;
  q('.talk-skip').hidden = s !== 'speaking';
  const mute = q('.talk-mute');
  mute.hidden = starting;
  const label = muted ? 'Unmute' : 'Mute';
  mute.innerHTML = `${muted ? MIC_OFF_ICON : MIC_ICON}<span></span>`;
  mute.lastChild.textContent = label;
  mute.setAttribute('aria-label', label);
  mute.setAttribute('aria-pressed', String(muted));
  const privacy = q('.talk-privacy');
  privacy.textContent = !on ? '' : consent
    ? 'whisper.cpp is not set up on the computer running Agent 007, so this browser\'s own speech recognition would hear you. It may send your audio to the browser\'s maker (Chrome: Google).'
    : `${mode === 'browser' ? 'Your browser recognises your speech and may send the audio to its maker (Chrome: Google).' : 'Your voice is transcribed on the computer running Agent 007 (whisper.cpp); no audio leaves it.'}`
      + ` ${tts === 'say' ? 'Replies are spoken by that computer\'s voice.' : 'Replies are spoken by this browser.'}`;
  privacy.hidden = !on;
  bar.querySelector('.talk-notes').hidden = !(detail.textContent || !start.hidden || !privacy.hidden);
  clearInterval(clockTimer);
  clockTimer = null;
  if (inCall) {
    tick();
    clockTimer = setInterval(tick, 1000);
  }
}

function setNote(text, link = false) {
  note = text;
  noteLink = link;
  paint();
}

// --- Start and end ---

async function serverSetup() {
  const res = await fetch('/api/talk', { headers: HEADERS });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

const recognitionCtor = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;

// The tap on "Talk to Billion" (or "Continue", or "Resume talking"). Audio
// must be unlocked inside the tap, so that happens before anything awaits.
export async function startTalk() {
  if (on && !consent) return;
  unlockAudio();
  if (consent) {
    try { localStorage.setItem(CONSENT_KEY, '1'); } catch {}
    consent = false;
    return beginBrowserRecognition();
  }
  note = '';
  noteLink = false;
  if (!window.isSecureContext) return setNote('Talking needs HTTPS or localhost — see docs/REMOTE.md (tailscale serve).');
  if (!navigator.mediaDevices?.getUserMedia) return setNote('This browser has no microphone API, so it cannot talk to Billion.');
  stopVoice();
  stopReading();
  const gen = ++startGen;
  const current = () => on && gen === startGen;
  on = true;
  starting = true;
  startedAt = Date.now();
  resumable = false;
  muted = false;
  hidden = document.hidden;
  save();
  paint();
  let setup;
  try { setup = await serverSetup(); } catch (err) {
    return current() && failStart(`Could not start: ${err.message}`);
  }
  if (!current()) return;
  tts = setup.tts === 'say' ? 'say' : 'browser';
  if (tts === 'browser' && !window.speechSynthesis) return failStart(`Billion cannot speak here: ${setup.ttsMissing}, and this browser has no speech synthesis.`);
  if (setup.stt === 'whisper') {
    try {
      await startVad(current);
      if (!current()) return;
      mode = 'whisper';
      starting = false;
      if (tts === 'browser') note = `Replies are spoken by this browser: ${setup.ttsMissing}.`;
      return ready();
    } catch (err) {
      console.warn('[talk] voice detector failed:', err);
      if (!current()) return;
      const v = vad;
      vad = null;
      v?.destroy?.().catch?.(() => {});
      if (/NotAllowed|Permission|denied/i.test(`${err?.name} ${err?.message}`)) return failStart('Microphone access denied — allow it in your browser settings, then tap Talk to Billion again.');
      if (!recognitionCtor()) return failStart('The voice detector could not start in this browser.');
    }
  }
  if (!recognitionCtor()) return failStart(`${setup.sttMissing || 'Talking needs whisper.cpp on the computer running Agent 007.'} This browser has no speech recognition to fall back on.`, true);
  mode = 'browser';
  starting = false;
  let accepted = false;
  try { accepted = localStorage.getItem(CONSENT_KEY) === '1'; } catch {}
  if (!accepted) {
    consent = true;
    return setNote(setup.sttMissing || '', true);
  }
  beginBrowserRecognition();
}

function failStart(text, link = false) {
  endTalk({ keepNote: true });
  setNote(text, link);
}

// Leaving the tab, End, or a failure: the mic stops and nothing more is spoken.
// Replies still on their way arrive in the thread as text.
export function endTalk({ keepNote = false, notice } = {}) {
  const wasOn = on;
  on = false;
  startGen++;
  starting = false;
  consent = false;
  muted = false;
  hearing = false;
  interrupt();
  clearTimeout(idleTimer);
  clearTimeout(progressTimer);
  const v = vad;
  vad = null;
  v?.destroy?.().catch?.(() => {});
  const ctx = audioCtx;
  audioCtx = null;
  ctx?.close().catch(() => {});
  stopRecognition();
  awaiting.clear();
  restored.clear();
  resumable = false;
  try { sessionStorage.removeItem(STORE_KEY); } catch {}
  if (!keepNote) { note = notice && wasOn ? notice : ''; noteLink = false; }
  paint();
}

// A tap's grace: one element, played silent inside the tap, plays later replies.
function unlockAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
  }
  try {
    silentUrl ??= URL.createObjectURL(new Blob([encodeWav(new Float32Array(160))], { type: 'audio/wav' }));
    audioEl.src = silentUrl;
    audioEl.play().catch(() => {});
  } catch {}
  try { window.speechSynthesis?.resume(); } catch {}
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume().catch(() => {});
  } catch {}
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (on) endTalk({ notice: 'Talk ended — no speech for 10 minutes.' }); }, IDLE_END_MS);
}

// --- Listening: the voice detector ---

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

// current: false once End (or another start) came while this one awaited.
async function startVad(current) {
  if (!window.ort) await loadScript('/vendor/ort/ort.wasm.min.js');
  if (!window.vad) await loadScript('/vendor/vad/bundle.min.js');
  const v = await window.vad.MicVAD.new({
    model: 'v5',
    baseAssetPath: '/vendor/vad/',
    onnxWASMBasePath: '/vendor/ort/',
    ortConfig: (ort) => { ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1; },
    positiveSpeechThreshold: SPEECH_THRESHOLD,
    negativeSpeechThreshold: 0.35,
    redemptionMs: 800,
    // Room for the first word of a barge-in, heard late under the raised bar.
    preSpeechPadMs: 600,
    minSpeechMs: 300,
    startOnLoad: false,
    ...(audioCtx ? { audioContext: audioCtx } : {}),
    // A real start, a few frames in, interrupts: a click or the tail of
    // Billion's own voice past the echo canceller is not enough.
    onSpeechRealStart: () => {
      armIdle();
      hearing = true;
      if (playing) {
        echoOf = filler(playing) ? null : playing;
        interrupt();
      }
    },
    onVADMisfire: () => { echoOf = null; hearing = false; },
    onSpeechEnd: (audio) => {
      hearing = false;
      if (!on || muted) return;
      sendAudio(audio);
    },
  });
  if (!current()) { v.destroy().catch(() => {}); return; }
  vad = v;
  if (!muted && !hidden) await v.start();
  // End came while the mic was being granted: this detector is not ours any more.
  if (!current() && vad !== v) v.destroy().catch(() => {});
}

function startMic() {
  if (!on || muted || hidden || consent || starting) return;
  if (mode === 'whisper') vad?.start().catch(err => console.warn('[talk] mic restart failed', err));
  else if (mode === 'browser' && !playing) startRecognition();
}

function stopMic() {
  hearing = false;
  if (mode === 'whisper') vad?.pause().catch(() => {});
  else stopRecognition();
}

export function setMuted(value) {
  if (!on) return;
  muted = value;
  if (muted) stopMic(); else startMic();
  paint();
}

// --- Listening: the browser's recognition (no whisper.cpp) ---

function beginBrowserRecognition() {
  note = '';
  noteLink = false;
  ready();
}

// Listening. Replies that came while the page reloaded (a reconnect) play now.
function ready() {
  armIdle();
  afterSpeech();
  talkHeardAll(chatMessages);
}

function startRecognition() {
  if (rec) return;
  const Ctor = recognitionCtor();
  const r = new Ctor();
  rec = r;
  r.continuous = true;
  r.interimResults = false;
  r.lang = navigator.language || 'en-US';
  r.onresult = (event) => {
    if (rec !== r) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal && result[0].transcript.trim()) sendText(result[0].transcript);
    }
  };
  r.onerror = (event) => {
    if (rec !== r) return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      endTalk({ keepNote: true });
      setNote('Microphone or speech recognition access denied — allow it in your browser settings.');
    } else if (event.error === 'audio-capture') {
      endTalk({ keepNote: true });
      setNote('No microphone found.');
    }
  };
  r.onend = () => {
    if (rec !== r) return;
    rec = null;
    // Browsers end recognition after a silence; it goes on while talking is on.
    setTimeout(startMic, 250);
  };
  try { r.start(); } catch { rec = null; }
}

function stopRecognition() {
  const r = rec;
  rec = null;
  if (!r) return;
  r.onresult = r.onerror = r.onend = null;
  try { r.abort(); } catch {}
}

// --- Sending ---

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// POST with the same utterance id until the server answers: a lost
// connection retries, and the server keeps a retry from being a second message.
async function postOnce(url, init) {
  const until = Date.now() + RETRY_FOR_MS;
  for (let wait = 1000; on; wait = Math.min(wait * 2, 10000)) {
    try {
      const res = await fetch(url, init);
      return await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    } catch {
      if (Date.now() > until) return { error: 'Could not reach Agent 007; say it again once it is back.' };
      await sleep(wait);
    }
  }
  return null;
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function sendAudio(samples) {
  const id = newId();
  const ended = performance.now();
  const echo = echoOf;
  echoOf = null;
  const headers = { ...HEADERS, 'Content-Type': 'audio/wav', 'X-Utterance-Id': id, ...(echo ? { 'X-Echo-Of': echo } : {}) };
  await submitted(postOnce('/api/talk/utterance', { method: 'POST', headers, body: encodeWav(samples) }), ended);
}

async function sendText(text) {
  const ended = performance.now();
  const body = JSON.stringify({ utterance: newId(), text });
  await submitted(postOnce('/api/talk/text', { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body }), ended);
}

async function submitted(request, ended) {
  uploads++;
  paint();
  const result = await request;
  uploads--;
  if (!on || !result) return paint();
  if (result.error) {
    setNote(result.empty ? '' : result.error);
    return;
  }
  if (result.echo) return setNote('That sounded like Billion\'s own voice, so it was not sent. Say it again if it was you.');
  note = '';
  awaiting.add(result.id);
  save();
  marks.set(result.id, { ended, submitted: performance.now(), transcribeMs: result.transcribeMs });
  // Only a status line that changes from here on is news for this turn.
  progress = { since: Date.now(), said: progressPhrase(billionStatus) };
  clearTimeout(progressTimer);
  progressTimer = setTimeout(sayProgress, PROGRESS_QUIET_MS);
  // A fast reply can beat this answer to the page.
  for (const m of chatMessages) talkHeard(m);
  paint();
}

// --- Replies ---

// Every chat message the page sees passes here (waiting.js, app.js).
export function talkHeard(m) {
  if (!on || !shouldSpeak(m, awaiting, spoken)) return;
  spoken.add(m.id);
  awaiting.delete(m.replyTo);
  save();
  const mark = marks.get(m.replyTo);
  if (mark) mark.reply = performance.now();
  if (!thinkingFor()) clearTimeout(progressTimer);
  // A progress update gives way to the answer at once.
  if (filler(playing)) interrupt();
  replyQueue.push(m);
  if (!playing && !hidden) playNext();
  else paint();
}

export function talkHeardAll(messages) {
  for (const m of messages || []) talkHeard(m);
}

// The status line: whether the page is connected, and what Billion is doing.
export function talkStatus(msg) {
  connected = !msg?.disconnected;
  paint();
  sayProgress();
}

function playNext() {
  const m = replyQueue.shift();
  playingReply = m || null;
  if (m) speak(m.id, m.text, m.replyTo);
  else afterSpeech();
}

// Back to listening (or thinking) once nothing is playing.
function afterSpeech() {
  if (!playing) vad?.setOptions({ positiveSpeechThreshold: SPEECH_THRESHOLD });
  paint();
  if (on && !playing) startMic();
  if (!playing) sayProgress();
}

// A short spoken update when Billion's status line changes while a turn
// waits, as soon as nothing else is playing. Several changes while one was
// spoken: only the newest is said next.
function sayProgress() {
  clearTimeout(progressTimer);
  if (!on || !thinkingFor() || hidden) return;
  const phrase = progressSpeech(billionStatus);
  const wait = progressWait(phrase, progress, Date.now());
  if (wait === null) return;
  if (wait > 0 || playing || uploads || hearing) {
    progressTimer = setTimeout(sayProgress, wait || 250);
    return;
  }
  progress = { ...progress, said: phrase };
  speak('status', phrase);
}

async function speak(id, text, replyTo) {
  const mine = ++playGen;
  playing = id;
  // The browser's recognition would hear the reply: it waits for the end.
  if (mode === 'browser') stopRecognition();
  vad?.setOptions({ positiveSpeechThreshold: SPEECH_THRESHOLD_PLAYING });
  paint();
  try {
    // A progress update the server no longer has (the status moved on) is
    // just skipped; only a reply it cannot speak means its voice is gone.
    if (tts === 'say' && !(await speakFromServer(id, mine, replyTo)) && mine === playGen && id !== 'status') {
      tts = 'browser';
      setNote('This computer could not speak the reply; using the browser\'s voice.');
      await speakInBrowser(text, mine, replyTo);
    } else if (tts === 'browser') {
      await speakInBrowser(text, mine, replyTo);
    }
  } finally {
    if (mine === playGen) {
      playing = null;
      playNext();
    }
  }
}

// The reply's pieces from the server, each fetched while the one before
// plays. false when the first piece could not be had.
async function speakFromServer(id, mine, replyTo) {
  fetches = new AbortController();
  const signal = fetches.signal;
  const piece = (i) => fetch(`/api/talk/audio/${encodeURIComponent(id)}/${i}`, { headers: HEADERS, signal })
    .then(async res => (res.ok ? { blob: await res.blob(), count: Number(res.headers.get('X-Pieces')) || 1 } : null))
    .catch(() => null);
  let next = piece(0);
  for (let i = 0, count = 1; i < count; i++) {
    const got = await next;
    if (mine !== playGen) return true;
    if (!got) return i > 0;
    count = got.count;
    next = i + 1 < count ? piece(i + 1) : null;
    await playBlob(got.blob, mine, i === 0 && replyTo);
  }
  return true;
}

function playBlob(blob, mine, replyTo) {
  return new Promise(resolve => {
    if (mine !== playGen) return resolve();
    const url = URL.createObjectURL(blob);
    const done = () => {
      audioEl.onended = audioEl.onerror = null;
      URL.revokeObjectURL(url);
      if (stopPlay === done) stopPlay = null;
      resolve();
    };
    stopPlay = done;
    audioEl.onended = done;
    audioEl.onerror = done;
    audioEl.src = url;
    audioEl.play().then(() => { if (replyTo) logLatency(replyTo); }).catch(done);
  });
}

function speakInBrowser(text, mine, replyTo) {
  const synth = window.speechSynthesis;
  const chunks = chunkForSpeech(plainForSpeech(text));
  const voice = pickVoice(synth.getVoices(), null);
  return chunks.reduce((before, chunk, i) => before.then(() => new Promise(resolve => {
    if (mine !== playGen) return resolve();
    const u = new SpeechSynthesisUtterance(chunk);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    const done = () => { if (stopPlay === done) stopPlay = null; resolve(); };
    stopPlay = done;
    u.onend = done;
    u.onerror = done;
    if (i === 0 && replyTo) u.onstart = () => logLatency(replyTo);
    synth.speak(u);
  })), Promise.resolve());
}

// The owner spoke (or tapped Stop speaking): playback stops now, the pieces
// not yet played are dropped, and so are replies queued behind it. Billion's
// work goes on; the replies stay in the thread.
export function interrupt() {
  playGen++;
  replyQueue = [];
  fetches?.abort();
  fetches = null;
  try { audioEl?.pause(); } catch {}
  try { window.speechSynthesis?.cancel(); } catch {}
  const stop = stopPlay;
  stopPlay = null;
  stop?.();
  if (playing) {
    playing = null;
    afterSpeech();
  }
}

// End of speech → reply on the page → first sound, per turn, in the console
// (and window.agent007TalkLatency) for measuring.
function logLatency(id) {
  const m = marks.get(id);
  if (!m || m.logged || !m.reply) return;
  m.logged = true;
  const row = {
    transcriptionMs: Math.round(m.submitted - m.ended),
    whisperMs: m.transcribeMs,
    billionMs: Math.round(m.reply - m.submitted),
    speechStartMs: Math.round(performance.now() - m.reply),
    totalMs: Math.round(performance.now() - m.ended),
  };
  (window.agent007TalkLatency ||= []).push(row);
  console.info('[talk] latency', row);
}

// --- The page ---

// A hidden tab cannot show the mic is on: it stops, playback too, and both
// come back when the tab does. Replies that came meanwhile play then.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && on && !consent) endTalk(); });
  document.addEventListener('visibilitychange', () => {
    if (!on) return;
    hidden = document.hidden;
    if (hidden) {
      stopMic();
      const current = playing && !filler(playing) ? playingReply : null;
      const kept = replyQueue;
      interrupt();
      replyQueue = current ? [current, ...kept] : kept;
      paint();
    } else if (replyQueue.length && !playing) {
      playNext();
    } else {
      afterSpeech();
    }
  });
}

// For tests.
export function _resetTalk() {
  endTalk();
  spoken.clear();
  marks.clear();
  progress = { since: 0, at: -Infinity, said: '' };
  tts = 'say';
  mode = null;
  connected = true;
  hidden = false;
}
export const _talkInternals = () => ({ on, mode, tts, playing, progress: { ...progress }, awaiting: [...awaiting], spoken: [...spoken], replyQueue: replyQueue.map(m => m.id) });
