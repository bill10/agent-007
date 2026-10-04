// Records the phone-call demo (docs/phone-call-teaser.gif and phone-call.mp4):
// a Talk to Billion call on a phone, from the spoken request to the merged PR.
// Same scratch server as record.mjs (scratch.mjs, stub claude and gh), run
// with DEMO_SCRIPT=phone. Two phones are recorded at once, one on the call and
// one on the Jobs tab, and the video cuts between them without dropping time,
// so the soundtrack stays where it happened.
//
// The owner's lines are macOS `say` (OWNER_VOICE) fed to the page as its
// speech recognition's result; Billion's are the audio the page itself played
// (the server's `say`, SAY_VOICE), captured as it played. Captions are burned
// in, and the video says it is scripted, sped up and text-to-speech.
//
// DEMO_MEDIA=<folder> swaps in generated media where its files exist:
// opening.mp4 (a cold open whose own audio is the owner's first line, so owner1.wav
// is not played again), owner1.wav and owner2.wav for the owner's lines,
// billion1-4.wav dubbed over Billion's four lines where the page spoke them.
// The video then says the voices are AI-generated.
//
// Needs macOS (say), Google Chrome, ffmpeg, and playwright:
//   npm i --no-save playwright
//   node scripts/demo/phone-call.mjs [out-dir]     (default: a temp folder)
//
// Then docs/phone-call-teaser.gif is copied from out-dir, and the MP4 goes on
// the latest release: gh release upload <tag> out-dir/phone-call.mp4 --clobber
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright';
import { startScratchServer, sleep } from './scratch.mjs';

const OWNER_VOICE = process.env.OWNER_VOICE || 'Evan (Enhanced)';
const BILLION_VOICE = process.env.BILLION_VOICE || 'Ava (Premium)';
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
  env: { DEMO_SCRIPT: 'phone', SAY_VOICE: BILLION_VOICE, DEMO_PACE_DARK: '2800', DEMO_PACE_REVIEW: '4000' },
});
// One merged PR already, so the worker's is #42.
writeFileSync(join(home, 'demo-prs.json'), JSON.stringify([{ number: 41, url: 'https://github.com/acme/shop/pull/41', head: 'earlier', state: 'MERGED', mergedAt: new Date().toISOString(), isDraft: false, isCrossRepository: false }]));
const out = process.argv[2] || join(home, 'out');
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
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
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
// When Billion started saying it (the piece has ended by then).
async function heard(re) {
  for (let i = 0; ; i++) {
    const clip = clips.find(c => re.test(c.text));
    if (clip) return clip.at;
    if (i > 1800) throw new Error(`Billion never said ${re}`);
    await sleep(50);
  }
}

