// The "Billion" tab: the owner's chat with Billion, the web twin of the
// Telegram channel. One thread of the owner's messages, Billion's tell_owner
// replies and its notify_owner questions (answered with a tap, or a typed line
// once the owner picks the question with Reply),
// a strip pinning the open questions, and a text box that is typed into
// Billion's terminal as [Owner via app] (server/owner.js ownerSays). Shares the
// terminal viewport with the terminals and the job board, like Jobs does.
// Billion's messages can be read aloud (readaloud.js: a speaker button on
// each, and "Read new messages aloud" in the header), and the box has its own
// mic (voice.js with the CHAT_VOICE target), all in the browser and free.
import { agents, activeSessionId, waitingItems, chatMessages, waitingActive, setWaitingActive, setView, upsertChatMessage, billionEnabled } from './state.js';
import { switchToSession } from './terminal.js';
import { send } from './ws.js';
import { hideJobBoard, attachmentName, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENT_TOTAL_BYTES } from './jobs.js';
import { stopVoice, toggleVoice, appendTranscript } from './voice.js';
import {
  readAloudSupported, speakableText, toggleSpeak, readNew, speakingMessage, stopReading,
  autoReadOn, setAutoRead, needsResume, resumeReading, queuedCount, onReadAloudChange,
  englishVoices, pickVoice, savedVoiceURI, setVoiceURI,
} from './readaloud.js';

const errors = new Map();   // question id -> { error, status }: why the last tap did not go through
const pending = new Map();  // question id -> its status when tapped, waiting for the server to move it on
let sending = null;         // the nonce of the text box's message on its way
let sendError = '';
let replyTo = null;         // the question the owner picked to answer with the box
let undoTimer = null;
let undoSoonest = Infinity;   // ms until the first Undo link on screen goes
let nonces = 0;
const SEND_TIMEOUT_MS = 20 * 1000;
let lastShown = null;       // the newest message when the thread was last drawn
// Files pasted, dropped or picked for the next message: { name, size, type,
// data (base64, once read), reading, url (a thumbnail's object URL) }.
let attached = [];

export const openCount = () => waitingItems.filter(item => item.status === 'open').length;

export function showWaiting() {
  hideJobBoard();
  const agent = activeSessionId ? agents.get(activeSessionId) : null;
  if (agent) agent.termEl.style.display = 'none';
  document.getElementById('terminal-empty').style.display = 'none';
  document.getElementById('waiting-board').style.display = 'flex';
  // The terminal's mic types into a terminal, and its button would sit on
  // Send; the box has a mic of its own.
  stopVoice({ only: 'terminal' });
  document.body.classList.add('billion-chat');
  setWaitingActive(true);
  // A reload comes back here, not to the terminal that was open before.
  localStorage.removeItem('agent007-active-tab');
  setView(document.body.dataset.view);
  renderWaiting({ toBottom: true });
  if (window._onBoardVisibilityChanged) window._onBoardVisibilityChanged();
}

// The phone's Terminal button, pressed while this tab is showing: back to
// the terminal that was open, else the first agent in the strip (never
// Billion's hidden tab), or the empty state when there is none.
export function leaveWaiting() {
  hideWaiting();
  if (activeSessionId && agents.has(activeSessionId)) {
    agents.get(activeSessionId).termEl.style.display = 'block';
    return;
  }
  const first = [...agents].find(([, a]) => !a.isBillion);
  if (first) switchToSession(first[0]);
  else document.getElementById('terminal-empty').style.display = 'flex';
}

export function hideWaiting() {
  leftChat();
  const board = document.getElementById('waiting-board');
  if (board) board.style.display = 'none';
  document.body.classList.remove('billion-chat');
  setWaitingActive(false);
  setView(document.body.dataset.view);
}

