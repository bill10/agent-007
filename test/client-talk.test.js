// @vitest-environment happy-dom
// Talk to Billion, the page (public/modules/talk.js): a detected utterance
// sent once as WAV, only the reply bound to it spoken (piece by piece from
// the server), speaking over Billion cutting it off and dropping what was not
// played, mute and End stopping the mic, the browser's voice when the server
// has none, and a clear refusal where the browser cannot do it. The voice
// detector, fetch and the audio element are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encodeWav, shouldSpeak, talkState, talkBar, talkButton, startTalk, endTalk, talkHeard, setMuted, talkOn, _resetTalk, _talkInternals,
} from '../public/modules/talk.js';
import { setChatMessages } from '../public/modules/state.js';

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
});
afterEach(() => {
  _resetTalk();
  vi.unstubAllGlobals();
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

describe('the page going away and coming back', () => {
  const setHidden = (value) => {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  afterEach(() => Object.defineProperty(document, 'hidden', { value: false, configurable: true }));

  it('a hidden tab stops the mic and the voice, and the reply plays again when it is back', async () => {
    await talking();
    await utterance();
    talkHeard(reply('r1', 'm1'));
    await flush();
    expect(played).toEqual(['r1#0']);
    setHidden(true);
    await flush();
    expect(theAudio.paused).toBe(true);
    expect(fakeVad.pause).toHaveBeenCalled();
    expect(stateWord()).toBe('paused');
    setHidden(false);
    await flush();
    expect(played).toEqual(['r1#0', 'r1#0']);
  });

  it('after a reload, Resume talking speaks a reply to a turn from before, without showing it as thinking', async () => {
    sessionStorage.setItem('agent007-talk', JSON.stringify({ on: true, awaiting: ['m9'], spoken: [] }));
    vi.resetModules();
    const fresh = await import('../public/modules/talk.js');
    const state = await import('../public/modules/state.js');
    document.body.innerHTML = '';
    document.body.append(fresh.talkBar());
    await flush();
    expect(bar().querySelector('.talk-start').hidden).toBe(false);
    expect(bar().querySelector('.talk-start').textContent).toBe('Resume talking');
    state.setChatMessages([reply('r9', 'm9', 'Late answer.')]);
    await fresh.startTalk();
    await flush();
    expect(requests.some(r => r.url === '/api/talk/audio/r9/0')).toBe(true);
    theAudio.end();
    await flush();
    theAudio.end();
    await flush();
    expect(stateWord()).toBe('listening');
    expect(requests.some(r => r.url.includes('/api/talk/utterance'))).toBe(false);
    fresh._resetTalk();
    sessionStorage.clear();
  });
});

describe('where it cannot run', () => {
  it('says so without a microphone API or outside a secure context', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    await startTalk();
    expect(talkOn()).toBe(false);
    expect(bar().querySelector('.talk-detail').textContent).toMatch(/no microphone API/);
  });

  it('with no whisper.cpp and no speech recognition, links the setup steps', async () => {
    routes['/api/talk'] = () => response({ stt: null, sttMissing: 'Talking needs whisper.cpp on the computer running Agent 007 (brew install whisper-cpp, then WHISPER_MODEL).', tts: 'say' });
    await startTalk();
    await flush();
    expect(talkOn()).toBe(false);
    const detail = bar().querySelector('.talk-detail');
    expect(detail.textContent).toMatch(/brew install whisper-cpp.*no speech recognition/);
    expect(detail.querySelector('a').href).toMatch(/BILLION\.md#voice/);
  });

  it('with no whisper.cpp, asks once before the browser\'s recognition hears anything', async () => {
    const started = vi.fn();
    vi.stubGlobal('webkitSpeechRecognition', class { start() { started(); } abort() {} });
    localStorage.removeItem('agent007-talk-browser-stt');
    routes['/api/talk'] = () => response({ stt: null, sttMissing: 'Talking needs whisper.cpp.', tts: 'say' });
    await startTalk();
    await flush();
    expect(stateWord()).toBe('consent');
    expect(bar().querySelector('.talk-privacy').textContent).toMatch(/Google/);
    expect(started).not.toHaveBeenCalled();
    await startTalk();   // Continue
    await flush();
    expect(started).toHaveBeenCalled();
    expect(stateWord()).toBe('listening');
    expect(localStorage.getItem('agent007-talk-browser-stt')).toBe('1');
  });

  it('a denied microphone ends with how to allow it', async () => {
    window.vad.MicVAD.new = vi.fn(async (opts) => { vadOpts = opts; return { ...fakeVad, start: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } }; });
    await startTalk();
    await flush();
    expect(talkOn()).toBe(false);
    expect(bar().querySelector('.talk-detail').textContent).toMatch(/Microphone access denied/);
  });
});

describe('the composer row and the call bar', () => {
  const row = () => document.getElementById('chat-compose-row');
  const call = () => bar().querySelector('.talk-call');

  it('puts the phone button between the mic and Send, labelled and focusable', () => {
    const ids = [...row().children].map(c => c.id);
    expect(ids.indexOf('chat-talk')).toBe(ids.indexOf('chat-mic') + 1);
    expect(ids.indexOf('chat-talk')).toBe(ids.indexOf('chat-send') - 1);
    const b = document.getElementById('chat-talk');
    expect(b.getAttribute('aria-label')).toBe('Talk to Billion');
    expect(b.title).toMatch(/Talk to Billion/);
    expect(b.tagName).toBe('BUTTON');
    expect(b.querySelector('svg')).not.toBeNull();
    expect(row().hidden).toBe(false);
    expect(call().hidden).toBe(true);
  });

  it('a call swaps the row for the call bar, focus on End; End brings the box back with focus', async () => {
    document.getElementById('chat-talk').click();
    await flush();
    expect(row().hidden).toBe(true);
    expect(call().hidden).toBe(false);
    expect(call().querySelector('.talk-state').textContent).toBe('Listening…');
    expect(call().querySelector('.talk-timer').textContent).toBe('0:00');
    expect(document.activeElement).toBe(call().querySelector('.talk-end'));
    call().querySelector('.talk-end').click();
    expect(row().hidden).toBe(false);
    expect(call().hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('chat-input'));
  });

  it('shows muted and speaking, and Mute toggles', async () => {
    await startTalk();
    await flush();
    call().querySelector('.talk-mute').click();
    expect(call().querySelector('.talk-state').textContent).toBe('Muted');
    expect(call().querySelector('.talk-mute').textContent).toBe('Unmute');
    call().querySelector('.talk-mute').click();
    expect(call().querySelector('.talk-state').textContent).toBe('Listening…');
  });

  it('Esc ends the call', async () => {
    await startTalk();
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(talkOn()).toBe(false);
    expect(row().hidden).toBe(false);
  });
});
