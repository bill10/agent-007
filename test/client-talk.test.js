// @vitest-environment happy-dom
// Talk to Billion, the page (public/modules/talk.js): a detected utterance
// sent once as WAV, only the reply bound to it spoken (piece by piece from
// the server), speaking over Billion cutting it off and dropping what was not
// played, mute and End stopping the mic, the browser's voice when the server
// has none, and a clear refusal where the browser cannot do it. The voice
// detector, fetch and the audio element are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encodeWav, shouldSpeak, talkState, progressWait, talkStatus, PROGRESS_QUIET_MS, talkBar, talkButton, startTalk, endTalk, talkHeard, setMuted, talkOn, earpieceId, _resetTalk, _talkInternals,
} from '../public/modules/talk.js';
import { setChatMessages, setBillionStatus } from '../public/modules/state.js';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

let vadOpts, fakeVad, routes, requests, played, theAudio;

class FakeAudio {
  // talk.js keeps one element for the page's life (unlocked in the first tap).
  constructor() { this.paused = true; theAudio = this; }
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
    '/api/talk/utterance': () => response({ ok: true, id: 'm1', transcribeMs: 300 }),
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

async function utterance() {
  vadOpts.onSpeechEnd(new Float32Array(1600));
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
  it('sends the utterance once as WAV, speaks only its own reply piece by piece, then listens', async () => {
    await talking();
    expect(window.vad.MicVAD.new).toHaveBeenCalledWith(expect.objectContaining({ baseAssetPath: '/vendor/vad/', onnxWASMBasePath: '/vendor/ort/' }));
    expect(fakeVad.start).toHaveBeenCalled();
    await utterance();
    const post = requests.find(r => r.url === '/api/talk/utterance');
    expect(post.init.headers).toMatchObject({ 'X-Agent007-Talk': '1', 'Content-Type': 'audio/wav', 'X-Utterance-Id': expect.any(String) });
    expect(post.init.body.byteLength).toBe(44 + 3200);
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
    routes['/api/talk/utterance'] = () => response({ ok: true, id: 'm2' });
    await utterance();
    const second = requests.filter(r => r.url === '/api/talk/utterance')[1];
    expect(second.init.headers['X-Echo-Of']).toBe('r1');
  });

  it('a network failure retries the same utterance id, never a new one', async () => {
    await talking();
    let fails = 1;
    routes['/api/talk/utterance'] = () => { if (fails-- > 0) throw new TypeError('network'); return response({ ok: true, id: 'm1' }); };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vadOpts.onSpeechEnd(new Float32Array(160));
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();
    await flush();
    const posts = requests.filter(r => r.url === '/api/talk/utterance');
    expect(posts).toHaveLength(2);
    expect(posts[1].init.headers['X-Utterance-Id']).toBe(posts[0].init.headers['X-Utterance-Id']);
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
    routes['/api/talk/utterance'] = () => response({ ok: true, echo: true });
    await utterance();
    expect(bar().querySelector('.talk-detail').textContent).toMatch(/Billion's own voice/);
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
    await wait(0);
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
    await wait(PROGRESS_QUIET_MS - 100);
    expect(said()).toEqual([]);
    await wait(100);
    expect(said()).toEqual(['status#0']);
    theAudio.end();
    await wait(0);

    heading(true);                                // "Starting…" -> "Working…"
    await wait(300);
    expect(said()).toHaveLength(2);
    theAudio.end();
    await wait(0);
    heading(true);
    await wait(5000);
    expect(said()).toHaveLength(2);

    heading(true, 'Reading the talk code');       // a status line wins
    await wait(300);
    expect(said()).toHaveLength(3);
    theAudio.end();
    await wait(0);
    heading(true);                                // cleared: the heading again
    await wait(300);
    expect(said()).toHaveLength(4);
    expect(requests.some(r => r.url.includes('/audio/cue/'))).toBe(false);
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
