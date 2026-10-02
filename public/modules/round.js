// The Billion tab's "This round" view and its status line (docs/BILLION.md,
// "Rounds"). The owner is come to twice a day: a round is Billion's brief,
// then one section per project (department) with at most two cards, each a
// question answered by a tap or a typed reply. Answered cards collapse in
// place; nothing reorders or jumps while the owner scrolls or types, since a
// card is updated where it stands and the view is only rebuilt when the set of
// cards changes (keeping the scroll position, drafts and focus). "Earlier"
// holds what past rounds consolidated or got answered, closed by default.
// The chat thread is the second sub-tab (public/modules/waiting.js).
import { waitingItems, roundInfo, billionStatus } from './state.js';
import { send } from './ws.js';

const SUB_KEY = 'agent007-billion-sub';
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// --- The two views: This round and Chat ---

// The owner's pick, else Chat until a round has been released: on a new
// install that is where Billion introduces itself, and where a missing or
// logged-out CLI is explained.
export const subTab = () => {
  const saved = store.get(SUB_KEY);
  return saved === 'chat' || saved === 'round' ? saved : roundInfo?.current ? 'round' : 'chat';
};
let onChat = () => {};

export function setSubTab(which) {
  store.set(SUB_KEY, which === 'chat' ? 'chat' : 'round');
  paintSubTabs();
  if (which === 'chat') onChat();
  else renderRound();
}

function paintSubTabs() {
  const board = document.getElementById('waiting-board');
  if (!board) return;
  const which = subTab();
  board.dataset.sub = which;
  for (const b of document.querySelectorAll('#billion-subtabs [data-sub]')) {
    b.setAttribute('aria-selected', String(b.dataset.sub === which));
    b.tabIndex = b.dataset.sub === which ? 0 : -1;
  }
}

// chat: what showing the thread takes (waiting.js draws it at the bottom).
export function initSubTabs(chat) {
  onChat = chat;
  const tabs = document.getElementById('billion-subtabs');
  if (tabs && !tabs.dataset.wired) {
    tabs.dataset.wired = '1';
    for (const b of tabs.querySelectorAll('[data-sub]')) b.onclick = () => setSubTab(b.dataset.sub);
    tabs.onkeydown = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setSubTab(subTab() === 'chat' ? 'round' : 'chat');
      tabs.querySelector('[aria-selected="true"]')?.focus();
    };
  }
  paintSubTabs();
}

// --- The status line ---

export function roundTime(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms);
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s+/g, ' ');
  const today = new Date(now);
  const tomorrow = new Date(now + 864e5);
  return d.toDateString() === today.toDateString() ? hm
    : d.toDateString() === tomorrow.toDateString() ? `tomorrow ${hm}`
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

// "Working: reviewing PR #120 · 3 workers running · next round 3:30 pm"
export function statusLine(status = billionStatus, info = roundInfo, now = Date.now()) {
  const s = status || {};
  const waiting = Array.isArray(s.pending) ? s.pending.length : 0;
  const lead = !status ? 'Connecting…'
    : s.disconnected ? 'Reconnecting…'
    : !s.running ? 'Billion is not running'
      : s.awaitingReply ? (s.working ? (waiting > 1 ? `Working on your ${waiting} messages…` : 'Working on your message…') : 'Replying shortly…')
        : s.text ? (s.working ? `Working: ${s.text}` : s.text)
          : s.working ? 'Thinking…' : 'Idle';
  const next = s.nextRoundAt ?? info?.next?.at;
  const bits = [lead];
  if (s.workers) bits.push(`${s.workers} worker${s.workers === 1 ? '' : 's'} running`);
  if (next && info?.on !== false) bits.push(`next briefing ${roundTime(next, now)}`);
  return bits.join(' · ');
}

export function renderBillionStatus() {
  const line = document.getElementById('billion-status');
  if (!line) return;
  const s = billionStatus || {};
  const text = statusLine();
  const mood = !billionStatus ? 'idle' : !s.running ? 'off' : s.working ? 'busy' : 'idle';
  if (line.dataset.text === text && line.dataset.mood === mood) return;
  line.dataset.text = text;
  line.dataset.mood = mood;
  line.innerHTML = '';
  line.title = text;
  line.append(el('span', 'billion-status-dot'), el('span', 'billion-status-text', text));
}

// --- What the round shows ---

const DONE = new Set(['answered', 'dismissed']);
const RANK = { blocking: 0, low: 2 };

