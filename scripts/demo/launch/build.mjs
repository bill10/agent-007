// Writes index.html, the HyperFrames composition of the phone-call demo, from
// what ../phone-call.mjs recorded into assets/ (edit.json, the two phones'
// films, the voices). Run again after a design change; no re-recording needed.
// Render: npx hyperframes@0.8.137 render scripts/demo/launch --fps 30 --quality high -o out/phone-call.mp4
//
// The look is the product-launch-video skill's Broadside preset on Agent 007's
// own colors: a flat ink plane, one gold accent, Barlow display, IBM Plex Mono
// chrome, hairline borders, a karaoke caption plate. The beats: a title (1 s),
// a setup line (1.4 s), the phones from the tap that opens the call (a
// crossfade at every cut, a small push where the phone changes), the end card
// (3 s), with the disclosure line throughout.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const edit = JSON.parse(readFileSync(join(here, 'assets', 'edit.json'), 'utf8'));
const W = 1080, H = 1920;
const TITLE = 1.05;   // the setup line comes in as the title goes
const SETUP = 1.4;    // the setup line, then the phones
const START = TITLE + SETUP;
const FADE = 0.25;    // the crossfade at each cut
const END = 3.0;
const endAt = START + edit.total - 0.6;   // the last moment on the call is held under the end card's way in
const total = endAt + END;
const NOTE = edit.dubbed
  ? 'Scripted demo · sped up · voices are text-to-speech'
  : 'Scripted demo with stand-in agents · sped up · voices are text-to-speech';
const PHONE = { label: { call: 'On the call', board: 'Meanwhile' } };
const n = (x) => +x.toFixed(3);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const segs = edit.segments.map((s, i) => {
  // The outgoing segment plays on under the incoming one's fade.
  const tail = i < edit.segments.length - 1 ? FADE : 0;
  return `<div class="seg" id="seg-${i}" style="z-index:${i + 1}"><video id="v-${i}" src="assets/${s.src}" data-start="${n(START + s.start)}" data-duration="${n(s.duration + tail)}" data-media-start="${n(s.from)}" data-track-index="${i % 2}" muted playsinline></video></div>`;
});
const voices = edit.lines.map((l, i) =>
  `<audio id="voice-${i}" src="assets/${l.voice}" data-start="${n(START + l.start)}" data-duration="${n(l.duration)}" data-track-index="10" data-volume="1"></audio>`);
const plates = edit.lines.map((l, i) => `<div class="plate ${l.who === 'You' ? 'you' : 'billion'}" id="cap-${i}">
  <div class="who">${l.who === 'You' ? 'You' : 'Billion'}</div>
  <div class="line">${l.words.map((w, j) => `<span class="w" id="w-${i}-${j}">${esc(w.text)}</span>`).join(' ')}</div></div>`);

