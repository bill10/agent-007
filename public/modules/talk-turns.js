// Talk to Billion's turn-taking (public/modules/talk.js, docs/BILLION.md
// "Talk to Billion"): when has the owner finished speaking?
//
// The voice detector reports stretches of speech (segments) that end after a
// short silence. Each is transcribed as soon as it ends, and the turn is
// gathered from them: it ends only after a longer pause, longer still when
// the words so far stop mid-thought ("...and then I want", "um"), shorter
// when they end like a finished sentence. Speech before the pause is over
// joins the same turn, so a natural pause never cuts the owner off.

// Total silence before a turn ends, in ms.
export const PAUSE_MS = { finished: 1200, usual: 1500, unfinished: 2600 };

// Words a finished thought hardly ever ends on: conjunctions, articles and
// possessives, prepositions that are no particle ("log in", "turn it on" end
// fine), the subjects a clause starts with, and fillers.
const OPEN_ENDINGS = new Set(`
  and but or because cause since if when while although though unless until than whether
  the a an my your our their his her its every
  to of for from with by into onto between through without toward towards via per
  i we they he she let's
  um uh er erm hmm
`.trim().split(/\s+/));

// Whether these words stop mid-thought. Whisper often ends a fragment with a
// full stop, so the last word decides, not the punctuation; a trailing comma,
// dash or ellipsis is unfinished whatever the word.
export function unfinished(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/(,|;|:|-|–|—|\.\.\.|…)$/.test(t)) return true;
  const last = t.toLowerCase().match(/[\p{L}\p{N}']+(?=[^\p{L}\p{N}']*$)/u)?.[0];
  return !!last && OPEN_ENDINGS.has(last);
}

// How long a silence ends a turn whose words so far are `text` ('' while the
// first segment is still being transcribed).
export function turnPause(text) {
  const t = String(text ?? '').trim();
  if (!t) return PAUSE_MS.usual;
  if (unfinished(t)) return PAUSE_MS.unfinished;
  // A question, or a sentence of a few words with its stop: finished.
  if (/[?!]$/.test(t) || (/\.$/.test(t) && t.split(/\s+/).length >= 3)) return PAUSE_MS.finished;
  return PAUSE_MS.usual;
}

// An acknowledgment index from `count`, never `last`.
export function pickAck(count, last, random = Math.random) {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  const i = Math.floor(random() * (count - 1));
  return i >= last && last >= 0 ? i + 1 : i;
}

// The turn gatherer. transcribe(segment, echoOf) → Promise<{ text, echo? }>
// (a string segment is its own text); send({ text, utterance }) → the turn,
// once, when the owner has finished; onEcho() when everything heard was the
// page's own voice; onIdle() when the owner stopped with nothing to send. lead: how long the detector waited in silence before it
// reported a segment's end (its redemption time), already part of the pause.
export function createTurns({ transcribe, send, onEcho = () => {}, onIdle = () => {}, lead = 0, newId, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
  let turn = null;      // { utterance, parts: [{ text, done }], silentFrom, echoed }
  let speaking = false;
  let timer = null;

  const textOf = (t) => t.parts.filter(p => p.done).map(p => p.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  function arm() {
    clearTimer(timer);
    timer = null;
    if (!turn || speaking || turn.parts.some(p => !p.done)) return;
    const wait = turn.silentFrom + turnPause(textOf(turn)) - now();
    if (wait <= 0) return finish();
    timer = setTimer(arm, wait);
  }

  function finish() {
    const t = turn;
    turn = null;
    const text = textOf(t);
    if (text) send({ text, utterance: t.utterance });
    else {
      if (t.echoed) onEcho();
      onIdle();
    }
  }

  return {
    // The detector hears speech (maybe): the turn holds.
    speechStart() {
      speaking = true;
      clearTimer(timer);
      timer = null;
    },
    // It was not speech after all: the pause goes on from where it was.
    speechMisfire() {
      speaking = false;
      if (turn) arm();
      else onIdle();
    },
    // A stretch of speech ended: audio to transcribe, or the browser's own text.
    segment(input, echoOf) {
      speaking = false;
      turn ||= { utterance: newId(), parts: [], echoed: false };
      turn.silentFrom = now() - lead;
      const part = { text: '', done: false };
      turn.parts.push(part);
      const t = turn;
      const heard = typeof input === 'string' ? Promise.resolve({ text: input }) : transcribe(input, echoOf);
      heard.then(r => r || {}, () => ({})).then(r => {
        part.text = r.echo ? '' : String(r.text || '').trim();
        if (r.echo) t.echoed = true;
        part.done = true;
        if (t === turn) arm();
      });
      arm();
    },
    // Gathering a turn now (speech heard, not sent yet).
    gathering: () => !!turn || speaking,
    // End: what was heard and not sent is dropped.
    reset() {
      clearTimer(timer);
      timer = null;
      turn = null;
      speaking = false;
    },
  };
}
