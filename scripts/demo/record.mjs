// Records the README's hero demo (docs/billion-demo.gif and billion-demo.mp4)
// from a scratch server (scratch.mjs): its own HOME and port, and the stub
// claude and gh in scripts/demo/bin, so nothing real is spent and every run
// plays the same.
//
// Needs Google Chrome and ffmpeg installed, and playwright:
//   npm i --no-save playwright
//   node scripts/demo/record.mjs [out-dir]     (default: a temp folder)
//
// Then docs/billion-demo.gif and docs/screenshot.png are copied from out-dir, and the MP4 goes on the
// latest release: gh release upload <tag> out-dir/billion-demo.mp4 --clobber
import { execFileSync } from 'child_process';
import { mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright';
import { startScratchServer, sleep } from './scratch.mjs';

const { home, url, server } = await startScratchServer({
  port: 7107,
  // The login fix finishes after the owner has answered Billion's question.
  env: { DEMO_PACE_DARK: '1100', DEMO_PACE_LOGIN: '2300' },
});
const out = process.argv[2] || join(home, 'out');

mkdirSync(out, { recursive: true });
const size = { width: 1280, height: 800 };
const browser = await chromium.launch({ channel: 'chrome', args: [`--window-size=${size.width},${size.height}`] });
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
const page = await context.newPage();
const video = page.video();
await page.goto(url);
// The scan interval is the scratch setup's, not one anyone would run: its
// "scanning every 0m" stays off screen. And a cursor, since video has none.
await page.addStyleTag({ content: `#job-dispatcher-status { visibility: hidden }
  #demo-cursor { position: fixed; z-index: 99999; pointer-events: none; width: 22px; height: 22px; left: 640px; top: 760px;
    transition: left .5s ease, top .5s ease; filter: drop-shadow(0 1px 2px #000a) }` });
await page.evaluate(() => {
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.innerHTML = '<svg viewBox="0 0 16 16" width="22" height="22"><path d="M2 1l11 7-5 1 3 5-2 1-3-5-4 3z" fill="#fff" stroke="#000" stroke-width="1"/></svg>';
  document.body.appendChild(c);
});
async function click(locator, hold = 350) {
  await locator.waitFor();
  const box = await locator.boundingBox();
  await page.evaluate(({ x, y }) => Object.assign(document.getElementById('demo-cursor').style, { left: `${x}px`, top: `${y}px` }),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await sleep(600);
  await locator.click();
  await sleep(hold);
}
const park = () => page.evaluate(() => Object.assign(document.getElementById('demo-cursor').style, { left: '1180px', top: '660px' }));
const jobsTab = page.locator('.terminal-tab.board-tab:not(.waiting-tab)');
const chatTab = page.locator('.waiting-tab');
const inColumn = (state) => page.locator(`.job-column[data-state="${state}"] .job-card`);
const until = (locator, n = 1) => page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length >= n, [locator, n], { timeout: 90_000 });
const cardsLeft = () => page.waitForFunction(() => !document.querySelector('.job-column .job-card'), null, { timeout: 90_000 });

// 1. The owner gives Billion a goal in the chat.
await sleep(1500);
const box = page.locator('#chat-input');
await click(box, 200);
await box.pressSequentially('Ship dark mode and fix the login bug', { delay: 55 });
await sleep(400);
await click(page.locator('#chat-send'), 0);
// 2. Billion answers and posts two cards; two agents walk to their desks.
await page.locator('.waiting-list').getByText('On it.').waitFor({ timeout: 30_000 });
await sleep(2200);
await click(jobsTab);
await until('.job-column[data-state="in-progress"] .job-card', 2);
await sleep(3000);
await click(page.locator('.terminal-tab[data-session-id]').first());
await sleep(4000);
// 3. One card reaches Review; Billion merges it and the board files it away.
await click(jobsTab);
await until('.job-column[data-state="review"] .job-card');
await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 1, null, { timeout: 90_000 });
await sleep(1500);
// 4. Billion asks the owner one question; the owner taps the recommended answer.
await click(chatTab);
await page.locator('.waiting-list .waiting-choice.recommended').waitFor({ timeout: 60_000 });
await sleep(2500);
const cursor = page.locator('#demo-cursor');
await cursor.evaluate(c => { c.style.display = 'none'; });
await page.screenshot({ path: join(out, 'screenshot.png') });   // docs/screenshot.png
await cursor.evaluate(c => { c.style.display = ''; });
await click(page.locator('.waiting-list .waiting-choice.recommended'));
await park();   // off Billion's reply, which lands where the button was
await page.locator('.waiting-list').getByText('Skipping it').waitFor({ timeout: 30_000 });
await sleep(1500);
// 5. The last card merges; the board is empty and Billion says what shipped.
await click(jobsTab);
await cardsLeft();
await sleep(2000);
await click(chatTab);
await page.locator('.waiting-list').getByText('Shipped:').waitFor({ timeout: 60_000 });
await sleep(4500);

await context.close();
await browser.close();
server.kill();
const webm = await video.path();
const mp4 = join(out, 'billion-demo.mp4');
const gif = join(out, 'billion-demo.gif');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
ff('-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', mp4);
ff('-i', webm, '-vf', 'fps=8,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif);
for (const f of [mp4, gif, join(out, 'screenshot.png')]) console.log(`${f}  ${(statSync(f).size / 1e6).toFixed(1)} MB`);
process.exit(0);