// Leaving the Billion view (another tab, or the phone's other panels): the
// box's mic and any reading stop, since their buttons are out of sight.
export function leftChat() {
  stopVoice({ only: 'chat', notice: 'Voice input stopped — left the Billion tab' });
  if (speakingMessage() !== null || queuedCount()) stopReading();
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Blocking, then normal, then low; oldest first within each, since a question
// left waiting grows more urgent. Items without urgency read as normal.
const RANK = { blocking: 0, low: 2 };
const byAge = (a, b) => String(a.at).localeCompare(String(b.at));
const byUrgency = (a, b) => (RANK[a.urgency] ?? 1) - (RANK[b.urgency] ?? 1) || byAge(a, b);

// What the text box answers: only the question the owner picked with Reply,
// while it is open. Otherwise the box is a plain message to Billion.
export function answerTarget() {
  return waitingItems.find(item => item.id === replyTo && item.status === 'open') || null;
}

// Reply on a question, or its chip in the strip: the box answers it.
export function replyToQuestion(id) {
  replyTo = id;
  renderComposer();
  document.getElementById('chat-input')?.focus();
}

const billionEntry = () => [...agents.entries()].find(([, a]) => a.isBillion) || [];
// A stopped Billion keeps its row (and its entry here) so it can be started.
const billionRunning = () => { const [, a] = billionEntry(); return !!a && a.state !== 'DISCONNECTED'; };

// Why Billion cannot talk yet, by session (server/billion.js setBillionNotice):
// its CLI is missing, or logged out and waiting at its sign-in.
const notices = new Map();
export function setBillionNotice(sessionId, notice) {
  if (notice) notices.set(sessionId, notice);
  else notices.delete(sessionId);
  renderComposer();
}

function noticeText() {
  const [id] = billionEntry();
  return (id && notices.get(id)) || (!billionRunning() && billionEnabled ? 'Billion is not running.' : '');
}

// The bar above the text box: what stands between the owner and Billion, and
// the button that gets past it. The explorer, with Billion's own Start, starts
// out collapsed on a first run, so this is the one a new owner sees.
function renderNotice() {
  const bar = document.getElementById('chat-notice');
  if (!bar) return;
  const [id] = billionEntry();
  const running = billionRunning();
  const text = noticeText();
  bar.hidden = !text;
  // "Say something to Billion" contradicts a notice saying it can't hear.
  const empty = document.querySelector('#waiting-list .waiting-empty');
  if (empty) empty.hidden = !!text;
  bar.innerHTML = '';
  if (!text) return;
  const btn = el('button', 'chat-notice-btn', running ? "Open Billion's terminal" : 'Start Billion');
  btn.type = 'button';
  btn.onclick = running ? () => { switchToSession(id); setView('terminal'); } : () => send({ type: 'billion-start' });
  bar.append(el('span', 'chat-notice-text', text), btn);
}

// A tap on a question's choice.
function answer(q, choice) {
  request(q, { type: 'waiting-answer', id: q.id, answer: choice });
}

// Undo on "you answered: ...": the question opens again.
function undo(q) {
  request(q, { type: 'waiting-reopen', id: q.id });
}

function request(q, msg) {
  if (pending.has(q.id)) return;
  errors.delete(q.id);
  if (send(msg)) pending.set(q.id, q.status);
  else errors.set(q.id, { error: 'Not connected to the server; try again in a moment.', status: q.status });
  renderWaiting();
}

export function handleWaitingError(msg) {
  pending.delete(msg.id);
  const status = waitingItems.find(item => item.id === msg.id)?.status;
  errors.set(msg.id, { error: msg.error, status });
  renderWaiting();
}

function errorLine(q) {
  if (!errors.has(q.id)) return null;
  const error = el('p', 'waiting-error', errors.get(q.id).error);
  error.setAttribute('role', 'alert');
  return error;
}

const UNDO_MS = 60 * 1000;
const undoLeft = (q) => (q.answeredVia === 'app' || q.answeredVia === 'telegram') ? Date.parse(q.answeredAt) + UNDO_MS - Date.now() : 0;

function submit() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim() || '';
  if ((!text && !attached.length) || sending) return;
  if (attached.some(a => a.reading)) {
    sendError = 'Still reading an attached file; send again in a moment.';
    return renderComposer();
  }
  const target = answerTarget();
  const nonce = `c${++nonces}`;
  const files = attached.length ? { files: attached.map(a => ({ name: a.name, type: a.type, data: a.data })) } : {};
  if (!send({ type: 'chat-send', nonce, text, ...(target ? { answers: target.id } : {}), ...files })) {
    sendError = 'Not connected to the server; try again in a moment.';
  } else {
    sending = nonce;
    sendError = '';
    // The socket dropped before the server answered: free the box, text kept.
    setTimeout(() => {
      if (sending !== nonce) return;
      sending = null;
      sendError = 'No answer from the server. Check the thread before sending again.';
      renderComposer();
    }, SEND_TIMEOUT_MS);
  }
  renderComposer();
}

