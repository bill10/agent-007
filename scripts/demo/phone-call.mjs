// Records the phone-call demo (phone-call.mp4, and docs/phone-call-teaser.gif
// cut from it): a Talk to Billion call on a phone, from the spoken request to
// the merged PR. Same scratch server as record.mjs (scratch.mjs, stub claude
// and gh), run with DEMO_SCRIPT=phone. Two phones are recorded at once, one on
// the call and one on the Jobs tab, and the edit cuts between them without
// dropping time, so the soundtrack stays where it happened.
//
// The owner's lines are macOS `say` (OWNER_VOICE) fed to the page as its
// speech recognition's result; Billion's are the audio the page itself played
// (the server's `say`, SAY_VOICE), captured as it played.
//
// DEMO_MEDIA=<folder> swaps in generated voices where its files exist:
// owner1.wav and owner2.wav for the owner's lines (one voice), billion1-4.wav
// dubbed over Billion's four lines where the page spoke them (another voice).
//
// The video starts on the request; waits where nothing happens on screen (the
// call coming up, the worker typing on, the board's scan) are cut out of it.
//
// This script records. The video itself is a HyperFrames composition in
// scripts/demo/launch/ (product-launch-video skill): this script leaves the two
// phones' films, the voices and edit.json (the cut, each line with its word
// timings) in launch/assets/, and launch/build.mjs writes launch/index.html
// from them: a title beat, the phones with crossfades at each cut, karaoke
// captions, the end card and the disclosure line.
//
// Needs macOS (say), Google Chrome, ffmpeg, playwright, and HyperFrames (npx,
// Node 22; its local whisper times the captions' words):
//   npm i --no-save playwright
//   node scripts/demo/phone-call.mjs [out-dir]     (raw frames; default: a temp folder)
//   node scripts/demo/launch/build.mjs             (edit.json → index.html; run again to restyle)
//   npx hyperframes@0.8.137 render scripts/demo/launch --fps 30 --quality high -o out/phone-call.mp4
//
// The README teaser is the request and Billion's answer from that MP4, muted:
//   ffmpeg -ss 0.9 -t 7 -i out/phone-call.mp4 -vf "fps=10,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" docs/phone-call-teaser.gif
// and the MP4 goes on the latest release: gh release upload <tag> out/phone-call.mp4 --clobber
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'fs';
import { join, resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { startScratchServer, sleep } from './scratch.mjs';

// The owner is a woman's voice, Billion a man's, so the two never blur.
const OWNER_VOICE = process.env.OWNER_VOICE || 'Ava (Premium)';
const BILLION_VOICE = process.env.BILLION_VOICE || 'Evan (Enhanced)';
const LINES = {
  owner1: 'Hey Billion, add a dark mode toggle to the settings page.',
  owner2: 'Thanks. Tell me when it\'s merged.',
};
const media = (name) => (process.env.DEMO_MEDIA && existsSync(join(process.env.DEMO_MEDIA, name)) ? join(process.env.DEMO_MEDIA, name) : null);
// Billion's lines as the page spoke them → the generated take and its caption.
const DUB = [
  [/^Got it/, 'billion1.wav', 'Got it. I\'ll put a card on the board.'],
  [/^Reviewing/, 'billion2.wav', 'Reviewing PR 42.'],
  [/^Tests passed/, 'billion3.wav', 'Tests passed. Merging.'],
  [/^Merged/, 'billion4.wav', 'Merged. It\'s live after the next update.'],
];

const { home, url } = await startScratchServer({
  port: 7117,
  env: { DEMO_SCRIPT: 'phone', SAY_VOICE: BILLION_VOICE, DEMO_PACE_DARK: '1500', DEMO_PACE_REVIEW: '2600' },
});
// One merged PR already, so the worker's is #42.
writeFileSync(join(home, 'demo-prs.json'), JSON.stringify([{ number: 41, url: 'https://github.com/acme/shop/pull/41', head: 'earlier', state: 'MERGED', mergedAt: new Date().toISOString(), isDraft: false, isCrossRepository: false }]));
const out = resolve(process.argv[2] || join(home, 'out'));
mkdirSync(out, { recursive: true });
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));

// The owner's voice, made first so its length is known when it is "spoken".
const ownerClips = {};
for (const [key, text] of Object.entries(LINES)) {
  let file = media(`${key}.wav`);
  if (!file) execFileSync('say', ['-v', OWNER_VOICE, '-o', (file = join(out, `${key}.aiff`)), text]);
  ownerClips[key] = { file, ms: duration(file) * 1000 };
}
const GAP = 400;   // after each line, before the next beat

// --- The two phones ---

