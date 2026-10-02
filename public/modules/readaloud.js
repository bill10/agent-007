// Read aloud: Billion's messages spoken by the browser (speechSynthesis), free
// and local. A speaker button on each message speaks it (tap again to stop),
// and "Read new messages aloud" speaks each new one as it arrives, queued so
// two never overlap. Browsers only let a page speak after a tap on it, so an
// auto-read left on across a reload waits for one tap on "Resume reading".
//
// The text preparation is pure and exported for tests: markdown stripped,
// URLs read as "link", Q51 as "question 51", a question's choices read at the
// end, and long text cut into sentence-sized pieces, since Chrome cuts off an
// utterance that runs past about 15 seconds.

const AUTO_KEY = 'agent007-read-aloud';
const VOICE_KEY = 'agent007-read-aloud-voice';
// About 12 s of speech at a normal rate: under Chrome's cut-off.
const CHUNK_CHARS = 180;

// --- Pure text preparation ---

// Markdown and links into what a person would say.
export function plainForSpeech(text) {
  let t = String(text ?? '');
  t = t.replace(/```[\s\S]*?(```|$)/g, ' (code block) ');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');           // images: alt text
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');         // [text](url): text
  t = t.replace(/<(https?:\/\/[^>\s]+)>/g, 'link');
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi, 'link');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');                  // headings
  t = t.replace(/^\s{0,3}>\s?/gm, '');                       // quotes
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');           // list markers
  t = t.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');     // rules
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');
  t = t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/gm, '$1$2');
  t = t.replace(/~~(.+?)~~/g, '$1');
  t = t.replace(/\bQ(\d+)\b/g, 'question $1');
  t = t.replace(/(^|\s)#(\d+)\b/g, '$1number $2');
  t = t.replace(/\s+->\s+|\s+→\s+/g, ' to ');
  // A line break is a pause: end the line as a sentence if it isn't one.
  t = t.split('\n').map(line => line.trim()).filter(Boolean)
    .map(line => /[.!?:;,]$/.test(line) ? line : `${line}.`).join(' ');
  return t.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').replace(/\.{2,}/g, '.').trim();
}

// What the speaker button reads for one chat message: a question says its
// number first and its choices last, while it is still open.
export function speakableText(m) {
  if (!m) return '';
  const parts = [];
  if (m.q) parts.push(`Question ${m.q.n}.`);
  parts.push(plainForSpeech(m.text));
  const q = m.q;
  if (q && q.status === 'open' && Array.isArray(q.choices) && q.choices.length) {
    const choices = q.choices.map(c => plainForSpeech(c).replace(/\.$/, ''));
    const rec = q.recommended ? `; recommended: ${plainForSpeech(q.recommended).replace(/\.$/, '')}` : '';
    parts.push(`Choices: ${choices.join(', ')}${rec}.`);
  }
  return parts.filter(Boolean).join(' ');
}

// Cut text into pieces of at most max characters, on sentence ends where it
// can, then on commas, then on spaces.
export function chunkForSpeech(text, max = CHUNK_CHARS) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const pieces = [];
  const split = (s, re) => s.split(re).map(x => x.trim()).filter(Boolean);
  for (const sentence of split(t, /(?<=[.!?])\s+/)) {
    if (sentence.length <= max) { pieces.push(sentence); continue; }
    for (const clause of split(sentence, /(?<=[,;:])\s+/)) {
      if (clause.length <= max) { pieces.push(clause); continue; }
      let line = '';
      for (const word of clause.split(' ')) {
        if (line && line.length + 1 + word.length > max) { pieces.push(line); line = ''; }
        line = line ? `${line} ${word}` : word;
        while (line.length > max) { pieces.push(line.slice(0, max)); line = line.slice(max); }
      }
      if (line) pieces.push(line);
    }
  }
  // Short neighbours back together, so the voice doesn't pause every few words.
  const chunks = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= max) chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

