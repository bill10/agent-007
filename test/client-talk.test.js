// @vitest-environment happy-dom
// Talk to Billion, the page (public/modules/talk.js, talk-turns.js): each
// stretch of speech transcribed as WAV, the turn sent once after a real pause
// (two stretches with a short pause between are one turn), an acknowledgment
// the moment it ends, only the reply bound to it spoken (piece by piece from
// the server), words added before the reply continuing the turn, speaking
// over Billion cutting it off and dropping what was not played, mute and End
// stopping the mic, the browser's voice when the server has none, and a clear
// refusal where the browser cannot do it. The voice detector, fetch and the
// audio element are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encodeWav, shouldSpeak, talkState, progressWait, talkStatus, PROGRESS_QUIET_MS, SEGMENT_SILENCE_MS, talkBar, talkButton, startTalk, endTalk, talkHeard, setMuted, talkOn, earpieceId, _resetTalk, _talkInternals,
} from '../public/modules/talk.js';
import { unfinished, turnPause, pickAck, createTurns, PAUSE_MS } from '../public/modules/talk-turns.js';
import { setChatMessages, setBillionStatus } from '../public/modules/state.js';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

let vadOpts, fakeVad, routes, requests, played, theAudio;

class FakeAudio {
  // talk.js keeps one element for the page's life (unlocked in the first tap).
  constructor() { this.paused = true; this.volume = 1; theAudio = this; }
  play() { this.paused = false; if (this.blobText !== undefined) played.push(this.blobText); return Promise.resolve(); }
  pause() { this.paused = true; }
  set src(url) { this._src = url; this.blobText = blobs.get(url); }
  get src() { return this._src; }
  end() { this.onended?.(); }
  setSinkId(id) { this.sinkId = id; return Promise.resolve(); }
}
const blobs = new Map();
let blobN = 0;

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status < 400, status,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => body,
    blob: async () => ({ text: String(body) }),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  mountComposer();
  requests = [];
  played = [];
  vadOpts = null;
  fakeVad = { start: vi.fn(async () => {}), pause: vi.fn(async () => {}), destroy: vi.fn(async () => {}), setOptions: vi.fn() };
  window.ort = {};
  window.vad = { MicVAD: { new: vi.fn(async (opts) => { vadOpts = opts; return fakeVad; }) } };
  routes = {
    '/api/talk': () => response({ stt: 'whisper', tts: 'say' }),
    '/api/talk/segment': () => response({ text: 'How is it going?', transcribeMs: 300 }),
    '/api/talk/text': () => response({ ok: true, id: 'm1' }),
  };
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    requests.push({ url, init });
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const audio = url.match(/^\/api\/talk\/audio\/([^/]+)\/(\d+)$/);
    if (audio) return routes.audio ? routes.audio(audio[1], Number(audio[2])) : response(`${audio[1]}#${audio[2]}`, { headers: { 'X-Pieces': '2' } });
    return routes[url]();
  }));
  vi.stubGlobal('Audio', FakeAudio);
  URL.createObjectURL = vi.fn((blob) => {
    const url = `blob:${blobN++}`;
    if (typeof blob.text === 'string') blobs.set(url, blob.text);
    return url;
  });
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  setChatMessages([]);
  setBillionStatus(null);
});
afterEach(() => {
  _resetTalk();
  vi.unstubAllGlobals();
  delete navigator.audioSession;
  try { localStorage.clear(); } catch {}
});

// The composer as waiting.js builds it: the bar above the row, the phone button in it.
function mountComposer() {
  document.body.innerHTML = '';
  const row = document.createElement('div');
  row.id = 'chat-compose-row';
  const input = document.createElement('textarea');
  input.id = 'chat-input';
  const mic = document.createElement('button');
  mic.id = 'chat-mic';
  const send = document.createElement('button');
  send.id = 'chat-send';
  row.append(input, mic, talkButton(), send);
  document.body.append(talkBar(), row);
}

const bar = () => document.getElementById('talk-bar');
const stateWord = () => bar().dataset.state;
const reply = (id, replyTo, text = 'It went fine.') => ({ id, from: 'billion', replyTo, text, at: new Date().toISOString() });

async function talking() {
  await startTalk();
  await flush();
  expect(stateWord()).toBe('listening');
}

const posts = (url) => requests.filter(r => r.url === url);
const turnsSent = () => posts('/api/talk/text').map(r => JSON.parse(r.init.body));

