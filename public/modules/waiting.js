// The "Billion" tab: the owner's chat with Billion, the web twin of the
// Telegram channel. One thread of the owner's messages, Billion's tell_owner
// replies and its notify_owner questions (answered with a tap, or a typed line
// once the owner picks the question with Reply),
// a strip pinning the open questions that opens them as a panel grouped by
// project or by type, and a text box that is typed into
// Billion's terminal as [Owner via app] (server/owner.js ownerSays). Shares the
// terminal viewport with the terminals and the job board, like Jobs does.
// Billion's messages can be read aloud (readaloud.js: a speaker button on
// each, and the bar's speaker turns on reading new messages aloud; the voice
// is picked in Settings), and the box has its own
// mic (voice.js with the CHAT_VOICE target), all in the browser and free.
// "Talk to Billion" (talk.js) is a hands-free voice conversation over the same thread.
import { agents, activeSessionId, waitingItems, chatMessages, waitingActive, setWaitingActive, setView, upsertChatMessage, billionEnabled, billionOff, billionStatus } from './state.js';
import { switchToSession } from './terminal.js';
import { send } from './ws.js';
import { hideJobBoard, showJobBoard, attachmentName, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENT_TOTAL_BYTES } from './jobs.js';
import { stopVoice, toggleVoice, appendTranscript } from './voice.js';
import { renderRound, renderBillionStatus, initSubTabs, subTab } from './round.js';
import { patchChildren, rev, atBottom } from './dom-patch.js';
import {
  readAloudSupported, speakableText, toggleSpeak, readNew, speakingMessage, stopReading,
  autoReadOn, setAutoRead, needsResume, resumeReading, queuedCount, onReadAloudChange,
} from './readaloud.js';
import { progressHeading } from './readaloud.js';
import { talkBar, talkButton, talkHeard, talkOn, endTalk } from './talk.js';

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
  if (billionOff()) return showJobBoard();
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
  if (talkOn()) endTalk({ notice: 'Talk ended — you left the Billion tab.' });
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

// Reply on a question, in the thread or the Open questions panel: the box answers it.
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

// Telegram's chat offers (server/owner.js telegramPayload): with no chat
// connected, each chat that messages the bot is offered here, and "Use this
// chat" connects it. connectedTo: the chat just picked, shown for a moment.
let telegram = { offers: [] };
let connectedTimer = null;
export function setTelegramState(state) {
  telegram = state;
  clearTimeout(connectedTimer);
  if (state.connectedTo) connectedTimer = setTimeout(() => { telegram = { ...telegram, connectedTo: '' }; renderTelegram(); }, 8000);
  renderTelegram();
}