// A Talk to Billion progress update: Billion's status line (else the last
// line of its progress box) cut to its first few words, with code, URLs,
// paths, flags and file names left out, and a raw tool call said as what it
// does (or not at all). '' when nothing sayable is left.
const PROGRESS_WORDS = 8;
const TOOL_WORDS = {
  bash: 'Running a command', read: 'Reading files', edit: 'Editing files', write: 'Writing a file',
  grep: 'Searching', glob: 'Searching', websearch: 'Searching the web', webfetch: 'Reading a web page',
};
export function progressPhrase(status, max = PROGRESS_WORDS) {
  const steps = status?.progress?.[status?.currentRequest];
  const raw = String(status?.text || (Array.isArray(steps) ? steps.at(-1) : '') || '');
  const tool = raw.match(/^\s*(?:mcp__[\w-]+?__)?(\w+)\s*\(/);
  if (tool) return TOOL_WORDS[tool[1].toLowerCase()] || '';
  const t = raw
    .replace(/```[\s\S]*?(```|$)|`[^`]*`?/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\S*[/\\]\S*/g, ' ')                        // paths
    .replace(/(^|\s)--?[a-z][\w-]*/gi, ' ')                // flags
    .replace(/\b[\w-]+\.[a-z][a-z0-9]{0,4}\b/g, ' ')        // file.ext
    .split(/[.;:!?()\n—–]|\s-\s/)[0];
  const words = t.split(/\s+/).map(w => w.replace(/^[,"']+|[,"']+$/g, '')).filter(Boolean);
  if (!words.some(w => /[a-z]{2}/i.test(w))) return '';
  return words.slice(0, max).join(' ');
}

// The best installed English voice: the owner's pick if it is still there,
// else en-US over other English, the high-quality ones (Premium, Enhanced,
// Siri, Google, Natural) first.
export function pickVoice(voices, savedURI) {
  const list = Array.from(voices || []);
  if (savedURI) {
    const saved = list.find(v => v.voiceURI === savedURI);
    if (saved) return saved;
  }
  const score = (v) => {
    const lang = String(v.lang || '').replace('_', '-').toLowerCase();
    const name = String(v.name || '');
    let s = 0;
    if (lang === 'en-us') s += 20;
    else if (lang.startsWith('en')) s += 10;
    else return -1;
    if (/premium/i.test(name)) s += 8;
    else if (/enhanced|natural|neural/i.test(name)) s += 6;
    if (/siri/i.test(name)) s += 5;
    if (/google/i.test(name)) s += 4;
    if (v.default) s += 1;
    return s;
  };
  let best = null;
  let bestScore = -1;
  for (const v of list) {
    const s = score(v);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return best || list[0] || null;
}

export const englishVoices = (voices) => Array.from(voices || [])
  .filter(v => /^en([-_]|$)/i.test(String(v.lang || '')))
  .sort((a, b) => String(a.name).localeCompare(String(b.name)));

// --- The speaker ---

const synth = () => (typeof window !== 'undefined' && window.speechSynthesis) || null;
export const readAloudSupported = () => !!synth() && typeof window.SpeechSynthesisUtterance === 'function';

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} },
};

let speakingId = null;      // the message being spoken now
let queue = [];             // [{ id, text }] waiting their turn
let current = [];           // the utterances of the message being spoken (kept: Chrome drops onend of a collected one)
let gen = 0;                // bumped on every stop, so a stale onend does nothing
let unlocked = false;       // the page has had a tap that let it speak
const listeners = new Set();

export const autoReadOn = () => store.get(AUTO_KEY) === '1';
export const speakingMessage = () => speakingId;
export const queuedCount = () => queue.length;
// Auto-read is on but nothing here has been tapped since the page loaded. Any
// earlier tap on the page is not enough: iOS lets a page speak only once it
// has spoken inside a tap, so the unlock is one of ours.
export const needsResume = () => autoReadOn() && !unlocked;

export function onReadAloudChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) { try { fn(); } catch (e) { console.warn('[read aloud]', e); } } }

export function savedVoiceURI() { return store.get(VOICE_KEY); }
export function setVoiceURI(uri) { store.set(VOICE_KEY, uri || null); }

function currentVoice() {
  const s = synth();
  return s ? pickVoice(s.getVoices(), savedVoiceURI()) : null;
}

// Speak one message now, after anything already speaking is stopped.
function speakNow(id, text) {
  const s = synth();
  const chunks = chunkForSpeech(text);
  if (!s || !chunks.length) { next(); return; }
  const mine = ++gen;
  speakingId = id;
  const voice = currentVoice();
  current = chunks.map((chunk, i) => {
    const u = new window.SpeechSynthesisUtterance(chunk);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
    if (i === chunks.length - 1) {
      u.onend = () => { if (gen === mine) finish(); };
    }
    u.onerror = (e) => {
      if (gen !== mine) return;
      // "interrupted"/"canceled" are our own cancel(); anything else, move on.
      if (e?.error !== 'interrupted' && e?.error !== 'canceled') console.warn('[read aloud] speech error:', e?.error);
      // The message's later pieces are still queued in the browser: drop them,
      // so they never play over the next message.
      gen++;
      try { s.cancel(); } catch {}
      finish();
    };
    return u;
  });
  // Safari can be left paused by an earlier cancel.
  try { s.resume(); } catch {}
  for (const u of current) s.speak(u);
  changed();
}

function finish() {
  gen++;
  speakingId = null;
  current = [];
  next();
}

function next() {
  const item = queue.shift();
  if (item) speakNow(item.id, item.text);
  else changed();
}

// Stop speaking and drop the queue.
export function stopReading() {
  gen++;
  queue = [];
  speakingId = null;
  current = [];
  try { synth()?.cancel(); } catch {}
  changed();
}

// The speaker button: speak this message, or stop it if it is the one
// speaking. A tap is a user gesture, so it unlocks auto-read too.
export function toggleSpeak(id, text) {
  unlocked = true;
  if (speakingId === id) { stopReading(); return; }
  stopReading();
  speakNow(id, text);
}

// A new Billion message arrived while the tab is open: speak it after
// whatever is speaking, if auto-read is on. Before the page's first tap it
// waits in the queue behind "Resume reading".
export function readNew(id, text) {
  if (!autoReadOn() || !readAloudSupported()) return;
  if (speakingId === id || queue.some(q => q.id === id)) return;
  queue.push({ id, text });
  if (needsResume()) { changed(); return; }
  if (speakingId === null) next();
  else changed();
}

// The toggle in the tab's header. Turning it on is a tap, so it can speak.
export function setAutoRead(on) {
  store.set(AUTO_KEY, on ? '1' : null);
  if (on) {
    unlocked = true;
    // Speaking something right away inside the tap is what unlocks iOS.
    if (speakingId === null && !queue.length) speakNow('__auto__', 'Reading new messages aloud.');
    else changed();
  } else {
    stopReading();
  }
}

// "Resume reading" after a reload: the tap that lets the page speak again.
export function resumeReading() {
  unlocked = true;
  if (speakingId !== null) { changed(); return; }
  if (queue.length) next();
  else speakNow('__auto__', 'Reading new messages aloud.');
}

// For tests.
export function _resetReadAloud() {
  gen++;
  speakingId = null;
  queue = [];
  current = [];
  unlocked = false;
}