const timeline = [];
const at = (t) => n(t);
// Title: the name rises, the rule draws, then it all lifts away.
timeline.push(
  `tl.from('#title .name', { y: 60, opacity: 0, duration: 0.45, ease: 'power3.out' }, 0.05)`,
  `tl.fromTo('#title .rule', { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: 'power2.out' }, 0.25)`,
  `tl.from('#title .tag', { y: 30, opacity: 0, duration: 0.4, ease: 'power3.out' }, 0.3)`,
  `tl.to('#title', { y: -80, opacity: 0, duration: 0.3, ease: 'power2.in' }, ${at(TITLE - 0.1)})`,
  `tl.set('#setup', { autoAlpha: 1 }, ${at(TITLE)})`,
  `tl.from('#setup .say', { y: 50, opacity: 0, duration: 0.4, ease: 'power3.out', stagger: 0.3 }, ${at(TITLE)})`,
  `tl.to('#setup', { y: -80, opacity: 0, duration: 0.3, ease: 'power2.in' }, ${at(START - 0.15)})`,
  `tl.fromTo('#stage', { y: 90, scale: 0.94, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.45, ease: 'power3.out' }, ${at(START - 0.05)})`,
  `tl.fromTo('#chrome', { opacity: 0 }, { opacity: 1, duration: 0.3 }, ${at(START + 0.2)})`,
);
edit.segments.forEach((s, i) => {
  if (!i) return;
  const t = START + s.start;
  timeline.push(`tl.fromTo('#seg-${i}', { autoAlpha: 0 }, { autoAlpha: 1, duration: ${FADE}, ease: 'none' }, ${at(t)})`);
  if (s.phone !== edit.segments[i - 1].phone) {
    timeline.push(`tl.fromTo('#phone', { scale: 0.975 }, { scale: 1, duration: 0.5, ease: 'power2.out', immediateRender: false }, ${at(t)})`,
      `tl.to('#chip-${edit.segments[i - 1].phone}', { autoAlpha: 0, duration: 0.2 }, ${at(t)})`,
      `tl.to('#chip-${s.phone}', { autoAlpha: 1, duration: 0.2 }, ${at(t + 0.1)})`);
  }
});
// What starts hidden, set before the timeline.
const hidden = ['#setup', '#chip-board', '.plate', '#end', ...edit.segments.slice(1).map((_, i) => `#seg-${i + 1}`)];
// Captions: the plate comes up with the line, each word lights as it is said.
edit.lines.forEach((l, i) => {
  const from = START + l.start, to = START + l.end;
  timeline.push(`tl.fromTo('#cap-${i}', { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.2, ease: 'power2.out' }, ${at(from)})`,
    `tl.to('#cap-${i}', { autoAlpha: 0, duration: 0.15 }, ${at(Math.max(from + 0.3, to - 0.15))})`);
  l.words.forEach((w, j) => {
    timeline.push(`tl.set('#w-${i}-${j}', { className: 'w is-active' }, ${at(START + w.start)})`,
      `tl.set('#w-${i}-${j}', { className: 'w is-spoken' }, ${at(START + (l.words[j + 1]?.start ?? w.end + 0.1))})`);
  });
  timeline.unshift(...l.words.map((_, j) => `tl.set('#w-${i}-${j}', { className: 'w' }, 0)`));
});
// End card: the phones step back, the card comes up a line at a time.
timeline.push(
  `tl.to('#stage', { scale: 0.92, opacity: 0, duration: 0.35, ease: 'power2.in' }, ${at(endAt)})`,
  `tl.to('#chrome', { opacity: 0, duration: 0.3 }, ${at(endAt)})`,
  `tl.fromTo('#end', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, ${at(endAt + 0.2)})`,
  `tl.from('#end .name', { y: 60, opacity: 0, duration: 0.45, ease: 'power3.out' }, ${at(endAt + 0.25)})`,
  `tl.fromTo('#end .rule', { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: 'power2.out' }, ${at(endAt + 0.45)})`,
  `tl.from('#end .tag', { y: 30, opacity: 0, duration: 0.4, ease: 'power3.out' }, ${at(endAt + 0.5)})`,
  `tl.from('#end .repo', { y: 24, opacity: 0, duration: 0.4, ease: 'power3.out' }, ${at(endAt + 0.8)})`,
  `tl.from('#end .cmd', { y: 24, opacity: 0, duration: 0.4, ease: 'power3.out' }, ${at(endAt + 0.95)})`,
);

const lockup = (id) => `<div id="${id}" class="lockup"><div class="name">Agent 007</div><div class="rule"></div><div class="tag">Talk to your coding agents.</div>${id === 'end'
  ? '<div class="repo">github.com/bill10/agent-007</div><div class="cmd"><span>$</span> npx @bill10/agent-007</div>' : ''}</div>`;