const phone = { width: 390, height: 844 };
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const contextFor = () => browser.newContext({
  viewport: phone, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark',
});
const [ctxA, ctxB] = [await contextFor(), await contextFor()];
// The call's page: its speech recognition is the script, and every reply it
// plays is handed back for the soundtrack.
await ctxA.addInitScript(() => {
  try { localStorage.setItem('agent007-talk-browser-stt', '1'); } catch {}
  class Recognition { start() { window.__demoRec = this; } abort() { if (window.__demoRec === this) window.__demoRec = null; } stop() { this.abort(); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = Recognition;
  window.__demoHear = (text) => {
    const r = window.__demoRec;
    if (!r) return false;
    const result = [{ transcript: text }];
    result.isFinal = true;
    r.onresult({ resultIndex: 0, results: [result] });
    return true;
  };
  // Billion's set_status line, which a status piece speaks.
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (e) => {
        try { const m = JSON.parse(e.data); if (m.type === 'billion-status') window.__demoStatus = m; } catch {}
      });
    }
  };
  // Which reply or status line each audio piece is, from the URL it came from.
  const pieces = new Map();   // blob URL → { from: /api/talk/audio/<id>/<i>, blob }
  const fetch0 = window.fetch;
  window.fetch = async (input, init) => {
    const res = await fetch0(input, init);
    const from = String(input?.url || input);
    if (from.includes('/api/talk/audio/')) {
      const blob = res.blob.bind(res);
      res.blob = async () => Object.assign(await blob(), { demoFrom: from });
    }
    return res;
  };
  const create = URL.createObjectURL;
  URL.createObjectURL = (b) => { const u = create.call(URL, b); if (b.demoFrom) pieces.set(u, { from: b.demoFrom, blob: b }); return u; };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const piece = pieces.get(this.src);
    if (piece) {
      const { from, blob } = piece;
      const id = decodeURIComponent(from.split('/api/talk/audio/')[1].split('/')[0]);
      const text = id === 'status'
        ? window.__demoStatus?.text || 'Working on your message'
        : document.querySelector(`[data-id="${CSS.escape(id)}"] .chat-text, [data-id="${CSS.escape(id)}"]`)?.innerText || '';
      const at = Date.now();
      // From the blob itself: the page revokes its URL as soon as a piece is cut off.
      const bytes = blob.arrayBuffer();
      let done = false;
      // Until it ends or is cut off: the soundtrack holds what was heard.
      const stop = () => {
        if (done) return;
        done = true;
        const end = Date.now();
        bytes.then(buf => {
          const u8 = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
          window.__demoAudio({ at, end, text, b64: btoa(bin) });
        });
      };
      // Changing src fires pause and emptied for the piece before: count from when this one plays.
      this.addEventListener('playing', () => { for (const e of ['ended', 'pause', 'error']) this.addEventListener(e, stop, { once: true }); }, { once: true });
    }
    return play.call(this);
  };
});
const clips = [];   // Billion's speech as played: { at, end, text, file }
await ctxA.exposeFunction('__demoAudio', ({ at, end, text, b64 }) => {
  const file = join(out, `billion-${clips.length + 1}.m4a`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  clips.push({ at, end, text: text.trim().split('\n')[0], file });
  console.log(`[demo] Billion said "${clips.at(-1).text}" at +${((at - t0) / 1000).toFixed(1)}s for ${((end - at) / 1000).toFixed(1)}s`);
});

// Each phone filmed as fast as it can be screenshot, at 2x: Playwright's own
// video records at CSS size, too soft once scaled up. The frames' times make
// the video (ffmpeg's concat with durations).
function film(page, name) {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const frames = [];
  let rolling = true;
  const done = (async () => {
    const cdp = await page.context().newCDPSession(page);
    while (rolling) {
      const at = Date.now();
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88, clip: { x: 0, y: 0, ...phone, scale: 2 } });
      const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ at, file });
    }
  })();
  return {
    frames,
    // The frame list for ffmpeg, its clock starting at the first frame.
    async stop(until) {
      rolling = false;
      await done;
      const list = join(out, `${name}.txt`);
      writeFileSync(list, frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? until) - f.at) / 1000).toFixed(3)}\n`).join('')
        + `file '${frames.at(-1).file}'\n`);
      return list;
    },
  };
}

const A = await ctxA.newPage();
const B = await ctxB.newPage();
const t0 = Date.now();
// A touch, since video has no cursor: a ring where the finger lands.
// The call bar's privacy line is hidden: the scratch server has no whisper.cpp,
// so it would name the browser's recognition, which a real setup doesn't use.
const STYLE = `#job-dispatcher-status { visibility: hidden }
  #talk-bar .talk-privacy { display: none !important }
  .demo-tap { position: fixed; z-index: 99999; pointer-events: none; width: 44px; height: 44px; margin: -22px 0 0 -22px;
    border-radius: 50%; background: #fff4; border: 2px solid #fffc; animation: demo-tap .6s ease-out forwards }
  @keyframes demo-tap { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.3); opacity: 0 } }`;
for (const p of [A, B]) {
  await p.goto(url);
  await p.addStyleTag({ content: STYLE });
}
const [filmA, filmB] = [film(A, 'phone-a'), film(B, 'phone-b')];
async function tap(page, locator, hold = 400) {
  await locator.waitFor();
  const box = await locator.boundingBox();
  await page.evaluate(({ x, y }) => {
    const ring = document.createElement('div');
    ring.className = 'demo-tap';
    Object.assign(ring.style, { left: `${x}px`, top: `${y}px` });
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 700);
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await sleep(150);
  await locator.click();
  await sleep(hold);
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 90_000 });
const callState = (state) => until(A, (s) => document.getElementById('talk-bar')?.dataset.state === s, state);
const cardIn = (state) => until(B, (s) => !!document.querySelector(`.job-column[data-state="${s}"] .job-card`), state);
// When Billion started saying it (the piece has ended by then), and for how
// long the video will: the generated take where there is one.
async function heard(re) {
  for (let i = 0; ; i++) {
    const clip = clips.find(c => re.test(c.text));
    if (clip) {
      const take = DUB.map(([r, f]) => r.test(clip.text) && media(f)).find(Boolean);
      return { at: clip.at, end: clip.at + (take ? duration(take) * 1000 : clip.end - clip.at) };
    }
    if (i > 1800) throw new Error(`Billion never said ${re}`);
    await sleep(50);
  }
}

// The edit: which phone is on screen from when, and the captions.
const cuts = [];
const cut = (src, at = Date.now()) => cuts.push({ src, at });
const captions = [];
// Spans of dead air cut out of the video: [from, to], real time.
const drops = [];
let askedAt = 0;   // when the request reached the page
async function ownerSays(key) {
  await callState('listening');
  captions.push({ who: 'You', text: LINES[key], at: Date.now(), file: ownerClips[key].file });
  await sleep(ownerClips[key].ms + 250);
  if (!await A.evaluate(t => window.__demoHear(t), LINES[key])) throw new Error('the call was not listening');
  if (key === 'owner1') askedAt = Date.now();
}

// 1. The Billion tab; the owner taps the phone button and the call bar comes up.
await B.locator('.terminal-tab.board-tab:not(.waiting-tab)').click();   // the second phone waits on the board
await sleep(1500);
cut('A');
await sleep(2500);
await tap(A, A.locator('#chat-talk'), 0);
await callState('listening');
await sleep(2000);
// 2. The request, and Billion's answer.
await ownerSays('owner1');
const reply = await heard(/Got it/);
// The wait while the server voices the reply, its text already on screen.
drops.push([askedAt + 700, reply.at - 250]);
await sleep(Math.max(0, reply.end + GAP - Date.now()));
// 3. The board: the card lands and a worker picks it up.
cut('B');
await cardIn('in-progress');
await sleep(800);
await tap(B, B.locator('.job-card-live').first());
await sleep(2500);
await tap(B, B.locator('.terminal-tab.board-tab:not(.waiting-tab)'), 0);
// 4. "Tell me when it's merged": the call waits on the work and says how it goes.
cut('A');
await ownerSays('owner2');
await sleep(GAP);
cut('B');
await sleep(1200);
const idle = Date.now();
await cardIn('review');
drops.push([idle, Date.now() - 800]);
const ci = await heard(/Tests passed/);
cut('A', ci.at - 300);
const merged = await heard(/Merged/);
// 5. The card files away as merged. Its worker's tab closing takes the second
// phone off the board, so it goes back (off screen) and opens the finished jobs.
await sleep(Math.max(0, merged.end + GAP - Date.now()));
const filing = Date.now();
await until(B, () => !document.querySelector('.job-column[data-state="review"] .job-card'));
await sleep(600);
await B.locator('.terminal-tab.board-tab:not(.waiting-tab)').click();
await sleep(300);
drops.push([filing, Date.now()]);
cut('B');
await tap(B, B.locator('#btn-finished-jobs'), 1800);
cut('A');
await callState('listening');
await sleep(1500);
const end = Date.now();

const [videoA, videoB] = [await filmA.stop(end), await filmB.stop(end)];
await browser.close();

// The captions: the owner's lines and what Billion said, as long as each was heard.
// A generated take plays in full up to the next line: the page stops a status
// piece when the status clears, which only says how slow its own voice was.
for (const c of clips) {
  const [, take, line] = DUB.find(([re, f]) => re.test(c.text) && media(f)) || [];
  captions.push(take
    ? { who: 'Billion', text: line, at: c.at, file: media(take) }
    : { who: 'Billion', text: c.text, at: c.at, ms: c.end - c.at, file: c.file });
}
captions.sort((a, b) => a.at - b.at);
captions.forEach((c, i) => {
  const next = captions[i + 1]?.at ?? Infinity;
  c.ms = Math.min(c.ms ?? duration(c.file) * 1000, next - c.at);
  c.until = Math.min(c.at + Math.max(c.ms + GAP, 1200), next);
});
// The video starts on the request: the call coming up is cut.
const first = cuts[0].at;
drops.unshift([first, captions[0].at - 300]);
// A drop never takes a line or its caption with it.
for (const d of drops) {
  for (const c of captions) {
    if (c.at < d[0] && c.until > d[0]) d[0] = c.until;
    if (c.at >= d[0] && c.at < d[1]) d[1] = c.at - 300;
  }
}

// --- The edit, for scripts/demo/launch (HyperFrames) ---

const assets = join(dirname(fileURLToPath(import.meta.url)), 'launch', 'assets');
rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
// Each phone's film at a steady 30 fps, its clock starting at its first frame.
const films = { A: filmA, B: filmB };
for (const [src, list] of [['A', videoA], ['B', videoB]]) {
  ff('-f', 'concat', '-safe', '0', '-i', list, '-fps_mode', 'cfr', '-r', '30', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', join(assets, `phone-${src.toLowerCase()}.mp4`));
}
// Recording time (ms since the first cut) → the video's, the dead air gone.
const cutOut = drops.map(d => d.map(t => t - first)).filter(([a, b]) => b - a > 500).sort((x, y) => x[0] - y[0]);
const keep = [];
let from = 0;
for (const [a, b] of cutOut) {
  if (a > from) keep.push([from, a]);
  from = Math.max(from, b);
}
keep.push([from, end - first]);
const mapT = (t) => t - cutOut.filter(([, b]) => b <= t).reduce((n, [a, b]) => n + b - a, 0);
// The segments: a new one at every cut between the phones and every drop.
const segments = [];
for (const [a, b] of keep) {
  const marks = [a, ...cuts.map(c => c.at - first).filter(t => t > a && t < b), b];
  for (let i = 0; i < marks.length - 1; i++) {
    const src = cuts.findLast(c => c.at - first <= marks[i]).src;
    segments.push({ src: `phone-${src.toLowerCase()}.mp4`, phone: src === 'A' ? 'call' : 'board',
      from: (first + marks[i] - films[src].frames[0].at) / 1000, start: mapT(marks[i]) / 1000, duration: (marks[i + 1] - marks[i]) / 1000 });
  }
}
// Each line's words, timed by HyperFrames' local whisper where it heard as many
// words as the line has; spread over the line by length where it didn't.
function wordsOf(file, text, seconds) {
  const words = text.split(/\s+/);
  let heard = [];
  try {
    const { transcriptPath } = JSON.parse(execFileSync('npx', ['-y', 'hyperframes@0.8.137', 'transcribe', file, '--json'], { cwd: out, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    heard = JSON.parse(readFileSync(transcriptPath, 'utf8'));
  } catch {}
  if (heard.length === words.length) return words.map((w, i) => ({ text: w, start: heard[i].start, end: heard[i].end }));
  const [from, to] = heard.length ? [heard[0].start, heard.at(-1).end] : [0, seconds];
  const chars = words.reduce((n, w) => n + w.length + 1, 0);
  let at = 0;
  return words.map(w => ({ text: w, start: from + (at / chars) * (to - from), end: from + ((at += w.length + 1) / chars) * (to - from) }));
}
const lines = captions.map((c, i) => {
  const voice = `voice-${i + 1}${extname(c.file)}`;
  copyFileSync(c.file, join(assets, voice));
  const start = mapT(c.at - first) / 1000;
  return { who: c.who, text: c.text, voice, start, duration: c.ms / 1000, end: mapT(c.until - first) / 1000,
    words: wordsOf(c.file, c.text, c.ms / 1000).map(w => ({ ...w, start: start + w.start, end: start + w.end })) };
});
const total = mapT(end - first) / 1000;
writeFileSync(join(assets, 'edit.json'), JSON.stringify({ total, dubbed: captions.some(c => c.file.startsWith(process.env.DEMO_MEDIA || '\0')), segments, lines }, null, 2));
console.log(`cuts: ${cuts.map(c => `${c.src}@${((c.at - first) / 1000).toFixed(1)}`).join(' ')}; ${segments.length} segments, ${total.toFixed(1)} s`);
await import('./launch/build.mjs');
process.exit(0);
