// The "Billion" tab: the owner's chat with Billion, the web twin of the
// Telegram channel. One thread of the owner's messages, Billion's tell_owner
// replies and its notify_owner questions (answered with a tap or a typed line),
// a strip pinning the open questions, and a text box that is typed into
// Billion's terminal as [Owner via app] (server/owner.js ownerSays). Shares the
// terminal viewport with the terminals and the job board, like Jobs does.
import { agents, activeSessionId, waitingItems, chatMessages, waitingActive, setWaitingActive, setView } from './state.js';
import { send } from './ws.js';
import { hideJobBoard } from './jobs.js';
import { stopVoice } from './voice.js';

const errors = new Map();   // question id -> why the last tap did not go through
const pending = new Set();  // question ids tapped, waiting for the server to say so
let sending = null;         // the nonce of the text box's message on its way
let sendError = '';
let detached = null;        // the question the owner chose not to answer with the box
let nonces = 0;
const SEND_TIMEOUT_MS = 20 * 1000;
let lastShown = null;       // the newest message when the thread was last drawn

export const openCount = () => waitingItems.filter(item => item.status === 'open').length;

export function showWaiting() {
  hideJobBoard();
  const agent = activeSessionId ? agents.get(activeSessionId) : null;
  if (agent) agent.termEl.style.display = 'none';
  document.getElementById('terminal-empty').style.display = 'none';
  document.getElementById('waiting-board').style.display = 'flex';
  // The mic types into a terminal, and its button would sit on Send.
  stopVoice();
  document.body.classList.add('billion-chat');
  setWaitingActive(true);
  // A reload comes back here, not to the terminal that was open before.
  localStorage.removeItem('agent007-active-tab');
  setView(document.body.dataset.view);
  renderWaiting({ toBottom: true });
  if (window._onBoardVisibilityChanged) window._onBoardVisibilityChanged();
}

// The phone's Terminal button, pressed while this tab is showing: back to
// the terminal that was open, or to the empty state.
export function leaveWaiting() {
  hideWaiting();
  if (!activeSessionId || !agents.has(activeSessionId)) document.getElementById('terminal-empty').style.display = 'flex';
  else agents.get(activeSessionId).termEl.style.display = 'block';
}

export function hideWaiting() {
  const board = document.getElementById('waiting-board');
  if (board) board.style.display = 'none';
  document.body.classList.remove('billion-chat');
  setWaitingActive(false);
  setView(document.body.dataset.view);
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

// What the text box answers: the oldest open blocking question, else the
// oldest open one, unless the owner said this one is not what they are writing about.
export function answerTarget() {
  const open = waitingItems.filter(item => item.status === 'open').sort(byAge);
  const target = open.find(item => item.urgency === 'blocking') || open[0];
  return target && target.id !== detached ? target : null;
}

const billionRunning = () => [...agents.values()].some(a => a.isBillion);

// A tap on a question's choice.
function answer(q, choice) {
  if (pending.has(q.id)) return;
  errors.delete(q.id);
  if (send({ type: 'waiting-answer', id: q.id, answer: choice })) pending.add(q.id);
  else errors.set(q.id, 'Not connected to the server; try again in a moment.');
  renderWaiting();
}

export function handleWaitingError(msg) {
  pending.delete(msg.id);
  errors.set(msg.id, msg.error);
  renderWaiting();
}

function submit() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim();
  if (!text || sending) return;
  const target = answerTarget();
  const nonce = `c${++nonces}`;
  if (!send({ type: 'chat-send', nonce, text, ...(target ? { answers: target.id } : {}) })) {
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
  }
  renderComposer();
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
    return el('p', 'chat-answered', `you answered: ${q.answer}${VIA[q.answeredVia] ? ` (${VIA[q.answeredVia]})` : ''}`);
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
  const dismiss = el('button', 'waiting-dismiss', 'Dismiss');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', `Dismiss Q${q.n}`);
  dismiss.onclick = () => send({ type: 'waiting-dismiss', id: q.id });
  foot.appendChild(dismiss);
  if (errors.has(q.id)) {
    const error = el('p', 'waiting-error', errors.get(q.id));
    error.setAttribute('role', 'alert');
    foot.appendChild(error);
  }
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
  box.appendChild(el('p', 'chat-text', m.text));
  const meta = [m.voice && '(voice)', mine && m.via === 'telegram' && 'Telegram', time(m.at)].filter(Boolean);
  box.appendChild(el('span', 'chat-meta', meta.join(' · ')));
  if (m.q) box.appendChild(questionFoot(m.q));
  row.appendChild(box);
  return row;
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
    const btn = el('button', 'waiting-send', 'Send');
    btn.id = 'chat-send';
    btn.type = 'submit';
    const error = el('p', 'waiting-error');
    error.id = 'chat-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    row.append(input, btn);
    form.append(target, row, error);
    board.append(jump, form);
  }
  return list;
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
    x.onclick = () => { detached = target.id; renderComposer(); };
    chip.appendChild(x);
  }
  const running = billionRunning();
  input.placeholder = !running ? 'Billion is not running; start it to send'
    : target ? `Answer Q${target.n}` : 'Message Billion';
  document.getElementById('chat-send').disabled = !!sending;
  document.getElementById('chat-send').textContent = sending ? 'Sending' : 'Send';
  const error = document.getElementById('chat-error');
  error.textContent = sendError;
  error.hidden = !sendError;
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
    };
    strip.appendChild(btn);
  }
}

// toBottom: the tab was just opened, so start at the newest.
export function renderWaiting({ toBottom = false } = {}) {
  // Settled: the server moved it on, so it is no longer ours to wait for.
  for (const id of new Set([...pending, ...errors.keys()])) {
    if (!waitingItems.some(item => item.id === id && item.status === 'open')) { pending.delete(id); errors.delete(id); }
  }
  if (detached && !waitingItems.some(item => item.id === detached && item.status === 'open')) detached = null;
  if (!waitingActive) return;
  const list = shell();
  if (!list) return;
  const follow = toBottom || atBottom(list);
  const keep = list.scrollTop;
  list.innerHTML = '';
  if (!chatMessages.length) list.appendChild(el('p', 'waiting-empty', 'Nothing here yet. Say something to Billion.'));
  for (const m of chatMessages) list.appendChild(bubble(m));
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
}