function renderTelegram() {
  const bar = document.getElementById('chat-telegram');
  if (!bar) return;
  bar.innerHTML = '';
  for (const offer of telegram.offers || []) {
    const row = el('div', 'chat-notice');
    const use = el('button', 'chat-notice-btn', 'Use this chat');
    use.type = 'button';
    use.onclick = () => send({ type: 'telegram-use', chatId: offer.chatId });
    const no = el('button', 'chat-link', 'Dismiss');
    no.type = 'button';
    no.setAttribute('aria-label', `Dismiss the Telegram chat ${offer.name}`);
    no.onclick = () => send({ type: 'telegram-dismiss', chatId: offer.chatId });
    row.append(el('span', 'chat-notice-text', `Telegram: a message from ${offer.name} (chat ${offer.chatId}). Use it for Billion?`), use, no);
    bar.appendChild(row);
  }
  if (telegram.connected && telegram.connectedTo) bar.appendChild(el('div', 'chat-notice', `Telegram connected: ${telegram.connectedTo}`));
  bar.hidden = !bar.childElementCount;
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

// Progress belongs to one owner request. Only allowlisted server summaries
// enter here; textContent (el) keeps both live and saved details inert.
function progressBox(m, first) {
  const s = billionStatus;
  const box = el('div', 'chat-progress');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.classList.toggle('active', first && !!s?.working);
  box.append(el('p', 'chat-progress-head', progressHeading(s, first)));
  const lines = (s?.progress?.[m.id] || m.workDetails || []).filter(line => typeof line === 'string' && line.trim());
  const list = el('ul', 'chat-progress-steps');
  for (const line of lines.length ? lines : [first && s?.working ? 'Working…' : 'Waiting to start…']) list.append(el('li', null, line));
  box.append(list);
  return box;
}

function workDetails(lines) {
  const safe = Array.isArray(lines) ? lines.filter(line => typeof line === 'string' && line.trim()) : [];
  if (!safe.length) return null;
  const details = el('details', 'chat-work-details');
  details.append(el('summary', null, 'Work details'));
  const list = el('ul', 'chat-progress-steps');
  for (const line of safe) list.append(el('li', null, line));
  details.append(list);
  return details;
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
    const line = el('p', 'chat-answered', `${q.answeredBy || 'you'} answered: ${q.answer}${VIA[q.answeredVia] ? ` (${VIA[q.answeredVia]})` : ''}`);
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
  if (q.status === 'consolidated') return el('p', 'chat-answered', 'consolidated: the next briefing came first');
  const foot = el('div', 'chat-q-foot');
  if (Array.isArray(q.choices) && q.choices.length) foot.appendChild(choiceButtons(q));
  foot.appendChild(replyButton(q, () => replyToQuestion(q.id)));
  const dismiss = el('button', 'waiting-dismiss', 'Dismiss');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', `Dismiss Q${q.n}`);
  dismiss.onclick = () => send({ type: 'waiting-dismiss', id: q.id });
  foot.appendChild(dismiss);
  const error = errorLine(q);
  if (error) foot.appendChild(error);
  return foot;
}

// A question's choices, recommended first: one tap answers it.
function choiceButtons(q) {
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
  return choices;
}

function replyButton(q, onclick) {
  const reply = el('button', 'chat-link chat-reply', 'Reply');
  reply.type = 'button';
  reply.setAttribute('aria-label', `Answer Q${q.n} by typing`);
  reply.onclick = onclick;
  return reply;
}

// The owner's messages still waiting for a reply of their own (server/billion-status.js).
const waitingOnBillion = () => {
  const answered = new Set(chatMessages.filter(m => m.from === 'billion' && m.replyTo).map(m => m.replyTo));
  return (Array.isArray(billionStatus?.pending) ? billionStatus.pending : []).filter(id => !answered.has(id));
};

function bubble(m, detailsOpen, pendingIds, currentRequest) {
  const mine = m.from === 'owner';
  const unanswered = mine && pendingIds.has(m.id);
  const row = el('div', `chat-msg ${mine ? 'mine' : 'theirs'}${unanswered ? ' pending' : ''}`);
  row.dataset.id = m.id;
  // Keyed, so a redraw keeps an unchanged bubble (and its own scroll) as it is.
  row.dataset.key = m.id;
  row.dataset.rev = rev([m, pending.get(m.q?.id), errors.get(m.q?.id), unanswered, unanswered && [billionStatus?.progress?.[m.id], billionStatus?.working, currentRequest]]);
  const box = el('div', 'chat-bubble');
  if (m.q) {
    row.dataset.q = m.q.id;
    row.classList.add(m.q.status === 'open' ? 'open' : 'closed');
    box.appendChild(qLabel(m.q));
  }
  if (m.re) box.appendChild(el('span', 'chat-re', `re Q${m.re}`));
  if (m.text || !m.files?.length) box.appendChild(el('p', 'chat-text', m.text));
  if (m.files?.length) box.appendChild(sentFiles(m));
  const meta = [m.notice && 'System update', m.command && 'Command', m.screen && 'Billion\'s terminal', m.voice && '(voice)', mine && m.via === 'telegram' && (m.name ? `${m.name} on Telegram` : 'Telegram'), time(m.at), unanswered && 'waiting for Billion…'].filter(Boolean);
  const metaLine = el('span', 'chat-meta', meta.join(' · '));
  if (!mine && !m.screen && readAloudSupported()) {
    const foot = el('div', 'chat-meta-row');
    foot.append(speakButton(m), metaLine);
    box.appendChild(foot);
  } else box.appendChild(metaLine);
  if (m.q) box.appendChild(questionFoot(m.q));
  if (unanswered) box.append(progressBox(m, currentRequest === m.id));
  else if (!mine && m.replyTo) {
    const details = workDetails(m.workDetails);
    if (details) { details.open = detailsOpen; box.append(details); }
  }
  row.appendChild(box);
  return row;
}

const SPEAKER_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/><path d="M12.8 3.5a6 6 0 0 1 0 9"/></svg>';
const STOP_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/></svg>';
// 16px with a 1.05 stroke draws a 1.2px line, the weight of the header's
// gear and theme icons (14px at 1.2).
const MIC_SVG = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" aria-hidden="true"><rect x="5" y="1.5" width="4" height="6.5" rx="2"/><path d="M2.8 6.5a4.2 4.2 0 0 0 8.4 0"/><line x1="7" y1="10.7" x2="7" y2="12.5"/></svg>';
const CLIP_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 7.5l-5.6 5.6a3.2 3.2 0 0 1-4.5-4.5l6-6a2.1 2.1 0 0 1 3 3l-6 6a1 1 0 0 1-1.5-1.5l5.5-5.5"/></svg>';

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

// The bar's read-aloud controls: the speaker that turns "read new messages
// aloud" on and off, and the one-tap "Resume reading" after a reload.
function renderReadHead() {
  const toggle = document.getElementById('chat-autoread');
  if (!toggle) return;
  const on = autoReadOn();
  toggle.setAttribute('aria-pressed', String(on));
  toggle.classList.toggle('on', on);
  const resume = document.getElementById('chat-resume');
  const waiting = needsResume();
  resume.hidden = !waiting;
  const queued = queuedCount();
  resume.textContent = queued ? `Resume reading (${queued} new)` : 'Resume reading';
}

// A password manager or AutoFill can pin its own overlay (the page's
// address, in tiny type) to a form field. None of these fields is a login.
function noAutofill(field) {
  for (const a of ['data-1p-ignore', 'data-lpignore', 'data-bwignore']) field.setAttribute(a, 'true');
  field.setAttribute('autocomplete', 'off');
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
  talkHeard(message);
  // While talking, the conversation speaks its own replies; read-aloud waits.
  if (isNew && message.from !== 'owner' && !message.screen && waitingActive && !talkOn()) readNew(message.id, speakableText(message));
}

// The box's mic: the terminal mic's logic and limits (voice.js), with speech
// appended to the box as text. Nothing is sent: the owner taps Send. In
// "Answers Q3" mode the dictated text answers Q3, like typed text.
export const CHAT_VOICE = {
  name: 'chat',
  button: () => document.getElementById('chat-mic'),
  indicator: () => document.getElementById('chat-voice'),
  unavailable: () => (talkOn() ? 'You are talking to Billion — End it to dictate'
    : waitingActive && document.getElementById('chat-input') ? null : 'Open the Billion tab to dictate'),
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

let toastTimer = null;
const TOAST_MS = 1800;
function toast(text) {
  const note = document.getElementById('chat-toast');
  if (!note) return;
  note.textContent = text;
  note.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { note.hidden = true; }, TOAST_MS);
}

// The Chat view's end of the bar: the open questions chip, Resume reading
// when the browser wants a tap first, and the speaker that turns reading new
// messages aloud on and off. Built once.
function readHead() {
  const head = el('div', 'chat-head');
  head.id = 'chat-head';
  if (!readAloudSupported()) return head;
  const resume = el('button', 'chat-resume billion-bar-control', 'Resume reading');
  resume.id = 'chat-resume';
  resume.type = 'button';
  resume.title = 'The browser lets a page speak only after a tap: tap to go on reading new messages aloud';
  resume.hidden = true;
  resume.onclick = () => resumeReading();
  const toggle = el('button', 'chat-autoread billion-bar-control');
  toggle.id = 'chat-autoread';
  toggle.type = 'button';
  // Named for what it does; aria-pressed says whether it is on. The word
  // shows beside the icon where the bar has room (style.css).
  toggle.setAttribute('aria-label', 'Read new messages aloud');
  toggle.title = 'Read new messages aloud';
  toggle.innerHTML = SPEAKER_SVG;
  toggle.appendChild(el('span', 'chat-autoread-label', 'Read aloud'));
  // While something is being read, a tap means "be quiet": it stops the
  // speech and leaves reading new messages aloud off.
  toggle.onclick = () => {
    const speaking = speakingMessage() !== null || queuedCount() > 0;
    if (speaking) stopReading();
    setAutoRead(speaking ? false : !autoReadOn());
    toast(`Read aloud: ${autoReadOn() ? 'on' : 'off'}`);
  };
  head.append(resume, toggle);
  return head;
}

// The bar's controls, the thread's scroller, the jump and the text box, built once:
// the box lives outside what re-renders, so a broadcast never eats a draft.
function shell() {
  const board = document.getElementById('waiting-board');
  const list = document.getElementById('waiting-list');
  if (!board || !list) return null;
  if (!document.getElementById('chat-compose')) {
    // The open questions chip opens the Open questions panel.
    const strip = el('button', 'chat-strip billion-bar-control');
    strip.id = 'chat-strip';
    strip.type = 'button';
    strip.setAttribute('aria-controls', 'chat-questions');
    strip.hidden = true;
    strip.onclick = () => setQuestionsOpen(!panelOpen);
    const head = readHead();
    head.prepend(strip);
    const bar = document.getElementById('billion-bar');
    if (bar) bar.appendChild(head);
    else board.prepend(head);
    // The panel covers the thread only, so the box stays below it.
    const body = el('div', 'chat-body');
    board.insertBefore(body, list);
    body.append(list, questionsPanel());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && waitingActive && document.getElementById('chat-questions')?.hidden === false) {
        e.preventDefault();
        setQuestionsOpen(false);
      }
    });

    // A short-lived line over the thread saying what a tap just did.
    const note = el('div', 'chat-toast');
    note.id = 'chat-toast';
    note.setAttribute('role', 'status');
    note.hidden = true;
    body.appendChild(note);

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
    row.id = 'chat-compose-row';
    const input = el('textarea', 'chat-control');
    input.id = 'chat-input';
    input.rows = 1;
    input.setAttribute('aria-label', 'Message Billion');
    noAutofill(input);
    input.oninput = () => { fitInput(input); renderSlashHint(); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
    const clip = el('button', 'chat-mic chat-control chat-attach');
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
    const mic = el('button', 'chat-mic chat-control');
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
    const btn = el('button', 'waiting-send chat-control', 'Send');
    btn.id = 'chat-send';
    btn.type = 'submit';
    const tg = el('div', 'chat-telegram');
    tg.id = 'chat-telegram';
    tg.setAttribute('role', 'status');
    tg.hidden = true;
    const notice = el('div', 'chat-notice');
    notice.id = 'chat-notice';
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    const error = el('p', 'waiting-error');
    error.id = 'chat-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    row.append(input, clip, pick, mic, talkButton(), btn);
    const slash = el('p', 'chat-slash-hint', 'Runs in Billion\'s terminal. A picker can\'t open here: give the argument, e.g. /model opus. Start with // to send it as a message.');
    slash.id = 'chat-slash-hint';
    slash.hidden = true;
    form.append(tg, notice, target, chips, voice, talkBar(), row, slash, error);
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


// Under the box while it holds a slash command (server/owner.js, slashCommand).
function renderSlashHint() {
  const hint = document.getElementById('chat-slash-hint');
  const text = document.getElementById('chat-input')?.value.trim() || '';
  if (hint) hint.hidden = answerTarget() || !/^\/(?!\/)[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/.test(text);
}

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
    : target ? `Answer Q${target.n}`
    // A phone's box is too narrow for the hint; typing / still shows how.
    : window.matchMedia?.(PHONE).matches ? 'Message Billion' : 'Message Billion, or /command to run one';
  document.getElementById('chat-send').disabled = !!sending;
  document.getElementById('chat-send').textContent = sending ? 'Sending' : 'Send';
  renderAttached();
  renderSlashHint();
  const error = document.getElementById('chat-error');
  error.textContent = sendError;
  error.hidden = !sendError;
  renderNotice();
  renderTelegram();
}

// The chip: how many questions are open, "!" when one is blocking.
function renderStrip() {
  const strip = document.getElementById('chat-strip');
  const open = openItems();
  strip.hidden = !open.length;
  strip.innerHTML = '';
  if (!open.length) return;
  const many = open.length === 1 ? '' : 's';
  strip.setAttribute('aria-expanded', String(panelOpen));
  const blocking = open.some(q => q.urgency === 'blocking');
  strip.setAttribute('aria-label', `${open.length} open question${many}${blocking ? ', blocking' : ''}: ${panelOpen ? 'hide' : 'show'} them by ${groupBy}`);
  strip.classList.toggle('blocking', blocking);
  if (blocking) strip.appendChild(el('b', 'waiting-urgent', '!'));
  const label = el('span', 'chat-strip-label');
  label.append('open', el('span', 'chat-wide', ` question${many}`));
  strip.append(el('span', 'chat-strip-count', String(open.length)), label);
}

// --- The Open questions panel: open questions by project or by type, answered
// in place. Opened from the bar's chip or the tab's badge; open or closed, the
// grouping and each section's open or closed are kept per browser.
const PANEL_KEY = 'agent007-questions-open';
const BY_KEY = 'agent007-questions-by';
const SECTION_KEY = (by, name) => `agent007-questions-section:${by}:${name}`;
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
let panelOpen, groupBy;
const PHONE = '(max-width: 700px)';

const openItems = () => waitingItems.filter(item => item.status === 'open').sort(byUrgency);

// One group per project (or type) with something open, its questions most
// urgent then oldest. Grouped in that order, so each group lands where its
// most urgent question falls: blocking groups first, then by oldest.
export function questionGroups(items = waitingItems, by = groupBy) {
  const groups = new Map();
  for (const item of items.filter(i => i.status === 'open').sort(byUrgency)) {
    const name = (by === 'type' ? item.type || 'other' : item.project || 'general');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups].map(([name, list]) => ({ name, items: list }));
}

const asGrouping = (by) => (by === 'type' ? 'type' : 'project');

export function setGroupBy(by) {
  groupBy = asGrouping(by);
  store.set(BY_KEY, groupBy);
  renderWaiting();
}

// What a page load reads back from this browser; a test calls it to stand in for a refresh.
export function _reloadQuestionPrefs() {
  panelOpen = store.get(PANEL_KEY) === '1';
  groupBy = asGrouping(store.get(BY_KEY));
}
_reloadQuestionPrefs();

export function setQuestionsOpen(open, { focus = true } = {}) {
  panelOpen = open;
  store.set(PANEL_KEY, open ? '1' : '0');
  renderWaiting();
  if (focus) document.getElementById(open ? 'chat-questions-close' : 'chat-strip')?.focus();
}

// The thread's bubble for a question: scrolled to and flashed.
function jumpTo(id) {
  const row = document.querySelector(`.chat-msg[data-q="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth;   // restart the animation
  row.classList.add('flash');
}

function age(iso) {
  const mins = (Date.now() - Date.parse(iso)) / 60000;
  if (Number.isNaN(mins)) return '';
  return mins < 1 ? 'now' : mins < 60 ? `${Math.floor(mins)}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
}

function questionRow(q) {
  const row = el('div', 'chat-questions-row');
  row.dataset.q = q.id;
  const line = el('button', 'chat-questions-line');
  line.type = 'button';
  line.title = `${q.text}\n\nShow in the thread`;
  line.append(qLabel(q), el('span', 'chat-questions-text', String(q.text).split('\n')[0]), el('span', 'chat-questions-age', age(q.at)));
  line.onclick = () => { setQuestionsOpen(false, { focus: false }); jumpTo(q.id); };
  const actions = el('div', 'chat-questions-actions');
  if (Array.isArray(q.choices) && q.choices.length) actions.appendChild(choiceButtons(q));
  // Full screen on a phone, over the box: it closes so the box can be typed in.
  actions.appendChild(replyButton(q, () => {
    if (window.matchMedia?.(PHONE).matches) setQuestionsOpen(false, { focus: false });
    replyToQuestion(q.id);
  }));
  row.append(line, actions);
  const error = errorLine(q);
  if (error) row.appendChild(error);
  return row;
}

// A section: an <h3> (so screen readers can jump between sections) wrapping a
// button (name, count, "!" when a blocking question is inside, chevron),
// closed until tapped open. The button controls the body holding the rows.
function questionSection(name, items) {
  const key = SECTION_KEY(groupBy, name);
  const open = store.get(key) === '1';
  const section = el('section', 'chat-questions-group');
  section.classList.toggle('open', open);
  const head = el('button', 'chat-questions-project');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  const body = el('div', 'chat-questions-body');
  body.id = `qsec-${groupBy}-${encodeURIComponent(name).replace(/%/g, '_')}`;
  body.hidden = !open;
  head.setAttribute('aria-controls', body.id);
  const blocking = items.some(q => q.urgency === 'blocking');
  head.setAttribute('aria-label', `${name}, ${items.length} open${blocking ? ', blocking' : ''}`);
  head.append(el('span', 'chat-questions-name', name), el('span', 'chat-questions-count', String(items.length)));
  if (blocking) head.appendChild(el('b', 'waiting-urgent chat-questions-urgent', '!')).setAttribute('aria-hidden', 'true');
  head.appendChild(el('span', 'chat-questions-chevron', '▾')).setAttribute('aria-hidden', 'true');
  head.onclick = () => {
    store.set(key, open ? '0' : '1');
    renderWaiting();
    document.querySelector(`.chat-questions-project[data-name="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
  };
  head.dataset.name = name;
  section.dataset.key = name;
  section.dataset.rev = rev([open, items, items.map(q => [pending.get(q.id), errors.get(q.id)])]);
  section.append(el('h3', 'chat-questions-heading'), body);
  section.firstChild.appendChild(head);
  if (open) for (const q of items) body.appendChild(questionRow(q));
  return section;
}

function renderPanel() {
  const panel = document.getElementById('chat-questions');
  const groups = questionGroups();
  const shown = panelOpen && groups.length > 0;
  panel.hidden = !shown;
  document.getElementById('waiting-board').classList.toggle('questions-open', shown);
  for (const b of panel.querySelectorAll('.chat-questions-by button')) b.setAttribute('aria-pressed', String(b.value === groupBy));
  const body = document.getElementById('chat-questions-body');
  // In place, never emptied, so the reader keeps their place in a long list.
  patchChildren(body, shown ? groups.map(({ name, items }) => questionSection(name, items)) : []);
}

function questionsPanel() {
  const panel = el('div', 'chat-questions');
  panel.id = 'chat-questions';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Open questions');
  panel.hidden = true;
  const head = el('div', 'chat-questions-head');
  const close = el('button', 'chat-questions-close chat-control', '×');
  close.id = 'chat-questions-close';
  close.type = 'button';
  close.title = 'Back to the chat (Esc)';
  close.setAttribute('aria-label', 'Close open questions');
  close.onclick = () => setQuestionsOpen(false);
  // by project | by type
  const by = el('div', 'chat-questions-by');
  by.setAttribute('role', 'group');
  by.setAttribute('aria-label', 'Group questions');
  for (const value of ['project', 'type']) {
    const b = el('button', '', `by ${value}`);
    b.type = 'button';
    b.value = value;
    b.onclick = () => setGroupBy(value);
    by.appendChild(b);
  }
  head.append(el('h2', 'chat-questions-title', 'Open questions'), by, close);
  const body = el('div', 'chat-questions-body');
  body.id = 'chat-questions-body';
  panel.append(head, body);
  return panel;
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
  clearTimeout(undoTimer);
  undoSoonest = Infinity;
  // Updated in place rather than emptied and refilled, so a broadcast never
  // moves a reader who has scrolled up the thread.
  const expanded = new Set([...list.children].filter(row => row.querySelector('.chat-work-details[open]')).map(row => row.dataset.id));
  const pendingIds = new Set(waitingOnBillion());
  const currentRequest = billionStatus?.currentRequest ?? pendingIds.values().next().value;
  const nodes = chatMessages.map(m => bubble(m, expanded.has(m.id), pendingIds, currentRequest));
  if (!chatMessages.length) {
    const empty = el('p', 'waiting-empty', 'Nothing here yet. Say something to Billion.');
    empty.dataset.key = 'empty';
    empty.hidden = !!noticeText();
    nodes.push(empty);
  }
  patchChildren(list, nodes);
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
  renderPanel();
  renderComposer();
  renderReadHead();
  initSubTabs(() => renderWaiting({ toBottom: true }));
  renderRound();
  renderBillionStatus();
}
