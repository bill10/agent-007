// The "Waiting on you" tab: Billion's notify_owner questions, answered here
// with a choice or a typed line (server/owner.js answerWaiting). Shares the
// terminal viewport with the terminals and the job board, like Jobs does.
import { agents, activeSessionId, waitingItems, waitingActive, setWaitingActive, setView } from './state.js';
import { send } from './ws.js';
import { hideJobBoard } from './jobs.js';

const ANSWERED_SHOWN = 20;
const drafts = new Map();   // item id -> reply typed but not sent, kept across re-renders
const errors = new Map();   // item id -> why the last answer did not go through
const pending = new Set();  // item ids answered, waiting for the server to say so
let answeredOpen = false;   // the Answered section, as the owner left it

export const openCount = () => waitingItems.filter(item => item.status === 'open').length;

export function showWaiting() {
  hideJobBoard();
  const agent = activeSessionId ? agents.get(activeSessionId) : null;
  if (agent) agent.termEl.style.display = 'none';
  document.getElementById('terminal-empty').style.display = 'none';
  document.getElementById('waiting-board').style.display = 'flex';
  setWaitingActive(true);
  setView(document.body.dataset.view);
  renderWaiting();
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
  setWaitingActive(false);
  setView(document.body.dataset.view);
}

function answer(item, text) {
  const body = text.trim();
  if (!body || pending.has(item.id)) return;
  errors.delete(item.id);
  if (send({ type: 'waiting-answer', id: item.id, answer: body })) pending.add(item.id);
  else errors.set(item.id, 'Not connected to the server; try again in a moment.');
  renderWaiting();
}

export function handleWaitingError(msg) {
  pending.delete(msg.id);
  errors.set(msg.id, msg.error);
  renderWaiting();
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function openCard(item) {
  const busy = pending.has(item.id);
  const card = el('article', 'waiting-card');
  card.dataset.id = item.id;
  const head = el('div', 'waiting-card-head');
  head.append(el('span', 'waiting-card-n', `Q${item.n}`), el('span', 'waiting-card-time', ago(item.at)));
  const dismiss = el('button', 'explorer-icon-btn waiting-dismiss', '×');
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', `Dismiss Q${item.n}`);
  dismiss.onclick = () => send({ type: 'waiting-dismiss', id: item.id });
  head.appendChild(dismiss);
  card.append(head, el('p', 'waiting-card-text', item.text));

  if (Array.isArray(item.choices) && item.choices.length) {
    const choices = el('div', 'waiting-choices');
    for (const choice of item.choices) {
      const btn = el('button', `waiting-choice${choice === item.recommended ? ' recommended' : ''}`, choice);
      if (choice === item.recommended) {
        btn.appendChild(el('span', 'waiting-choice-tag', 'recommended'));
        btn.setAttribute('aria-label', `${choice} (recommended)`);
      }
      btn.disabled = busy;
      btn.onclick = () => answer(item, choice);
      choices.appendChild(btn);
    }
    card.appendChild(choices);
  }

  const form = el('form', 'waiting-reply');
  const input = el('input');
  input.type = 'text';
  input.placeholder = item.choices?.length ? 'Or type an answer' : 'Type an answer';
  input.setAttribute('aria-label', `Answer Q${item.n}`);
  input.value = drafts.get(item.id) || '';
  input.disabled = busy;
  input.oninput = () => drafts.set(item.id, input.value);
  const sendBtn = el('button', 'waiting-send', busy ? 'Sending' : 'Send');
  sendBtn.type = 'submit';
  sendBtn.disabled = busy;
  form.onsubmit = (e) => {
    e.preventDefault();
    answer(item, input.value);
  };
  form.append(input, sendBtn);
  card.appendChild(form);

  if (errors.has(item.id)) {
    const error = el('p', 'waiting-error', errors.get(item.id));
    error.setAttribute('role', 'alert');
    card.appendChild(error);
  }
  return card;
}

function answeredRow(item) {
  const li = el('li', 'waiting-answered-item');
  li.append(el('span', 'waiting-card-n', `Q${item.n}`), el('span', 'waiting-answered-text', item.text));
  const via = item.answeredVia === 'telegram' ? 'Telegram' : 'app';
  li.appendChild(el('span', 'waiting-answered-answer', `→ ${item.answer} · ${via} · ${ago(item.answeredAt)}`));
  return li;
}

export function renderWaiting() {
  const list = document.getElementById('waiting-list');
  if (!list) return;
  // Settled: the server moved it on, so it is no longer ours to wait for.
  for (const id of new Set([...pending, ...errors.keys(), ...drafts.keys()])) {
    if (!waitingItems.some(item => item.id === id && item.status === 'open')) { pending.delete(id); drafts.delete(id); errors.delete(id); }
  }
  if (!waitingActive) return;
  const focused = document.activeElement?.closest?.('.waiting-card')?.dataset.id;
  list.innerHTML = '';
  const open = waitingItems.filter(item => item.status === 'open').reverse();
  if (!open.length) list.appendChild(el('p', 'waiting-empty', 'Nothing waiting on you.'));
  for (const item of open) list.appendChild(openCard(item));

  const answered = waitingItems.filter(item => item.status === 'answered')
    .sort((a, b) => String(b.answeredAt).localeCompare(String(a.answeredAt))).slice(0, ANSWERED_SHOWN);
  if (answered.length) {
    const section = el('details', 'waiting-answered');
    section.open = answeredOpen;
    section.ontoggle = () => { answeredOpen = section.open; };
    section.appendChild(el('summary', null, `Answered (${answered.length})`));
    const ul = el('ul');
    for (const item of answered) ul.appendChild(answeredRow(item));
    section.appendChild(ul);
    list.appendChild(section);
  }
  // A broadcast re-renders under the owner's fingers; keep their place.
  if (focused) list.querySelector(`.waiting-card[data-id="${CSS.escape(focused)}"] input`)?.focus();
}