// The owner says something and pauses long enough to finish the turn.
async function utterance() {
  const fake = vi.isFakeTimers();
  if (!fake) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vadOpts.onSpeechEnd(new Float32Array(1600));
  await vi.advanceTimersByTimeAsync(PAUSE_MS.unfinished);
  if (!fake) vi.useRealTimers();
  await flush();
}

describe('pure pieces', () => {
  it('encodeWav writes a 16 kHz 16-bit mono WAV', () => {
    const buf = encodeWav(new Float32Array([0, 1, -1]));
    const v = new DataView(buf);
    expect(String.fromCharCode(...new Uint8Array(buf, 0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
    expect(buf.byteLength).toBe(44 + 6);
    expect(v.getInt16(46, true)).toBe(0x7fff);
    expect(v.getInt16(48, true)).toBe(-0x8000);
  });

  it('shouldSpeak: only Billion\'s reply to a message of this conversation, once', () => {
    const awaiting = new Set(['m1']);
    expect(shouldSpeak(reply('r1', 'm1'), awaiting, new Set())).toBe(true);
    expect(shouldSpeak(reply('r1', 'm1'), awaiting, new Set(['r1']))).toBe(false);
    expect(shouldSpeak(reply('r2', 'typed'), awaiting, new Set())).toBe(false);
    expect(shouldSpeak({ ...reply('r3', 'm1'), notice: true }, awaiting, new Set())).toBe(false);
    expect(shouldSpeak({ id: 'o', from: 'owner', replyTo: 'm1' }, awaiting, new Set())).toBe(false);
  });

  it('talkState names each state', () => {
    const base = { on: true, connected: true };
    expect(talkState({})).toBe('off');
    expect(talkState(base)).toBe('listening');
    expect(talkState({ ...base, uploads: 1 })).toBe('thinking');
    expect(talkState({ ...base, awaiting: 1, playing: 'r1' })).toBe('speaking');
    expect(talkState({ ...base, muted: true })).toBe('muted');
    expect(talkState({ ...base, connected: false })).toBe('disconnected');
  });
});

describe('a turn', () => {
  it('transcribes the speech as WAV, sends the turn once, speaks only its own reply piece by piece, then listens', async () => {
    await talking();
    expect(window.vad.MicVAD.new).toHaveBeenCalledWith(expect.objectContaining({ baseAssetPath: '/vendor/vad/', onnxWASMBasePath: '/vendor/ort/', redemptionMs: SEGMENT_SILENCE_MS }));
    expect(fakeVad.start).toHaveBeenCalled();
    await utterance();
    const post = requests.find(r => r.url === '/api/talk/segment');
    expect(post.init.headers).toMatchObject({ 'X-Agent007-Talk': '1', 'Content-Type': 'audio/wav', 'X-Segment-Id': expect.any(String) });
    expect(post.init.body.byteLength).toBe(44 + 3200);
    expect(turnsSent()).toEqual([{ utterance: expect.any(String), text: 'How is it going?' }]);
    expect(stateWord()).toBe('thinking');

    talkHeard(reply('rX', 'typed-message', 'Not yours.'));
    await flush();
    expect(requests.some(r => r.url.includes('/audio/rX/'))).toBe(false);

    talkHeard(reply('r1', 'm1'));
    await flush();
    expect(stateWord()).toBe('speaking');
    expect(fakeVad.setOptions).toHaveBeenCalledWith({ positiveSpeechThreshold: 0.8 });
    expect(played).toEqual(['r1#0']);
    theAudio.end();
    await flush();
    expect(played).toEqual(['r1#0', 'r1#1']);
    theAudio.end();
    await flush();
    expect(stateWord()).toBe('listening');
    // The same reply seen again (a reconnect's chat-list) is not spoken twice.
    talkHeard(reply('r1', 'm1'));
    await flush();
    expect(played).toHaveLength(2);
  });

  it('speaking over Billion stops it, drops the rest, and marks the next utterance as maybe-echo', async () => {
    await talking();
    await utterance();
    talkHeard(reply('r1', 'm1'));
    await flush();
    expect(played).toEqual(['r1#0']);
    vadOpts.onSpeechRealStart();
    await flush();
    expect(theAudio.paused).toBe(true);
    expect(stateWord()).toBe('listening');
    theAudio.end();
    await flush();
    expect(played).toEqual(['r1#0']);
    routes['/api/talk/text'] = () => response({ ok: true, id: 'm2' });
    await utterance();
    expect(posts('/api/talk/segment')[1].init.headers['X-Echo-Of']).toBe('r1');
    // The reply came, so this is a new turn, not more of the last.
    expect(turnsSent()[1].continues).toBeUndefined();
    expect(_talkInternals().awaiting).toEqual(['m2']);
  });

  it('a network failure retries the same turn id, never a new one', async () => {
    await talking();
    let fails = 1;
    routes['/api/talk/text'] = () => { if (fails-- > 0) throw new TypeError('network'); return response({ ok: true, id: 'm1' }); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vadOpts.onSpeechEnd(new Float32Array(160));
    await vi.advanceTimersByTimeAsync(PAUSE_MS.unfinished + 1500);
    vi.useRealTimers();
    await flush();
    const sent = turnsSent();
    expect(sent).toHaveLength(2);
    expect(sent[1].utterance).toBe(sent[0].utterance);
    expect(_talkInternals().awaiting).toEqual(['m1']);
  });

  it('mute stops the mic, End stops everything and speaks nothing more', async () => {
    await talking();
    setMuted(true);
    expect(fakeVad.pause).toHaveBeenCalled();
    expect(stateWord()).toBe('muted');
    const starts = fakeVad.start.mock.calls.length;
    setMuted(false);
    expect(fakeVad.start).toHaveBeenCalledTimes(starts + 1);
    await utterance();
    endTalk();
    expect(fakeVad.destroy).toHaveBeenCalled();
    expect(talkOn()).toBe(false);
    talkHeard(reply('r1', 'm1'));
    await flush();
    expect(played).toEqual([]);
    expect(bar().querySelector('.talk-call').hidden).toBe(true);
  });

  it('without say on the server, the browser speaks the reply', async () => {
    const spoken = [];
    vi.stubGlobal('speechSynthesis', { speak: (u) => { spoken.push(u.text); setTimeout(() => u.onend?.()); }, cancel: vi.fn(), resume: vi.fn(), getVoices: () => [] });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(t) { this.text = t; } });
    routes.audio = () => response({ error: 'no say' }, { status: 503 });
    await talking();
    await utterance();
    talkHeard(reply('r1', 'm1', 'All **green**. Merging now.'));
    await flush(10);
    expect(spoken).toEqual(['All green. Merging now.']);
    expect(bar().querySelector('.talk-privacy').textContent).toMatch(/spoken by this browser/);
  });
});

describe('races', () => {
  it('End then Talk while the first start still waits leaves exactly one detector, and End stops it', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    routes['/api/talk'] = () => gate.then(() => response({ stt: 'whisper', tts: 'say' }));
    const made = [];
    window.vad.MicVAD.new = vi.fn(async (opts) => { vadOpts = opts; const v = { ...fakeVad, start: vi.fn(async () => {}), destroy: vi.fn(async () => {}) }; made.push(v); return v; });
    const first = startTalk();
    endTalk();
    const second = startTalk();
    release();
    await Promise.all([first, second]);
    await flush();
    expect(made).toHaveLength(1);
    expect(stateWord()).toBe('listening');
    endTalk();
    expect(made[0].destroy).toHaveBeenCalled();
  });

  it('an utterance dropped as Billion\'s own voice says so', async () => {
    await talking();
    routes['/api/talk/segment'] = () => response({ text: '', echo: true });
    await utterance();
    expect(bar().querySelector('.talk-detail').textContent).toMatch(/Billion's own voice/);
    expect(turnsSent()).toEqual([]);
    expect(_talkInternals().awaiting).toEqual([]);
  });
});

describe('progress updates while Billion works', () => {
  const status = (text) => {
    const s = { type: 'billion-status', text, working: true, currentRequest: 'm1', progress: { m1: [] } };
    setBillionStatus(s);
    talkStatus(s);
  };
  const said = () => played.filter(p => p.startsWith('status#'));
  const wait = (ms) => vi.advanceTimersByTimeAsync(ms);
  afterEach(() => vi.useRealTimers());

  it('progressWait: quiet only at first, then now; never a repeat or nothing', () => {
    const p = { since: 0, said: 'Old news' };
    expect(progressWait('Reading', p, 500)).toBe(PROGRESS_QUIET_MS - 500);
    expect(progressWait('Reading', p, PROGRESS_QUIET_MS)).toBe(0);
    expect(progressWait('Old news', p, 60000)).toBeNull();
    expect(progressWait('', p, 60000)).toBeNull();
  });

  it('speaks a new status line at once after 0.8 s, newest only, no repeats, no filler, gives way to the answer', async () => {
    await talking();
    routes.audio = (id, i) => response(`${id}#${i}`, { headers: { 'X-Pieces': id === 'status' ? '1' : '2' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    status('Looking at the board');              // from before the turn: not news
    vadOpts.onSpeechEnd(new Float32Array(1600));
    await wait(PAUSE_MS.finished - SEGMENT_SILENCE_MS);
    expect(PROGRESS_QUIET_MS).toBe(800);
    await wait(PROGRESS_QUIET_MS);
    expect(said()).toEqual([]);

    status('Reading the talk code');
    await wait(0);
    expect(said()).toEqual(['status#0']);
    expect(_talkInternals().playing).toBe('status');
    expect(fakeVad.setOptions).toHaveBeenLastCalledWith({ positiveSpeechThreshold: 0.8 });

    // Several changes while one is spoken: only the newest follows, right away.
    status('Checking the board');
    status('Running the tests');
    await wait(5000);
    expect(said()).toHaveLength(1);
    theAudio.end();
    await wait(300);
    expect(said()).toHaveLength(2);
    expect(requests.filter(r => r.url.includes('/audio/status/'))).toHaveLength(2);
    theAudio.end();
    await wait(0);

    // The same line again is not repeated.
    status('Running the tests');
    await wait(5000);
    expect(said()).toHaveLength(2);

    // Never over the owner: an update waits while they speak.
    vadOpts.onSpeechRealStart();
    status('Writing the fix');
    await wait(5000);
    expect(said()).toHaveLength(2);
    vadOpts.onVADMisfire();
    await wait(300);
    expect(said()).toHaveLength(3);

    // The answer arrives mid-update: the update stops, the answer plays next.
    talkHeard(reply('r1', 'm1'));
    await wait(0);
    expect(_talkInternals().playing).toBe('r1');
    expect(played.at(-1)).toBe('r1#0');

    // Answered: nothing more, and no filler cue ever.
    theAudio.end(); await wait(0); theAudio.end(); await wait(0);
    status('Tidying up');
    await wait(60000);
    expect(said()).toHaveLength(3);
    expect(requests.some(r => r.url.includes('/audio/cue/'))).toBe(false);
  });

  it('speaks the box heading when there is no status line; a status line wins; each heading once', async () => {
    await talking();
    routes.audio = (id, i) => response(`${id}#${i}`, { headers: { 'X-Pieces': '1' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const heading = (working, text = '') => {
      const s = { type: 'billion-status', text, working, currentRequest: 'm1', progress: { m1: [] } };
      setBillionStatus(s);
      talkStatus(s);
    };
    heading(false);
    vadOpts.onSpeechEnd(new Float32Array(1600));
    await wait(PAUSE_MS.finished - SEGMENT_SILENCE_MS);
    await wait(PROGRESS_QUIET_MS - 100);
    expect(said()).toEqual([]);
    await wait(100);
    expect(said()).toEqual(['status#0']);
    theAudio.end();
    await wait(0);

    heading(true);                                // the same heading: not said again
    await wait(5000);
    expect(said()).toHaveLength(1);

    heading(true, 'Reading the talk code');       // a status line wins
    await wait(300);
    expect(said()).toHaveLength(2);
    theAudio.end();
    await wait(0);
    heading(true);                                // cleared: the heading again
    await wait(300);
    expect(said()).toHaveLength(3);
    expect(requests.some(r => r.url.includes('/audio/cue/'))).toBe(false);
  });
});

describe('hang up focus', () => {
  it.each([['coarse', true], ['fine', false]])('does not focus the textarea on a %s pointer; the Talk button gets it', async (_, coarse) => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: coarse && q === '(pointer: coarse)' }));
    await talking();
    endTalk();
    await flush();
    expect(document.activeElement).not.toBe(document.getElementById('chat-input'));
    expect(document.activeElement).toBe(document.getElementById('chat-talk'));
  });
});

describe('speaker or earpiece (iPhone)', () => {
  const OUTPUTS = [
    { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'mic' },
    { kind: 'audiooutput', label: 'Speaker', deviceId: 'spk' },
    { kind: 'audiooutput', label: 'iPhone', deviceId: 'rcv' },
  ];
  const outButton = () => bar().querySelector('.talk-output');
  function iPhone() {
    Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' }, configurable: true });
    vi.stubGlobal('matchMedia', (q) => ({ matches: q === '(pointer: coarse)' }));
    navigator.mediaDevices.enumerateDevices = vi.fn(async () => OUTPUTS);
  }

  it('earpieceId picks the receiver, never the loudspeaker or a mic', () => {
    expect(earpieceId(OUTPUTS)).toBe('rcv');
    expect(earpieceId([{ kind: 'audiooutput', label: 'Receiver', deviceId: 'r' }])).toBe('r');
    expect(earpieceId(OUTPUTS.slice(0, 2))).toBe('');
  });

  it('a desktop browser shows no output button', async () => {
    await talking();
    expect(outButton().hidden).toBe(true);
  });

  it('defaults to Speaker, holds play-and-record for the call, and remembers Earpiece', async () => {
    iPhone();
    await talking();
    expect(outButton().hidden).toBe(false);
    expect(outButton().textContent).toBe('Speaker');
    expect(navigator.audioSession.type).toBe('play-and-record');
    expect(theAudio.sinkId).toBe('');
    outButton().click();
    await flush();
    expect(outButton().textContent).toBe('Earpiece');
    expect(theAudio.sinkId).toBe('rcv');
    expect(localStorage.getItem('agent007-talk-output')).toBe('earpiece');
    endTalk();
    expect(navigator.audioSession.type).toBe('auto');
    await talking();
    await flush();
    expect(outButton().textContent).toBe('Earpiece');
    expect(theAudio.sinkId).toBe('rcv');
    outButton().click();
    await flush();
    expect(theAudio.sinkId).toBe('');
    expect(localStorage.getItem('agent007-talk-output')).toBe('speaker');
  });

  it('says so when the earpiece cannot be picked', async () => {
    iPhone();
    navigator.mediaDevices.enumerateDevices = vi.fn(async () => OUTPUTS.slice(0, 2));
    localStorage.setItem('agent007-talk-output', 'earpiece');
    await talking();
    await flush();
    expect(bar().querySelector('.talk-detail').textContent).toMatch(/does not let the page pick the earpiece/);
  });
});

describe('the mic stays open for the call', () => {
  const fakeStream = () => {
    const track = { enabled: true, readyState: 'live', stop: vi.fn(function () { this.readyState = 'ended'; }) };
    return { track, getTracks: () => [track] };
  };

  it('mute disables the track instead of stopping it; unmute re-enables the same stream', async () => {
    const s = fakeStream();
    navigator.mediaDevices.getUserMedia = vi.fn(async () => s);
    await talking();
    expect(await vadOpts.getStream()).toBe(s);
    await vadOpts.pauseStream(s);
    expect(s.track.enabled).toBe(false);
    expect(s.track.stop).not.toHaveBeenCalled();
    expect(await vadOpts.resumeStream(s)).toBe(s);
    expect(s.track.enabled).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('End stops the track, even while muted, and a stopped track is reopened on resume', async () => {
    const s = fakeStream();
    navigator.mediaDevices.getUserMedia = vi.fn(async () => s);
    await talking();
    await vadOpts.getStream();
    setMuted(true);
    await vadOpts.pauseStream(s);
    endTalk();
    expect(s.track.stop).toHaveBeenCalled();
    const fresh = fakeStream();
    navigator.mediaDevices.getUserMedia = vi.fn(async () => fresh);
    expect(await vadOpts.resumeStream(s)).toBe(fresh);
  });
});

describe('when the owner has finished (talk-turns.js)', () => {
  afterEach(() => vi.useRealTimers());

  it('unfinished: a phrase that stops mid-thought, whatever whisper\'s full stop says', () => {
    for (const t of ['Check the release and', 'I want to.', 'Look at the, um', 'Merge it because', 'So the plan is,', 'Then…', 'Open the PR for the']) expect(unfinished(t), t).toBe(true);
    for (const t of ['Merge it.', 'Is the build green?', 'Turn it on.', 'Log in', 'Thank you', 'I think so.', '']) expect(unfinished(t), t).toBe(false);
  });

  it('turnPause: 1.2 s after a finished sentence, 1.5 s usually, longer after an unfinished phrase', () => {
    expect(PAUSE_MS.finished).toBeGreaterThanOrEqual(1200);
    expect(PAUSE_MS.usual).toBeLessThanOrEqual(1800);
    expect(turnPause('Is the build green?')).toBe(PAUSE_MS.finished);
    expect(turnPause('Merge the release now.')).toBe(PAUSE_MS.finished);
    expect(turnPause('')).toBe(PAUSE_MS.usual);
    expect(turnPause('Okay')).toBe(PAUSE_MS.usual);
    expect(turnPause('Check the release and')).toBe(PAUSE_MS.unfinished);
    expect(PAUSE_MS.unfinished).toBeGreaterThan(PAUSE_MS.usual);
  });

  it('pickAck never picks the one before', () => {
    for (let last = 0; last < 4; last++) {
      for (const r of [0, 0.3, 0.6, 0.99]) {
        const i = pickAck(4, last, () => r);
        expect(i).not.toBe(last);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(4);
      }
    }
    expect(pickAck(1, 0)).toBe(0);
    expect(pickAck(0, -1)).toBe(-1);
  });

  // A gatherer whose transcripts are the strings handed to segment(), after `ms`.
  function gatherer({ ms = 100, lead = SEGMENT_SILENCE_MS } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sent = [], echoes = [];
    let n = 0;
    const turns = createTurns({
      transcribe: (input) => new Promise(r => setTimeout(() => r(String(input) === 'ECHO' ? { text: '', echo: true } : { text: 'Heard.' }), ms)),
      send: (t) => sent.push(t),
      onEcho: () => echoes.push(true),
      newId: () => `turn-${++n}`,
      lead,
    });
    return { turns, sent, echoes };
  }

  it('pause, then more words before the pause is up: one turn with both', async () => {
    const { turns, sent } = gatherer();
    // ("Check the release." reads finished: 1.2 s of silence ends it, 0.5 s of which the detector waited.)
    turns.segment('Check the release.');
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([]);
    turns.speechStart();
    await vi.advanceTimersByTimeAsync(3000);           // talking: never sent mid-speech
    expect(sent).toEqual([]);
    turns.segment('And the open PRs.');
    await vi.advanceTimersByTimeAsync(PAUSE_MS.finished - SEGMENT_SILENCE_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ text: 'Check the release. And the open PRs.', utterance: 'turn-1' }]);
  });

  it('waits longer after an unfinished phrase', async () => {
    const { turns, sent } = gatherer();
    turns.segment('Can you check the release and');
    await vi.advanceTimersByTimeAsync(PAUSE_MS.usual);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(PAUSE_MS.unfinished - PAUSE_MS.usual - SEGMENT_SILENCE_MS);
    expect(sent).toHaveLength(1);
  });

  it('a noise that was not speech does not restart the pause', async () => {
    const { turns, sent } = gatherer();
    turns.segment('Merge it now.');
    await vi.advanceTimersByTimeAsync(400);
    turns.speechStart();
    await vi.advanceTimersByTimeAsync(200);
    turns.speechMisfire();
    await vi.advanceTimersByTimeAsync(PAUSE_MS.finished - SEGMENT_SILENCE_MS - 600);
    expect(sent).toEqual([{ text: 'Merge it now.', utterance: 'turn-1' }]);
  });

  it('a slow transcript holds the turn until it is in, then sends at once', async () => {
    const { turns, sent } = gatherer({ ms: 4000 });
    turns.segment(new Float32Array(1));                // audio: transcribed
    await vi.advanceTimersByTimeAsync(3999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
  });

  it('only the page\'s own voice heard: nothing sent, and it says so; End drops a turn half heard', async () => {
    const { turns, sent, echoes } = gatherer();
    turns.segment(Object.assign(new Float32Array(1), { toString: () => 'ECHO' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
    expect(echoes).toHaveLength(1);
    turns.segment('Something');
    turns.reset();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
    expect(turns.gathering()).toBe(false);
  });
});

describe('a turn, an acknowledgment, and more words', () => {
  const ACKS = ['Got it, one sec.', 'Okay, let me check.', 'On it.'];
  beforeEach(() => {
    routes['/api/talk'] = () => response({ stt: 'whisper', tts: 'elevenlabs', acks: ACKS });
    routes.audio = (id, i) => response(`${id}#${i}`, { headers: { 'X-Pieces': '1', 'Content-Type': 'audio/mpeg' } });
  });
  afterEach(() => vi.useRealTimers());
  const acksPlayed = () => played.filter(p => p.startsWith('ack-'));

  it('says a different acknowledgment the moment each turn ends, from audio fetched at the start', async () => {
    await talking();
    await flush();
    expect(requests.filter(r => /\/audio\/ack-\d\/0$/.test(r.url))).toHaveLength(3);
    const fetched = requests.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vadOpts.onSpeechEnd(new Float32Array(1600));
    await vi.advanceTimersByTimeAsync(PAUSE_MS.finished - SEGMENT_SILENCE_MS);
    // At the end of the turn, from what was fetched: no request in between.
    expect(acksPlayed()).toHaveLength(1);
    expect(requests.slice(fetched).filter(r => r.url.includes('/audio/'))).toEqual([]);
    expect(stateWord()).toBe('speaking');
    // The reply comes while it plays: it waits for the acknowledgment.
    talkHeard(reply('r1', 'm1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(_talkInternals().playing).toMatch(/^ack-/);
    theAudio.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(played.at(-1)).toBe('r1#0');
    theAudio.end();
    await vi.advanceTimersByTimeAsync(0);
    routes['/api/talk/text'] = () => response({ ok: true, id: 'm2' });
    for (let i = 0; i < 6; i++) {
      vadOpts.onSpeechEnd(new Float32Array(1600));
      await vi.advanceTimersByTimeAsync(PAUSE_MS.unfinished);
      theAudio.end();
      await vi.advanceTimersByTimeAsync(0);
    }
    const said = acksPlayed();
    expect(said).toHaveLength(7);
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1]);
  });

  it('more words before the reply continue the turn; its answer answers both', async () => {
    await talking();
    await utterance();
    expect(_talkInternals().awaiting).toEqual(['m1']);
    theAudio.end();                                    // the acknowledgment
    await flush();
    routes['/api/talk/segment'] = () => response({ text: 'And the open PRs too.' });
    routes['/api/talk/text'] = () => response({ ok: true, id: 'm2' });
    await utterance();
    expect(turnsSent()[1]).toMatchObject({ text: 'And the open PRs too.', continues: 'm1' });
    expect(_talkInternals().awaiting).toEqual(['m1', 'm2']);
    theAudio.end();
    await flush();
    talkHeard(reply('r2', 'm2', 'The release is out, and two PRs are open.'));
    await flush();
    expect(played.at(-1)).toBe('r2#0');
    expect(_talkInternals().awaiting).toEqual([]);
    theAudio.end();
    await flush();
    expect(stateWord()).toBe('listening');
  });

  it('words merged into a turn Billion has not had yet stay that one turn', async () => {
    await talking();
    await utterance();
    theAudio.end();
    await flush();
    routes['/api/talk/text'] = () => response({ ok: true, id: 'm1', merged: true });
    await utterance();
    expect(turnsSent()[1].continues).toBe('m1');
    expect(_talkInternals().awaiting).toEqual(['m1']);
  });

  it('speaking over the acknowledgment stops it at once; the words continue the turn', async () => {
    await talking();
    await utterance();
    expect(_talkInternals().playing).toMatch(/^ack-/);
    const ack = _talkInternals().playing;
    vadOpts.onSpeechStart();
    expect(theAudio.volume).toBeLessThan(1);           // ducked the moment speech may have begun
    vadOpts.onSpeechRealStart();
    expect(theAudio.paused).toBe(true);
    expect(_talkInternals().playing).toBe(null);
    routes['/api/talk/text'] = () => response({ ok: true, id: 'm2' });
    await utterance();
    expect(posts('/api/talk/segment')[1].init.headers['X-Echo-Of']).toBe(ack);
    expect(turnsSent()[1].continues).toBe('m1');
  });

  it('barge-in on the reply: playback stops, it keeps listening, and the words are sent', async () => {
    await talking();
    await utterance();
    theAudio.end();
    await flush();
    talkHeard(reply('r1', 'm1', 'A long answer. '.repeat(40)));
    await flush();
    expect(_talkInternals().playing).toBe('r1');
    vadOpts.onSpeechStart();
    vadOpts.onSpeechRealStart();
    expect(theAudio.paused).toBe(true);
    expect(stateWord()).toBe('listening');
    expect(fakeVad.pause).not.toHaveBeenCalled();
    routes['/api/talk/text'] = () => response({ ok: true, id: 'm2' });
    await utterance();
    expect(turnsSent()).toHaveLength(2);
    expect(turnsSent()[1].continues).toBeUndefined();
  });

  it('a noise while Billion speaks only ducks it for a moment', async () => {
    await talking();
    await utterance();
    vadOpts.onSpeechStart();
    expect(theAudio.volume).toBe(0.3);
    vadOpts.onVADMisfire();
    expect(theAudio.volume).toBe(1);
    expect(_talkInternals().playing).toMatch(/^ack-/);
  });

  it('a reply that comes while the owner is still speaking waits until the turn is sent, then plays, with no acknowledgment', async () => {
    await talking();
    await utterance();
    theAudio.end();                                    // the acknowledgment
    await flush();
    const acks = acksPlayed().length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vadOpts.onSpeechStart();
    vadOpts.onSpeechRealStart();
    talkHeard(reply('r1', 'm1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(_talkInternals().playing).toBe(null);       // not over the owner
    expect(_talkInternals().replyQueue).toEqual(['r1']);
    routes['/api/talk/text'] = () => response({ ok: true, id: 'm2' });
    vadOpts.onSpeechEnd(new Float32Array(1600));
    await vi.advanceTimersByTimeAsync(PAUSE_MS.finished - SEGMENT_SILENCE_MS - 100);
    expect(_talkInternals().playing).toBe(null);       // nor in their pause
    await vi.advanceTimersByTimeAsync(100);
    expect(_talkInternals().playing).toBe('r1');
    expect(acksPlayed()).toHaveLength(acks);
  });

  it('a reply held for a noise plays once it proves not to be speech', async () => {
    await talking();
    await utterance();
    theAudio.end();
    await flush();
    vadOpts.onSpeechStart();
    talkHeard(reply('r1', 'm1'));
    await flush();
    expect(_talkInternals().playing).toBe(null);
    vadOpts.onVADMisfire();
    await flush();
    expect(_talkInternals().playing).toBe('r1');
  });

  it('muting mid-speech still sends what was heard', async () => {
    await talking();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vadOpts.onSpeechEnd(new Float32Array(1600));
    vadOpts.onSpeechStart();                           // more speech, then Mute before it ends
    setMuted(true);
    await vi.advanceTimersByTimeAsync(PAUSE_MS.unfinished);
    expect(turnsSent()).toEqual([{ utterance: expect.any(String), text: 'How is it going?' }]);
  });

  it('fetches the acknowledgments one at a time', async () => {
    let open = 0, most = 0;
    routes.audio = async (id, i) => { open++; most = Math.max(most, open); await new Promise(r => setTimeout(r, 5)); open--; return response(`${id}#${i}`, { headers: { 'X-Pieces': '1' } }); };
    await talking();
    await new Promise(r => setTimeout(r, 40));
    expect(requests.filter(r => r.url.includes('/audio/ack-'))).toHaveLength(3);
    expect(most).toBe(1);
  });

  it('the bar says ElevenLabs speaks the replies', async () => {
    await talking();
    expect(bar().querySelector('.talk-privacy').textContent).toMatch(/spoken by ElevenLabs/);
  });
});

describe('acknowledgments and turns, edge cases', () => {
  const ACKS = ['Got it, one sec.', 'Okay, let me check.'];
  afterEach(() => vi.useRealTimers());

  it('after the answer, the next turn is a turn of its own, not a continuation', async () => {
    routes['/api/talk'] = () => response({ stt: 'whisper', tts: 'say', acks: [] });
    await talking();
    await utterance();
    talkHeard(reply('r1', 'm1'));
    await flush();
    theAudio.end(); await flush();
    theAudio.end(); await flush();
    routes['/api/talk/text'] = () => response({ ok: true, id: 'm2' });
    await utterance();
    expect(turnsSent()).toHaveLength(2);
    expect(turnsSent()[1].continues).toBeUndefined();
  });

  it('the browser\'s voice says the acknowledgment itself: no ack audio is fetched', async () => {
    const spoken = [];
    vi.stubGlobal('speechSynthesis', { speak: (u) => { spoken.push(u.text); }, cancel: vi.fn(), resume: vi.fn(), getVoices: () => [] });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(t) { this.text = t; } });
    routes['/api/talk'] = () => response({ stt: 'whisper', tts: null, ttsMissing: 'no say', acks: ACKS });
    await talking();
    await utterance();
    expect(requests.filter(r => r.url.includes('/audio/ack-'))).toEqual([]);
    expect(spoken).toHaveLength(1);
    expect(ACKS).toContain(spoken[0]);
    expect(turnsSent()).toHaveLength(1);
  });

  it('acknowledgment audio that could not be fetched: no acknowledgment, the turn still goes and the reply plays', async () => {
    routes['/api/talk'] = () => response({ stt: 'whisper', tts: 'elevenlabs', acks: ACKS });
    routes.audio = (id, i) => (id.startsWith('ack-') ? response({ error: 'down' }, { status: 503 }) : response(`${id}#${i}`, { headers: { 'X-Pieces': '1' } }));
    await talking();
    await flush();
    await utterance();
    expect(played.filter(p => p.startsWith('ack-'))).toEqual([]);
    expect(turnsSent()).toHaveLength(1);
    talkHeard(reply('r1', 'm1'));
    await flush();
    expect(played).toEqual(['r1#0']);
  });

  it('a stretch of speech that could not be transcribed says why and sends nothing', async () => {
    routes['/api/talk/segment'] = () => response({ error: 'Could not transcribe that; say it again.' }, { status: 400 });
    await talking();
    await utterance();
    expect(turnsSent()).toEqual([]);
    expect(bar().textContent).toMatch(/Could not transcribe that/);
  });
});