// { sections: [{ key, title, items }], earlier, total, done }. With rounds on:
// the round's own questions by project, after "Needs you now" (questions sent
// outside a round, open or answered since the round began). With rounds off:
// every open question, by project.
export function roundModel(items = waitingItems, info = roundInfo) {
  const current = info?.current || null;
  const since = current ? Date.parse(current.releasedAt || current.at) : Infinity;
  const inRound = (i) => (info?.on === false ? i.status === 'open' : !!current && i.round === current.id);
  const urgent = (i) => info?.on !== false && !i.round && i.status !== 'consolidated'
    && (i.status === 'open' || Date.parse(i.answeredAt) >= since);
  const shown = new Set();
  const sections = [];
  const byNum = (a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || String(a.at).localeCompare(String(b.at));
  const now = items.filter(urgent).sort(byNum);
  // Before the first round every question shows at once, not only emergencies.
  if (now.length) sections.push({ key: 'now', title: current ? 'Needs you now' : 'Open questions', items: now, urgent: !!current });
  now.forEach(i => shown.add(i.id));
  const byProject = new Map();
  const ordered = items.filter(i => !shown.has(i.id) && inRound(i))
    .sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || (a.pos ?? Infinity) - (b.pos ?? Infinity) || (RANK[a.urgency] ?? 1) - (RANK[b.urgency] ?? 1) || String(a.at).localeCompare(String(b.at)));
  for (const item of ordered) {
    const name = item.project || 'general';
    if (!byProject.has(name)) byProject.set(name, []);
    byProject.get(name).push(item);
    shown.add(item.id);
  }
  for (const [name, list] of byProject) sections.push({ key: `p:${name}`, title: name, items: list });
  const all = sections.flatMap(s => s.items);
  const when = (i) => i.consolidatedAt || i.answeredAt || i.releasedAt || i.at;
  const earlier = items.filter(i => !shown.has(i.id) && (i.status === 'consolidated' || i.status === 'answered'))
    .sort((a, b) => String(when(b)).localeCompare(String(when(a))));
  return { sections, earlier, total: all.length, done: all.filter(i => DONE.has(i.status)).length };
}

// --- Cards ---

// "1d", "1d 3d": the round's items the owner marks done (server/owner.js doneNumbers).
export function doneNumbers(text) {
  const body = String(text ?? '').trim();
  if (!/^(\d{1,3}\s?d)([\s,]+\d{1,3}\s?d)*$/i.test(body)) return null;
  return [...new Set(body.match(/\d{1,3}/g).map(Number))];
}

let starting = null;         // the round on screen when "Start the briefing now" was pressed
const pending = new Map();   // question id -> its status when tapped
const errors = new Map();    // question id -> { error, status }
const drafts = new Map();    // question id -> typed reply not sent yet
let earlierOpen = false;
let built = '';              // the structure last drawn: rebuilt only when it changes
const UNDO_MS = 60 * 1000;

export function handleRoundError(msg) {
  pending.delete(msg.id);
  errors.set(msg.id, { error: msg.error, status: waitingItems.find(i => i.id === msg.id)?.status });
  renderRound();
}

function request(q, msg) {
  if (pending.has(q.id)) return;
  errors.delete(q.id);
  if (send(msg)) pending.set(q.id, q.status);
  else errors.set(q.id, { error: 'Not connected to the server; try again in a moment.', status: q.status });
  renderRound();
}

function label(q) {
  const n = el('span', 'waiting-card-n', `Q${q.n}`);
  if (q.urgency === 'blocking') {
    n.prepend(el('b', 'waiting-urgent', '!'), ' ');
    n.title = 'blocking: something is stopped until you answer';
  } else if (q.urgency === 'low') {
    n.classList.add('low');
    n.title = 'optional';
  }
  return n;
}

const VIA = { telegram: ' on Telegram', terminal: ' in the terminal' };

// The card's state, as far as what is drawn: a change redraws its lower half.
const cardKey = (q) => [q.status, q.answer, pending.has(q.id), errors.get(q.id)?.error, q.answeredAt && Date.now() - Date.parse(q.answeredAt) < UNDO_MS].join('|');

function card(q) {
  const node = el('article', 'round-card');
  node.dataset.q = q.id;
  const head = el('div', 'round-card-head');
  // The owner's short number for it in this round: "1d" (or Done) clears it.
  if (q.num) {
    const num = el('span', 'round-card-num', String(q.num));
    num.title = `Item ${q.num}: type ${q.num}d to mark it done`;
    head.append(num);
  }
  head.append(label(q));
  if (q.type && q.type !== 'other') head.append(el('span', 'round-card-type', q.type));
  node.append(head, el('p', 'round-card-text', q.text), el('div', 'round-card-foot'));
  fillFoot(node, q);
  return node;
}