// The server took the box's message, or said why not. The text leaves the box
// only once it is in the thread, so a refusal never loses it.
export function handleChatSent(msg) {
  if (msg.nonce !== sending) return;
  sending = null;
  sendError = msg.error || '';
  const input = document.getElementById('chat-input');
  if (!msg.error && input) {
    input.value = '';
    fitInput(input);
    for (const a of attached) if (a.url) URL.revokeObjectURL(a.url);
    attached = [];
  }
  renderComposer();
}

const sizeText = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const isImage = (type) => /^image\//.test(type || '');

// Pasted, dropped or picked: chips above the box until Send, under the job
// form's limits (the server checks them again).
export function attachFiles(files, fallbackName) {
  sendError = '';
  for (const file of files) {
    const name = attachmentName(file, fallbackName);
    const others = attached.filter(a => a.name !== name);
    const refuse = file.size > MAX_ATTACHMENT_BYTES ? `${name} is too large (max 10MB)`
      : others.length >= MAX_ATTACHMENTS ? `At most ${MAX_ATTACHMENTS} files per message`
      : others.reduce((n, a) => n + a.size, 0) + file.size > MAX_ATTACHMENT_TOTAL_BYTES ? 'Attachments add up to more than 50MB'
      : '';
    if (refuse) { sendError = refuse; continue; }
    const entry = { name, size: file.size, type: file.type || '', reading: true };
    if (isImage(file.type) && URL.createObjectURL) entry.url = URL.createObjectURL(file);
    removeAttached(attached.find(a => a.name === name));
    attached.push(entry);
    const reader = new FileReader();
    reader.onload = () => { entry.data = String(reader.result).split(',')[1]; delete entry.reading; };
    reader.onerror = reader.onabort = () => {
      removeAttached(entry);
      sendError = `Could not read ${name}`;
      renderComposer();
    };
    reader.readAsDataURL(file);
  }
  renderComposer();
}

// Tests only: a send left in flight and its files, gone.
export function _resetComposer() {
  sending = null;
  sendError = '';
  for (const a of attached) if (a.url) URL.revokeObjectURL(a.url);
  attached = [];
}

function removeAttached(entry) {
  if (!entry) return;
  if (entry.url) URL.revokeObjectURL(entry.url);
  attached = attached.filter(a => a !== entry);
}