// The edit: which phone is on screen from when, and the captions.
const cuts = [];
const cut = (src, at = Date.now()) => cuts.push({ src, at });
const captions = [];
// With a cold open, owner1 is the opening's own audio: the UI segment skips the
// silent wait (and the caption), and starts just before the request's bubble.
const coldOpen = !!media('opening.mp4');
let bubbleAt = 0;
async function ownerSays(key) {
  await callState('listening');
  const at = Date.now();
  const inOpening = coldOpen && key === 'owner1';
  if (!inOpening) captions.push({ who: 'You', text: LINES[key], at, file: ownerClips[key].file });
  await sleep(ownerClips[key].ms + 250);
  if (!await A.evaluate(t => window.__demoHear(t), LINES[key])) throw new Error('the call was not listening');
  if (inOpening) bubbleAt = Date.now();
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
await sleep(Math.max(0, reply + 3500 - Date.now()));
// 3. The board: the card lands and a worker picks it up.
cut('B');
await cardIn('in-progress');
await sleep(2500);
await tap(B, B.locator('.job-card-live').first());
await sleep(8000);
await tap(B, B.locator('.terminal-tab.board-tab:not(.waiting-tab)'), 0);
// 4. "Tell me when it's merged": the call waits on the work and says how it goes.
cut('A');
await ownerSays('owner2');
await sleep(3500);
cut('B');
await cardIn('review');
const ci = await heard(/Tests passed/);
cut('A', ci - 300);
await heard(/Merged/);
// 5. The card files away as merged. Its worker's tab closing takes the second
// phone off the board, so it goes back (off screen) and opens the finished jobs.
await until(B, () => !document.querySelector('.job-column[data-state="review"] .job-card'));
await sleep(600);
await B.locator('.terminal-tab.board-tab:not(.waiting-tab)').click();
await sleep(300);
cut('B');
await tap(B, B.locator('#btn-finished-jobs'), 2800);
cut('A');
await callState('listening');
await sleep(5000);
const end = Date.now();

const [videoA, videoB] = [await filmA.stop(end), await filmB.stop(end)];
await Promise.all([ctxA.close(), ctxB.close()]);

// The captions: the owner's lines and what Billion said, as long as each was heard.
// A generated take plays in full unless the page cut that line off.
for (const c of clips) {
  const [, take, line] = DUB.find(([re, f]) => re.test(c.text) && media(f)) || [];
  const heardMs = c.end - c.at;
  const cutOff = heardMs < duration(c.file) * 1000 - 300;
  captions.push(take
    ? { who: 'Billion', text: line, at: c.at, file: media(take), ms: cutOff ? heardMs : undefined }
    : { who: 'Billion', text: c.text, at: c.at, ms: heardMs, file: c.file });
}
captions.sort((a, b) => a.at - b.at);
captions.forEach((c, i) => {
  const next = captions[i + 1]?.at ?? Infinity;
  c.ms = Math.min(c.ms ?? duration(c.file) * 1000, next - c.at);
  c.until = Math.min(c.at + c.ms + 700, next);
});
const dubbed = captions.some(c => c.file.startsWith(process.env.DEMO_MEDIA || '\0'));

// --- Stills: the frame around the phone, the captions, the end card ---

const W = 1080, H = 1920;
const screen = { width: 766, height: 1658, x: 157, y: 100 };
const FONT = `font-family: -apple-system, 'Helvetica Neue', sans-serif;`;
const still = await browser.newPage({ viewport: { width: W, height: H } });
async function render(file, html, size = { width: W, height: H }) {
  await still.setViewportSize(size);
  await still.setContent(`<body style="margin:0;${FONT}">${html}</body>`);
  await still.screenshot({ path: file, omitBackground: true });
}
const NOTE = dubbed
  ? 'Scripted demo · sped up · voices are AI-generated · opening shot generated with Veo'
  : 'Scripted demo with stand-in agents · sped up · voices are text-to-speech';
const opening = media('opening.mp4');
if (opening) {
  await render(join(out, 'opening.png'), `<div style="position:absolute;bottom:90px;width:100%;text-align:center;color:#fff;font-size:28px;
    text-shadow:0 1px 6px #000">Opening shot generated with Veo</div>`);
}
await render(join(out, 'frame.png'), `
  <div style="position:absolute;left:${screen.x}px;top:${screen.y}px;width:${screen.width}px;height:${screen.height}px;border-radius:48px;
    box-shadow:0 0 0 3px #2a2f37, 0 0 0 3000px #0b0d10"></div>
  <div style="position:absolute;top:34px;width:100%;text-align:center;color:#8b93a1;font-size:24px">${NOTE}</div>`);
const band = H - screen.y - screen.height;   // the captions' strip under the phone
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
for (const [i, c] of captions.entries()) {
  c.png = join(out, `caption-${i}.png`);
  await render(c.png, `<div style="width:${W}px;height:${band}px;display:flex;align-items:center;justify-content:center;text-align:center;
    padding:0 40px;box-sizing:border-box;font-size:48px;line-height:1.2;color:#f2f4f7">
    <div><span style="color:${c.who === 'You' ? '#7cc4ff' : '#e0b04a'};font-weight:600">${c.who}:</span> ${esc(c.text)}</div></div>`,
  { width: W, height: band });
}
const endCard = join(out, 'end.png');
await render(endCard, `<div style="width:${W}px;height:${H}px;background:#0b0d10;color:#f2f4f7;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:34px;text-align:center">
  <div style="font-size:84px;font-weight:700">Agent 007</div>
  <div style="font-size:46px;color:#c9ced6">Talk to your coding agents.</div>
  <div style="margin-top:50px;font-size:38px;color:#e0b04a">github.com/bill10/agent-007</div>
  <div style="font-size:38px;font-family:ui-monospace,Menlo,monospace;color:#f2f4f7">npx @bill10/agent-007</div>
  <div style="position:absolute;bottom:80px;font-size:26px;color:#8b93a1">${NOTE}</div></div>`);
await browser.close();

// --- The cut ---

const s = (ms) => (ms / 1000).toFixed(3);
const first = cuts[0].at;
const total = end - first;
const END_SECONDS = 6;
const looped = (png, seconds = total / 1000) => ['-loop', '1', '-t', String(seconds), '-i', png];
const inputs = ['-f', 'concat', '-safe', '0', '-i', videoA, '-f', 'concat', '-safe', '0', '-i', videoB, ...looped(join(out, 'frame.png')), ...looped(endCard, END_SECONDS)];
const filters = [];
cuts.forEach((c, i) => {
  const to = cuts[i + 1]?.at ?? end;
  const offset = (c.src === 'A' ? filmA : filmB).frames[0].at;
  filters.push(`[${c.src === 'A' ? 0 : 1}:v]trim=start=${s(c.at - offset)}:end=${s(to - offset)},setpts=PTS-STARTPTS,fps=30,scale=${screen.width}:${screen.height}[seg${i}]`);
});
filters.push(`${cuts.map((_, i) => `[seg${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0[phone]`);
filters.push(`color=c=#0b0d10:s=${W}x${H}:r=30:d=${s(total)}[bg]`);
filters.push(`[bg][phone]overlay=${screen.x}:${screen.y}:shortest=1[v0]`);
filters.push(`[v0][2:v]overlay=0:0:shortest=1[v1]`);
let last = 'v1';
captions.forEach((c, i) => {
  inputs.push(...looped(c.png));
  const n = 4 + i;
  filters.push(`[${last}][${n}:v]overlay=0:${screen.y + screen.height}:enable='between(t,${s(c.at - first)},${s(c.until - first)})'[c${i}]`);
  last = `c${i}`;
});
filters.push(`[3:v]fps=30,format=yuv420p,setsar=1[endv]`, `[${last}]format=yuv420p,setsar=1[mainv]`, `anullsrc=r=48000:cl=stereo,atrim=0:${END_SECONDS}[enda]`);
// The voices, each where it was spoken.
const audioStart = 4 + captions.length;
captions.forEach((c, i) => {
  inputs.push('-i', c.file);
  const delay = Math.max(0, Math.round(c.at - first));
  filters.push(`[${audioStart + i}:a]atrim=0:${s(c.ms)},aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[a${i}]`);
});
filters.push(`${captions.map((_, i) => `[a${i}]`).join('')}amix=inputs=${captions.length}:normalize=0,apad,atrim=0:${s(total)}[maina]`);
// The cold open, full-bleed: a portrait crop on the walker (the camera tracks her), its street sound kept.
let OPEN_MS = 0;
const parts = ['[mainv][maina]', '[endv][enda]'];
// The UI segment picks up as the request's bubble appears, the line having been heard in the opening.
const skip = opening && bubbleAt ? Math.max(0, bubbleAt - first - 300) : 0;
if (skip) {
  filters.push(`[mainv]trim=start=${s(skip)},setpts=PTS-STARTPTS[mainv2]`, `[maina]atrim=start=${s(skip)},asetpts=PTS-STARTPTS[maina2]`);
  parts[0] = '[mainv2][maina2]';
}
if (opening) {
  OPEN_MS = Math.round(duration(opening) * 1000);
  const n = audioStart + captions.length;
  inputs.push('-i', opening, ...looped(join(out, 'opening.png'), OPEN_MS / 1000));
  filters.push(`[${n}:v]crop=ih*${W}/${H}:ih:'min(iw-ow,iw*0.28)':0,scale=${W}:${H},fps=30,format=yuv420p,setsar=1[ov]`,
    `[ov][${n + 1}:v]overlay=0:0:shortest=1[openv]`,
    `[${n}:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.8[opena]`);
  parts.unshift('[openv][opena]');
}
filters.push(`${parts.join('')}concat=n=${parts.length}:v=1:a=1[v][a]`);
const mp4 = join(out, 'phone-call.mp4');
ff(...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', mp4);

// The README teaser: the request and Billion's answer, muted, captions burned in.
const askAt = bubbleAt || captions.find(c => c.who === 'You').at;
const answer = captions.find(c => c.at > askAt && c.who === 'Billion' && /Got it/.test(c.text));
const teaserFrom = OPEN_MS + askAt - first - skip - 400;
const gif = join(out, 'phone-call-teaser.gif');
ff('-ss', s(teaserFrom), '-t', s(Math.min(8000, OPEN_MS + answer.until - first - skip + 300 - teaserFrom)), '-i', mp4, '-vf',
  'fps=10,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif);
console.log(`cuts: ${cuts.map(c => `${c.src}@${s(c.at - first)}`).join(' ')}`);
for (const f of [mp4, gif]) console.log(`${f}  ${(statSync(f).size / 1e6).toFixed(1)} MB, ${duration(f).toFixed(1)} s`);
process.exit(0);