writeFileSync(join(here, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@600;800;900&family=IBM+Plex+Mono:wght@500&display=block" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  :root { --ink: #090a0c; --ink-alt: #121418; --line: #1f2228; --cream: #ece9e2; --muted: #9ca3af; --gold: #d4a847; --blue: #7cc4ff; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: var(--ink); }
  #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: var(--ink); color: var(--cream); font-family: Barlow, system-ui, sans-serif; }
  .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-weight: 500; font-size: 22px; letter-spacing: 0.14em; text-transform: uppercase; }
  #chrome { position: absolute; left: 194px; right: 194px; top: 44px; height: 30px; }
  #chrome .chip { position: absolute; left: 0; top: 0; color: var(--cream); }
  #chrome .chip::before { content: ''; display: inline-block; width: 10px; height: 10px; margin-right: 12px; border-radius: 50%; background: var(--gold); }
  #chrome .brand { position: absolute; right: 0; top: 0; color: var(--muted); }
  #stage { position: absolute; inset: 0; }
  #phone { position: absolute; left: 194px; top: 100px; width: 692px; height: 1498px; border-radius: 52px; overflow: hidden; background: #000;
    box-shadow: 0 0 0 2px #2a2f37, 0 0 0 12px var(--ink-alt), 0 0 0 13px var(--line); }
  .seg { position: absolute; inset: 0; }
  .seg video { width: 692px; height: 1498px; object-fit: cover; display: block; }
  #captions { position: absolute; left: 40px; right: 40px; top: 1632px; height: 214px; }
  .plate { position: absolute; left: 0; right: 0; top: 0; bottom: 0; margin: auto; height: fit-content; width: fit-content; max-width: 1000px;
    padding: 16px 36px 22px; background: var(--ink-alt); border: 1px solid var(--line); border-left: 3px solid var(--sp); }
  .plate.you { --sp: var(--blue); } .plate.billion { --sp: var(--gold); }
  .plate .who { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-weight: 500; font-size: 20px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sp); margin-bottom: 6px; }
  .plate .line { font-weight: 800; font-size: 52px; line-height: 1.12; letter-spacing: -0.015em; }
  .w { color: #6a6e77; padding: 0 0.04em; }
  .w.is-active { color: var(--ink); background: var(--sp); box-shadow: 0 0 0 0.05em var(--sp); }
  .w.is-spoken { color: var(--cream); }
  #note { position: absolute; left: 0; right: 0; top: 1868px; text-align: center; color: var(--muted); font-size: 19px; letter-spacing: 0.1em; }
  .lockup { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .lockup .name { font-weight: 900; font-size: 168px; line-height: 0.9; letter-spacing: -0.04em; }
  .lockup .rule { width: 520px; height: 2px; margin: 44px 0 36px; background: var(--gold); transform-origin: left center; }
  #setup .say { font-weight: 900; font-size: 92px; line-height: 1.05; letter-spacing: -0.03em; }
  #setup .gold { color: var(--gold); margin-top: 14px; }
  .lockup .tag { font-weight: 600; font-size: 56px; color: var(--cream); }
  #end .repo { margin-top: 120px; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-weight: 500; font-size: 40px; color: var(--cream); }
  #end .cmd { margin-top: 36px; padding: 22px 40px; border: 1px solid var(--gold); background: var(--ink-alt);
    font-family: 'IBM Plex Mono', ui-monospace, monospace; font-weight: 500; font-size: 44px; color: var(--cream); }
  #end .cmd span { color: var(--gold); }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${n(total)}">
  ${lockup('title')}
  <div id="setup" class="lockup"><div class="say">Ask for a change on a call.</div><div class="say gold">Hear it merged.</div></div>
  <div id="stage"><div id="phone">
    ${segs.join('\n    ')}
  </div></div>
  <div id="chrome"><div id="chip-call" class="chip mono">${PHONE.label.call}</div><div id="chip-board" class="chip mono">${PHONE.label.board}</div><div class="brand mono">Agent 007</div></div>
  <div id="captions">
  ${plates.join('\n  ')}
  </div>
  ${lockup('end')}
  <div id="note" class="mono">${NOTE}</div>
  ${voices.join('\n  ')}
</div>
<script>
  gsap.set(${JSON.stringify(hidden.join(', '))}, { autoAlpha: 0 });
  const tl = gsap.timeline({ paused: true });
  ${timeline.join(';\n  ')};
  window.__timelines['main'] = tl;
</script>
</body>
</html>
`);
console.log(`${join(here, 'index.html')}: ${n(total)} s, ${edit.segments.length} segments, ${edit.lines.length} lines`);