function renderAttached() {
  const box = document.getElementById('chat-files');
  box.hidden = !attached.length;
  box.innerHTML = '';
  for (const a of attached) {
    const chip = el('span', 'chat-file-chip');
    chip.title = `${a.name}, ${sizeText(a.size)}`;
    if (a.url) {
      const img = el('img', 'chat-file-thumb');
      img.src = a.url;
      img.alt = a.name;
      chip.appendChild(img);
    } else chip.append(el('span', 'chat-file-name', a.name), el('span', 'chat-file-size', sizeText(a.size)));
    const x = el('button', 'chat-file-remove', '\u00d7');
    x.type = 'button';
    x.setAttribute('aria-label', `Remove ${a.name}`);
    x.onclick = () => { removeAttached(a); renderComposer(); };
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

// The owner's files in their bubble: images as thumbnails that open full size,
// others as a download link. Served from the config dir by server/http.js.
function sentFiles(m) {
  const box = el('div', 'chat-files');
  for (const f of m.files) {
    const url = `/api/chat/${encodeURIComponent(m.id)}/files/${encodeURIComponent(f.name)}`;
    const link = el('a', isImage(f.type) ? 'chat-file-image' : 'chat-file-chip');
    link.href = url;
    link.title = `${f.name}, ${sizeText(f.size || 0)}`;
    if (isImage(f.type)) {
      link.target = '_blank';
      link.rel = 'noopener';
      const img = el('img', 'chat-file-thumb');
      img.src = url;
      img.alt = f.name;
      img.loading = 'lazy';
      link.appendChild(img);
    } else {
      link.download = f.name;
      link.append(el('span', 'chat-file-name', f.name), el('span', 'chat-file-size', sizeText(f.size || 0)));
    }
    box.appendChild(link);
  }
  return box;
}

function fitInput(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function time(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

function qLabel(q) {
  const n = el('span', 'waiting-card-n', `Q${q.n}`);
  if (q.urgency === 'blocking') {
    n.prepend(el('b', 'waiting-urgent', '!'), ' ');
    n.title = 'blocking: a worker or merge is waiting';
  } else if (q.urgency === 'low') {
    n.classList.add('low');
    n.title = 'optional';
  }
  return n;
}

const VIA = { telegram: 'on Telegram', terminal: 'in the terminal' };

// Under a question: its choices while open (recommended first), then what
// became of it.
function questionFoot(q) {
  if (q.status === 'answered') {
    const line = el('p', 'chat-answered', `you answered: ${q.answer}${VIA[q.answeredVia] ? ` (${VIA[q.answeredVia]})` : ''}`);
    const left = undoLeft(q);
    if (left > 0) {
      const btn = el('button', 'chat-link chat-undo', 'Undo');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Undo the answer to Q${q.n}`);
      btn.disabled = pending.has(q.id);
      btn.onclick = () => undo(q);
      line.append(' ', btn);
      undoSoonest = Math.min(undoSoonest, left);
    }
    const error = errorLine(q);
    if (!error) return line;
    const foot = el('div', 'chat-q-foot');
    foot.append(line, error);
    return foot;
  }
  if (q.status === 'dismissed') return el('p', 'chat-answered', 'dismissed');
  const foot = el('div', 'chat-q-foot');
  if (Array.isArray(q.choices) && q.choices.length) {
    const choices = el('div', 'waiting-choices');
    const ordered = [...q.choices].sort((a, b) => (b === q.recommended) - (a === q.recommended));
    for (const choice of ordered) {
      const btn = el('button', `waiting-choice${choice === q.recommended ? ' recommended' : ''}`, choice);
      btn.type = 'button';
      if (choice === q.recommended) {
        btn.appendChild(el('span', 'waiting-choice-tag', 'recommended'));
        btn.setAttribute('aria-label', `${choice} (recommended)`);
      }
      btn.disabled = pending.has(q.id);
      btn.onclick = () => answer(q, choice);
      choices.appendChild(btn);
    }
    foot.appendChild(choices);
  }
  const reply = el('button', 'chat-link chat-reply', 'Reply');
  reply.type = 'button';
  reply.setAttribute('aria-label', `Answer Q${q.n} by typing`);
  reply.onclick = () => replyToQuestion(q.id);
  foot.appendChild(reply);
  const dismiss = el('button', 'waiting-dismiss', 'Dismiss');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', `Dismiss Q${q.n}`);
  dismiss.onclick = () => send({ type: 'waiting-dismiss', id: q.id });
  foot.appendChild(dismiss);
  const error = errorLine(q);
  if (error) foot.appendChild(error);
  return foot;
}

function bubble(m) {
  const mine = m.from === 'owner';
  const row = el('div', `chat-msg ${mine ? 'mine' : 'theirs'}`);
  row.dataset.id = m.id;
  const box = el('div', 'chat-bubble');
  if (m.q) {
    row.dataset.q = m.q.id;
    row.classList.add(m.q.status === 'open' ? 'open' : 'closed');
    box.appendChild(qLabel(m.q));
  }
  if (m.re) box.appendChild(el('span', 'chat-re', `re Q${m.re}`));
  if (m.text || !m.files?.length) box.appendChild(el('p', 'chat-text', m.text));
  if (m.files?.length) box.appendChild(sentFiles(m));
  const meta = [m.voice && '(voice)', mine && m.via === 'telegram' && 'Telegram', time(m.at)].filter(Boolean);
  const metaLine = el('span', 'chat-meta', meta.join(' · '));
  if (!mine && readAloudSupported()) {
    const foot = el('div', 'chat-meta-row');
    foot.append(speakButton(m), metaLine);
    box.appendChild(foot);
  } else box.appendChild(metaLine);
  if (m.q) box.appendChild(questionFoot(m.q));
  row.appendChild(box);
  return row;
}

const SPEAKER_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/><path d="M12.8 3.5a6 6 0 0 1 0 9"/></svg>';
const STOP_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/></svg>';
const CLIP_SVG = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 7.5l-5.6 5.6a3.2 3.2 0 0 1-4.5-4.5l6-6a2.1 2.1 0 0 1 3 3l-6 6a1 1 0 0 1-1.5-1.5l5.5-5.5"/></svg>';
const MIC_SVG = '<svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="1.5" width="4" height="6.5" rx="2"/><path d="M2.8 6.5a4.2 4.2 0 0 0 8.4 0"/><line x1="7" y1="10.7" x2="7" y2="12.5"/></svg>';

// A Billion message's speaker: reads it aloud, and while it does, stops it.
function speakButton(m) {
  const btn = el('button', 'chat-speak');
  btn.type = 'button';
  btn.dataset.id = m.id;
  btn.onclick = () => {
    const now = chatMessages.find(x => x.id === m.id) || m;
    toggleSpeak(m.id, speakableText(now));
  };
  paintSpeakButton(btn);
  return btn;
}

function paintSpeakButton(btn) {
  const speaking = btn.dataset.id === speakingMessage();
  const label = speaking ? 'Stop reading' : 'Read aloud';
  if (btn.dataset.state === label) return;
  btn.dataset.state = label;
  btn.classList.toggle('speaking', speaking);
  btn.setAttribute('aria-pressed', String(speaking));
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = speaking ? STOP_SVG : SPEAKER_SVG;
}

// The header: "Read new messages aloud", the one-tap "Resume reading" after
// a reload, and the voice picker.
function renderReadHead() {
  const head = document.getElementById('chat-head');
  if (!head) return;
  const toggle = document.getElementById('chat-autoread');
  const on = autoReadOn();
  toggle.setAttribute('aria-pressed', String(on));
  toggle.classList.toggle('on', on);
  const resume = document.getElementById('chat-resume');
  const waiting = needsResume();
  resume.hidden = !waiting;
  const queued = queuedCount();
  resume.textContent = queued ? `Resume reading (${queued} new)` : 'Resume reading';
  const stop = document.getElementById('chat-stop-reading');
  stop.hidden = speakingMessage() === null && !queued || waiting;
  renderVoicePick();
}

function renderVoicePick() {
  const pick = document.getElementById('chat-voice-pick');
  if (!pick) return;
  const voices = englishVoices(window.speechSynthesis?.getVoices?.() || []);
  pick.hidden = voices.length < 2;
  const saved = savedVoiceURI();
  const auto = pickVoice(voices, null);
  const key = voices.map(v => v.voiceURI).join('|') + `#${saved}`;
  if (pick.dataset.key === key) return;
  pick.dataset.key = key;
  pick.innerHTML = '';
  const first = el('option', null, auto ? `Voice: auto (${auto.name})` : 'Voice: auto');
  first.value = '';
  pick.appendChild(first);
  for (const v of voices) {
    const opt = el('option', null, v.name);
    opt.value = v.voiceURI;
    pick.appendChild(opt);
  }
  pick.value = voices.some(v => v.voiceURI === saved) ? saved : '';
}

function paintReadAloud() {
  for (const btn of document.querySelectorAll('.chat-speak')) paintSpeakButton(btn);
  renderReadHead();
}
onReadAloudChange(paintReadAloud);

// A message arrived over the socket. A new one from Billion is read aloud
// when "Read new messages aloud" is on and the tab is showing.
export function handleChatMessage(message) {
  const isNew = !chatMessages.some(m => m.id === message.id);
  upsertChatMessage(message);
  renderWaiting();
  if (isNew && message.from !== 'owner' && waitingActive) readNew(message.id, speakableText(message));
}

// The box's mic: the terminal mic's logic and limits (voice.js), with speech
// appended to the box as text. Nothing is sent: the owner taps Send. In
// "Answers Q3" mode the dictated text answers Q3, like typed text.
export const CHAT_VOICE = {
  name: 'chat',
  button: () => document.getElementById('chat-mic'),
  indicator: () => document.getElementById('chat-voice'),
  unavailable: () => (waitingActive && document.getElementById('chat-input') ? null : 'Open the Billion tab to dictate'),
  deliver(text) {
    const input = document.getElementById('chat-input');
    if (!input || !waitingActive) return false;
    input.value = appendTranscript(input.value, text);
    fitInput(input);
    return true;
  },
  // A keyboard, not a phone's: the box takes focus so Enter sends. On a
  // phone that would pop the keyboard over the thread.
  refocus() {
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    document.getElementById('chat-input')?.focus();
  },
  undelivered: 'Voice input stopped — the text box is gone',
};

export const toggleChatVoice = () => toggleVoice(CHAT_VOICE);

function readHead() {
  const head = el('div', 'chat-head');
  head.id = 'chat-head';
  const toggle = el('button', 'chat-autoread');
  toggle.id = 'chat-autoread';
  toggle.type = 'button';
  toggle.innerHTML = SPEAKER_SVG;
  toggle.append(el('span', null, 'Read new messages aloud'), el('span', 'chat-switch'));
  toggle.title = 'Speak each new message from Billion as it arrives, while this tab is open';
  toggle.onclick = () => setAutoRead(!autoReadOn());
  const resume = el('button', 'chat-resume', 'Resume reading');
  resume.id = 'chat-resume';
  resume.type = 'button';
  resume.title = 'The browser lets a page speak only after a tap: tap to go on reading new messages aloud';
  resume.hidden = true;
  resume.onclick = () => resumeReading();
  const stop = el('button', 'chat-stop-reading', 'Stop');
  stop.id = 'chat-stop-reading';
  stop.type = 'button';
  stop.setAttribute('aria-label', 'Stop reading aloud');
  stop.hidden = true;
  stop.onclick = () => stopReading();
  const pick = el('select', 'chat-voice-pick');
  pick.id = 'chat-voice-pick';
  pick.setAttribute('aria-label', 'Reading voice');
  pick.hidden = true;
  pick.onchange = () => { setVoiceURI(pick.value); renderVoicePick(); };
  head.append(toggle, resume, stop, pick);
  window.speechSynthesis?.addEventListener?.('voiceschanged', renderVoicePick);
  return head;
}

// The strip, the thread's scroller, the jump and the text box, built once:
// the box lives outside what re-renders, so a broadcast never eats a draft.
function shell() {
  const board = document.getElementById('waiting-board');
  const list = document.getElementById('waiting-list');
  if (!board || !list) return null;
  if (!document.getElementById('chat-compose')) {
    const strip = el('nav', 'chat-strip');
    strip.id = 'chat-strip';
    strip.setAttribute('aria-label', 'Open questions');
    strip.hidden = true;
    board.insertBefore(strip, list);
    if (readAloudSupported()) board.insertBefore(readHead(), strip);

    const jump = el('button', 'chat-jump', 'New messages ↓');
    jump.id = 'chat-jump';
    jump.type = 'button';
    jump.hidden = true;
    jump.onclick = () => { list.scrollTop = list.scrollHeight; jump.hidden = true; };
    list.onscroll = () => { if (atBottom(list)) jump.hidden = true; };

    const form = el('form', 'chat-compose');
    form.id = 'chat-compose';
    const target = el('div', 'chat-target');
    target.id = 'chat-target';
    target.hidden = true;
    const row = el('div', 'chat-compose-row');
    const input = el('textarea');
    input.id = 'chat-input';
    input.rows = 1;
    input.setAttribute('aria-label', 'Message Billion');
    input.oninput = () => fitInput(input);
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
    const clip = el('button', 'chat-mic chat-attach');
    clip.id = 'chat-attach';
    clip.type = 'button';
    clip.innerHTML = CLIP_SVG;
    clip.title = 'Attach files (or paste a screenshot, or drop files here)';
    clip.setAttribute('aria-label', 'Attach files');
    const pick = el('input');
    pick.type = 'file';
    pick.multiple = true;
    pick.hidden = true;
    pick.id = 'chat-attach-input';
    clip.onclick = () => pick.click();
    pick.onchange = () => { attachFiles(pick.files); pick.value = ''; };
    const chips = el('div', 'chat-files-pending');
    chips.id = 'chat-files';
    chips.hidden = true;
    const mic = el('button', 'chat-mic');
    mic.id = 'chat-mic';
    mic.type = 'button';
    mic.innerHTML = MIC_SVG;
    mic.title = 'Dictate a reply (it is not sent until you tap Send)';
    mic.setAttribute('aria-label', 'Dictate a reply');
    mic.setAttribute('aria-pressed', 'false');
    mic.onclick = () => toggleChatVoice();
    const voice = el('div', 'chat-voice');
    voice.id = 'chat-voice';
    voice.style.display = 'none';
    voice.setAttribute('aria-hidden', 'true');
    voice.append(el('span', 'voice-indicator-dot'), el('span', 'voice-indicator-text'));
    const btn = el('button', 'waiting-send', 'Send');
    btn.id = 'chat-send';
    btn.type = 'submit';
    const notice = el('div', 'chat-notice');
    notice.id = 'chat-notice';
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    const error = el('p', 'waiting-error');
    error.id = 'chat-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    row.append(input, clip, pick, mic, btn);
    form.append(notice, target, chips, voice, row, error);
    board.append(jump, form);
    board.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      attachFiles(files, 'screenshot');
    });
    dropTarget(board);
  }
  return list;
}

// Files dropped anywhere on the tab attach to the box. Stopped here, so the
// terminal viewport's own drop (an upload to the selected agent) never sees them.
function dropTarget(board) {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  board.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth++;
    board.classList.add('dropping');
  });
  board.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });
  board.addEventListener('dragleave', (e) => {
    e.stopPropagation();
    if (--depth <= 0) { depth = 0; board.classList.remove('dropping'); }
  });
  board.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    board.classList.remove('dropping');
    if (e.dataTransfer?.files?.length) attachFiles(e.dataTransfer.files);
  });
}