function fillFoot(node, q) {
  const foot = node.querySelector('.round-card-foot');
  node.dataset.key = cardKey(q);
  node.classList.toggle('done', DONE.has(q.status));
  node.setAttribute('aria-label', `Q${q.n}${DONE.has(q.status) ? `, ${q.status}` : ''}`);
  // Answered: one line; the question's text folds away under it (CSS).
  if (DONE.has(q.status)) {
    foot.innerHTML = '';
    const line = el('p', 'round-card-answer', q.status === 'dismissed' ? 'skipped'
      : q.done ? `✓ done${VIA[q.answeredVia] || ''}`
        : `✓ ${q.answeredBy || 'you'} answered${VIA[q.answeredVia] || ''}: ${q.answer}`);
    if (q.status === 'answered' && (q.answeredVia === 'app' || q.answeredVia === 'telegram') && Date.now() - Date.parse(q.answeredAt) < UNDO_MS) {
      const undo = el('button', 'chat-link', 'Undo');
      undo.type = 'button';
      undo.setAttribute('aria-label', `Undo the answer to Q${q.n}`);
      undo.disabled = pending.has(q.id);
      undo.onclick = () => request(q, { type: 'waiting-reopen', id: q.id });
      line.append(' ', undo);
    }
    foot.append(line);
    errorInto(foot, q);
    return;
  }
  // Open: the reply box is kept across redraws, so a draft and its focus survive.
  let reply = foot.querySelector('.round-reply');
  if (!reply) {
    foot.innerHTML = '';
    if (Array.isArray(q.choices) && q.choices.length) {
      const choices = el('div', 'waiting-choices');
      for (const choice of [...q.choices].sort((a, b) => (b === q.recommended) - (a === q.recommended))) {
        const btn = el('button', `waiting-choice${choice === q.recommended ? ' recommended' : ''}`, choice);
        btn.type = 'button';
        if (choice === q.recommended) {
          btn.appendChild(el('span', 'waiting-choice-tag', 'recommended'));
          btn.setAttribute('aria-label', `${choice} (recommended)`);
        }
        btn.onclick = () => request(q, { type: 'waiting-answer', id: q.id, answer: choice });
        choices.append(btn);
      }
      foot.append(choices);
    }
    reply = el('form', 'round-reply');
    const box = el('textarea', 'chat-control round-reply-input');
    box.rows = 1;
    box.placeholder = q.choices?.length ? 'Or type an answer' : 'Type your answer';
    box.setAttribute('aria-label', `Answer Q${q.n}`);
    box.value = drafts.get(q.id) || '';
    box.oninput = () => {
      drafts.set(q.id, box.value);
      box.style.height = 'auto';
      box.style.height = `${Math.min(box.scrollHeight, 120)}px`;
    };
    box.onkeydown = (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      reply.onsubmit(e);
    };
    const go = el('button', 'waiting-send chat-control round-reply-send', 'Send');
    go.type = 'submit';
    const finish = q.num ? el('button', 'chat-link round-done', 'Done') : null;
    if (finish) {
      finish.type = 'button';
      finish.title = `Done: tell Billion item ${q.num} is done (or type ${q.num}d)`;
      finish.setAttribute('aria-label', `Item ${q.num} done`);
      finish.onclick = () => request(q, { type: 'round-done', id: q.id, nums: [q.num] });
    }
    const skip = el('button', 'chat-link round-skip', 'Skip');
    skip.type = 'button';
    skip.title = 'Not now: dismiss it';
    skip.setAttribute('aria-label', `Skip Q${q.n}`);
    skip.onclick = () => send({ type: 'waiting-dismiss', id: q.id });
    reply.onsubmit = (e) => {
      e?.preventDefault?.();
      const text = box.value.trim();
      if (!text) return;
      drafts.delete(q.id);
      const live = waitingItems.find(i => i.id === q.id) || q;
      // "1d 3d" in any card's box marks those items done, not an answer to this one.
      const nums = doneNumbers(text);
      if (nums) { box.value = ''; return request(live, { type: 'round-done', id: q.id, nums }); }
      request(live, { type: 'waiting-answer', id: q.id, answer: text });
    };
    reply.append(box, go, ...(finish ? [finish] : []), skip);
    foot.append(reply);
  }
  for (const b of foot.querySelectorAll('button')) b.disabled = pending.has(q.id);
  foot.querySelector('.waiting-error')?.remove();
  errorInto(foot, q);
}

function errorInto(foot, q) {
  if (!errors.has(q.id)) return;
  const line = el('p', 'waiting-error', errors.get(q.id).error);
  line.setAttribute('role', 'alert');
  foot.append(line);
}

function earlierRow(q) {
  const row = el('div', 'round-earlier-row');
  row.dataset.q = q.id;
  const what = q.status === 'answered' ? `answered: ${q.answer}` : 'consolidated';
  row.append(label(q), el('span', 'round-earlier-text', String(q.text).split('\n')[0]), el('span', 'round-earlier-what', what));
  row.title = q.text;
  return row;
}