const atBottom = (list) => list.scrollHeight - list.scrollTop - list.clientHeight < 40;

export function renderComposer() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const target = answerTarget();
  const chip = document.getElementById('chat-target');
  chip.hidden = !target;
  chip.innerHTML = '';
  if (target) {
    chip.append(el('span', null, `Answers Q${target.n}: `), el('span', 'chat-target-text', target.text));
    const x = el('button', 'chat-target-x', '×');
    x.type = 'button';
    x.title = 'Send as a message instead';
    x.setAttribute('aria-label', `Don't answer Q${target.n}; send as a message`);
    x.onclick = () => { replyTo = null; renderComposer(); };
    chip.appendChild(x);
  }
  const running = billionRunning();
  input.placeholder = !running ? 'Start Billion to send'
    : target ? `Answer Q${target.n}` : 'Message Billion';
  document.getElementById('chat-send').disabled = !!sending;
  document.getElementById('chat-send').textContent = sending ? 'Sending' : 'Send';
  renderAttached();
  const error = document.getElementById('chat-error');
  error.textContent = sendError;
  error.hidden = !sendError;
  renderNotice();
}

function renderStrip() {
  const strip = document.getElementById('chat-strip');
  const open = waitingItems.filter(item => item.status === 'open').sort(byUrgency);
  strip.hidden = !open.length;
  strip.innerHTML = '';
  for (const item of open) {
    const btn = el('button', 'chat-strip-item');
    btn.type = 'button';
    btn.append(qLabel(item), ' ', el('span', 'chat-strip-text', item.text));
    btn.title = item.text;
    btn.onclick = () => {
      const row = document.querySelector(`.chat-msg[data-q="${CSS.escape(item.id)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('flash');
      void row.offsetWidth;   // restart the animation
      row.classList.add('flash');
      replyToQuestion(item.id);
    };
    strip.appendChild(btn);
  }
}

// toBottom: the tab was just opened, so start at the newest.
export function renderWaiting({ toBottom = false } = {}) {
  // Settled: the server moved it on, so it is no longer ours to wait for.
  // A pending tap or Undo is settled when the question's status changes; an
  // error line stays until it does.
  for (const [id, status] of pending) {
    if (waitingItems.find(item => item.id === id)?.status !== status) pending.delete(id);
  }
  for (const [id, { status }] of errors) {
    if (waitingItems.find(item => item.id === id)?.status !== status) errors.delete(id);
  }
  if (replyTo && !answerTarget()) replyTo = null;
  if (!waitingActive) return;
  const list = shell();
  if (!list) return;
  const follow = toBottom || atBottom(list);
  const keep = list.scrollTop;
  list.innerHTML = '';
  clearTimeout(undoTimer);
  undoSoonest = Infinity;
  if (!chatMessages.length) {
    const empty = el('p', 'waiting-empty', 'Nothing here yet. Say something to Billion.');
    empty.hidden = !!noticeText();
    list.appendChild(empty);
  }
  for (const m of chatMessages) list.appendChild(bubble(m));
  // Drawn again when an Undo link's minute is up, so it goes.
  if (undoSoonest < Infinity) undoTimer = setTimeout(() => renderWaiting(), Math.min(undoSoonest, UNDO_MS) + 50);
  const jump = document.getElementById('chat-jump');
  if (follow) {
    list.scrollTop = list.scrollHeight;
    // On a phone the panel is shown after this runs, at height 0 until then.
    if (toBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    jump.hidden = true;
  } else {
    list.scrollTop = keep;
    if (chatMessages.at(-1)?.id !== lastShown) jump.hidden = false;
  }
  lastShown = chatMessages.at(-1)?.id ?? null;
  renderStrip();
  renderComposer();
  renderReadHead();
}