function heading(info, model) {
  const head = el('div', 'round-head');
  const current = info?.current;
  const title = info?.on === false ? 'Open questions'
    : current ? `${current.name || 'Briefing'} · ${String(current.label || '').split(' ')[0]}` : 'No briefing yet';
  head.append(el('h2', 'round-title', title));
  if (model.total) {
    const count = el('span', 'round-count', `${model.done} of ${model.total} done`);
    count.setAttribute('aria-live', 'polite');
    head.append(count);
  }
  return head;
}

// "Start the round now": the next round, released at once, when something waits for it.
function startButton(info) {
  if (info?.on === false || !info?.queued) return null;
  const btn = el('button', 'waiting-send chat-control round-start', `Start the briefing now (${info.queued} waiting)`);
  btn.type = 'button';
  btn.title = 'Show the next briefing now instead of at its time (same two per department)';
  btn.disabled = starting !== null && starting === (info.current?.id ?? '');
  btn.onclick = () => {
    if (!send({ type: 'round-start' })) return;
    starting = info.current?.id ?? '';
    renderRound();
    // A refusal comes back as a notification: the button is pressable again after a while.
    setTimeout(() => { if (starting !== null) { starting = null; renderRound(); } }, 15000);
  };
  return btn;
}

// Rebuilt only when the cards on screen change; otherwise each card is
// brought up to date where it stands.
export function renderRound() {
  for (const [id, status] of pending) if (waitingItems.find(i => i.id === id)?.status !== status) pending.delete(id);
  for (const [id, { status }] of errors) if (waitingItems.find(i => i.id === id)?.status !== status) errors.delete(id);
  const view = document.getElementById('round-view');
  if (!view) return;
  paintSubTabs();   // the default view changes with the first round
  const model = roundModel();
  const info = roundInfo;
  if (starting !== null && starting !== (info?.current?.id ?? '')) starting = null;
  const structure = JSON.stringify([info?.on, info?.current?.id, info?.current?.brief, info?.next?.at, info?.queued, starting, earlierOpen,
    model.sections.map(s => [s.key, s.items.map(i => i.id)]), model.earlier.map(i => [i.id, i.status, i.answer])]);
  if (structure === built) {
    for (const s of model.sections) {
      for (const q of s.items) {
        const node = view.querySelector(`.round-card[data-q="${CSS.escape(q.id)}"]`);
        if (node && node.dataset.key !== cardKey(q)) fillFoot(node, q);
      }
    }
    const count = view.querySelector('.round-count');
    if (count) count.textContent = `${model.done} of ${model.total} done`;
    return;
  }
  built = structure;
  // Kept across the rebuild: where the owner was, and what they were typing in.
  const keep = view.scrollTop;
  const active = document.activeElement?.closest?.('.round-card');
  const focusId = active?.dataset.q;
  const focusSel = document.activeElement?.selectionStart;
  view.innerHTML = '';
  const page = el('div', 'round-page');
  page.append(heading(info, model));
  const start = startButton(info);
  if (start) page.append(start);
  const brief = info?.on !== false && info?.current?.brief;
  if (brief) page.append(el('p', 'round-brief', brief));
  if (!model.sections.length) {
    const next = info?.next?.at ? ` Next briefing ${roundTime(info.next.at)}.` : '';
    page.append(el('p', 'round-empty', info?.current ? `Nothing for you this briefing.${next}`
      : `Billion's questions come in briefings, twice a day.${next} Until then they show here as soon as Billion asks.`));
  }
  for (const s of model.sections) {
    const section = el('section', `round-dept${s.urgent ? ' urgent' : ''}`);
    section.dataset.key = s.key;
    const h = el('h3', 'round-dept-title', s.title);
    section.append(h);
    for (const q of s.items) section.append(card(q));
    page.append(section);
  }
  if (model.earlier.length) {
    const toggle = el('button', 'round-earlier-toggle chat-link', `${earlierOpen ? 'Hide' : 'Earlier'} (${model.earlier.length})`);
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(earlierOpen));
    toggle.setAttribute('aria-controls', 'round-earlier');
    toggle.onclick = () => { earlierOpen = !earlierOpen; renderRound(); };
    const list = el('div', 'round-earlier');
    list.id = 'round-earlier';
    list.hidden = !earlierOpen;
    if (earlierOpen) for (const q of model.earlier) list.append(earlierRow(q));
    page.append(toggle, list);
  }
  view.append(page);
  view.scrollTop = keep;
  if (focusId) {
    const box = view.querySelector(`.round-card[data-q="${CSS.escape(focusId)}"] .round-reply-input`);
    if (box) {
      box.focus({ preventScroll: true });
      if (typeof focusSel === 'number') box.setSelectionRange?.(focusSel, focusSel);
    }
  }
}

// Tests only: a fresh page.
export function _resetRound() {
  pending.clear();
  errors.clear();
  drafts.clear();
  earlierOpen = false;
  starting = null;
  built = '';
}
