// @vitest-environment happy-dom
// The "Billion" tab (public/modules/waiting.js): the chat bubble's badge, the chat
// thread with question bubbles whose choices collapse on answer, the text box
// and which question it answers, and the pinned strip of open questions.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { agents, setActiveSession, setBoardActive, setWaitingItems, setWaitingActive, setChatMessages, upsertChatMessage, setBillionTabOpen, activeSessionId, waitingActive } from '../public/modules/state.js';
import { updateTabs, switchToSession, removeSession } from '../public/modules/terminal.js';
import { readFileSync } from 'node:fs';
import { showWaiting, renderWaiting, handleWaitingError, handleChatSent, leaveWaiting, answerTarget } from '../public/modules/waiting.js';

const open = (n, extra = {}) => ({ id: `w${n}`, n, text: `Question ${n}?`, at: new Date().toISOString(), status: 'open', ...extra });
const bubbleOf = (qid) => document.querySelector(`.chat-msg[data-q="${qid}"]`);
// A question's bubble in the thread, carrying the same state as its item.
const qMsg = (item) => ({
  id: `m-${item.id}`, at: item.at, from: 'billion', text: item.text,
  q: { id: item.id, n: item.n, urgency: item.urgency || 'normal', status: item.status, choices: item.choices, recommended: item.recommended, answer: item.answer, answeredVia: item.answeredVia },
});
const questions = (...items) => { setWaitingItems(items); setChatMessages(items.map(qMsg)); renderWaiting(); };
const input = () => document.getElementById('chat-input');
const type = (text, opts = {}) => {
  input().value = text;
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...opts }));
};

const CHAT_BUBBLE_PATH = 'M2 2h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5.5L3 11V9H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z';
const hideWaitingState = () => document.body.classList.remove('billion-chat');

beforeEach(() => {
  document.body.innerHTML = '<div id="terminal-tabs"></div><div id="terminal-empty"></div><div id="job-board"></div>'
    + '<div id="waiting-board" style="display:none"><div id="waiting-list"></div></div>'
    + '<nav class="mobile-nav"><button data-view="terminal"></button><button data-view="waiting"><span id="mobile-nav-waiting-count" hidden></span></button></nav>';
  agents.clear();
  setActiveSession(null);
  setBoardActive(false);
  setWaitingActive(false);
  setBillionTabOpen(false);
  setWaitingItems([]);
  setChatMessages([]);
  hideWaitingState();
  vi.clearAllMocks();
});

describe('the Billion tab', () => {
  it('sits next to Jobs as a chat bubble and "Billion", badged with open questions only, here and in the phone bar', () => {
    setWaitingItems([open(1), open(2), { ...open(3), status: 'answered', answer: 'yes' }]);
    updateTabs();
    const tabs = [...document.querySelectorAll('.terminal-tab')];
    expect(tabs.map(t => t.textContent.replace(/\d/g, ''))).toEqual(['Jobs', 'Billion']);
    const tab = tabs[1];
    expect(tab.querySelector('.chat-icon svg path').getAttribute('d')).toBe(CHAT_BUBBLE_PATH);
    expect(tab.querySelector('.chat-icon .board-tab-badge').textContent).toBe('2');
    expect(tab.getAttribute('aria-label')).toBe('Talk to Billion, 2 open questions');
    expect(tab.title).toBe('Talk to Billion');
    const nav = document.getElementById('mobile-nav-waiting-count');
    const navBtn = document.querySelector('.mobile-nav [data-view="waiting"]');
    expect([nav.textContent, nav.hidden, navBtn.getAttribute('aria-label')]).toEqual(['2', false, 'Talk to Billion, 2 open questions']);

    setWaitingItems([open(1)]);
    updateTabs();
    expect(document.querySelector('.waiting-tab').getAttribute('aria-label')).toBe('Talk to Billion, 1 open question');

    setWaitingItems(Array.from({ length: 10 }, (_, i) => open(i + 1)));
    updateTabs();
    expect(document.querySelector('.waiting-tab .board-tab-badge').textContent).toBe('9+');
    expect(document.querySelector('.waiting-tab').getAttribute('aria-label')).toBe('Talk to Billion, 10 open questions');
    expect(nav.textContent).toBe('9+');

    setWaitingItems([]);
    updateTabs();
    expect(document.querySelector('.waiting-tab .board-tab-badge').hidden).toBe(true);
    expect(document.querySelector('.waiting-tab').classList.contains('empty')).toBe(true);
    expect(document.querySelector('.waiting-tab').getAttribute('aria-label')).toBe('Talk to Billion');
    expect([nav.hidden, navBtn.getAttribute('aria-label'), navBtn.title]).toEqual([true, 'Talk to Billion', 'Talk to Billion']);
  });

  it('opens on an empty thread with the text box, and lights the phone button', () => {
    document.body.dataset.view = 'terminal';
    showWaiting();
    expect(document.getElementById('waiting-board').style.display).toBe('flex');
    expect(document.getElementById('job-board').style.display).toBe('none');
    expect(document.getElementById('waiting-list').textContent).toBe('Nothing here yet. Say something to Billion.');
    expect(input()).not.toBeNull();
    expect(document.getElementById('chat-strip').hidden).toBe(true);
    expect(document.querySelector('.mobile-nav [data-view="waiting"]').getAttribute('aria-current')).toBe('true');
    // The phone's Terminal button leaves it.
    leaveWaiting();
    expect(document.getElementById('waiting-board').style.display).toBe('none');
    expect(document.getElementById('terminal-empty').style.display).toBe('flex');
    expect(document.querySelector('.mobile-nav [data-view="terminal"]').getAttribute('aria-current')).toBe('true');
  });
});

describe("the chat tab and Billion's terminal tab", () => {
  // Enough of an agent for the tab strip and switchToSession.
  const fakeAgent = (name, extra = {}) => {
    const termEl = document.createElement('div');
    termEl.style.display = 'none';
    return { name, state: 'IDLE', termEl, term: { dispose: vi.fn(), focus() {}, scrollToBottom() {} }, ...extra };
  };
  const tabNames = () => [...document.querySelectorAll('.terminal-tab')].map(t => t.textContent.replace(/[\d\u00d7]/g, ''));

  it('is where the page opens: init shows the chat before the replay arrives', () => {
    const app = readFileSync('public/app.js', 'utf8');
    const init = app.slice(app.indexOf('async function init()'));
    expect(init.indexOf('showWaiting();')).toBeGreaterThan(-1);
    expect(init.indexOf('showWaiting();')).toBeLessThan(init.indexOf('connect(onMessage)'));
    // and a reload with the chat last open comes back to it
    localStorage.setItem('agent007-active-tab', 's1');
    showWaiting();
    expect(localStorage.getItem('agent007-active-tab')).toBeNull();
  });

  it('has no close control, and orders Jobs, Billion chat, then agents with Billion first when open', () => {
    agents.set('w1', fakeAgent('viper'));
    agents.set('b1', fakeAgent('Billion', { isBillion: true }));
    showWaiting();
    updateTabs();
    expect(tabNames()).toEqual(['Jobs', 'Billion', 'viper']);
    expect(document.querySelector('.waiting-tab').classList.contains('active')).toBe(true);
    expect(document.querySelector('.waiting-tab .close-btn')).toBeNull();

    // What the office click on Billion (and its explorer row) calls.
    switchToSession('b1');
    expect(tabNames()).toEqual(['Jobs', 'Billion', 'Billion', 'viper']);
    const billionTab = document.querySelector('.terminal-tab[data-session-id="b1"]');
    expect(billionTab.classList.contains('active')).toBe(true);
    expect(document.querySelector('.waiting-tab .close-btn')).toBeNull();
    // Back on the chat, only the chat tab is lit.
    showWaiting();
    updateTabs();
    expect(document.querySelectorAll('.terminal-tab.active').length).toBe(1);
    switchToSession('b1');

    // Its close hides the tab and goes back to the chat; the session stays.
    billionTab.querySelector('.close-btn').click();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kill' }));
    expect(agents.has('b1')).toBe(true);
    expect(tabNames()).toEqual(['Jobs', 'Billion', 'viper']);
    expect([activeSessionId, waitingActive]).toEqual([null, true]);
    expect(agents.get('b1').termEl.style.display).toBe('none');
  });

  it("closing Billion's tab under the job board leaves the board up", () => {
    agents.set('b1', fakeAgent('Billion', { isBillion: true }));
    switchToSession('b1');
    setBoardActive(true);
    document.querySelector('.terminal-tab[data-session-id="b1"] .close-btn').click();
    expect([activeSessionId, waitingActive, agents.has('b1')]).toEqual([null, false, true]);
    expect(tabNames()).toEqual(['Jobs', 'Billion']);
  });

  it("lands on the chat, not a hidden Billion, when the last shown terminal closes", () => {
    agents.set('b1', fakeAgent('Billion', { isBillion: true }));
    agents.set('w1', fakeAgent('viper', { state: 'DISCONNECTED' }));
    document.body.insertAdjacentHTML('beforeend', '<div id="status-bar"></div><div id="office-empty"></div>');
    switchToSession('w1');
    removeSession('w1');
    expect([activeSessionId, waitingActive]).toEqual([null, true]);
    expect(tabNames()).toEqual(['Jobs', 'Billion']);
  });
});

describe('the thread', () => {
  beforeEach(() => showWaiting());

  it('puts the owner on the right and Billion on the left, in time order, text never as HTML, voice marked', () => {
    setChatMessages([
      { id: 'a', at: new Date().toISOString(), from: 'owner', via: 'app', text: '<b>hi</b>' },
      { id: 'b', at: new Date().toISOString(), from: 'billion', text: 'Hello.' },
      { id: 'c', at: new Date().toISOString(), from: 'owner', via: 'telegram', voice: true, text: 'from the phone' },
    ]);
    renderWaiting();
    const rows = [...document.querySelectorAll('.chat-msg')];
    expect(rows.map(r => [r.classList.contains('mine'), r.querySelector('.chat-text').textContent])).toEqual([
      [true, '<b>hi</b>'], [false, 'Hello.'], [true, 'from the phone'],
    ]);
    expect(document.querySelector('.chat-text b')).toBeNull();
    expect(rows[2].querySelector('.chat-meta').textContent).toMatch(/^\(voice\) · Telegram · /);
    // A broadcast adds to the end.
    upsertChatMessage({ id: 'd', at: new Date().toISOString(), from: 'billion', text: 'Got it.' });
    renderWaiting();
    expect(document.querySelector('.chat-msg:last-child .chat-text').textContent).toBe('Got it.');
  });

  it('shows a question with its choices, recommended first, and a tap answers it', () => {
    questions(open(1, { text: 'Buy?', choices: ['no', 'yes'], recommended: 'yes' }));
    const b = bubbleOf('w1');
    expect(b.querySelector('.waiting-card-n').textContent).toBe('Q1');
    const choices = [...b.querySelectorAll('.waiting-choice')];
    expect(choices.map(c => c.textContent)).toEqual(['yesrecommended', 'no']);
    choices[1].click();
    expect(send).toHaveBeenCalledWith({ type: 'waiting-answer', id: 'w1', answer: 'no' });
    // Held until the server answers: no double send.
    bubbleOf('w1').querySelector('.waiting-choice').click();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('collapses the buttons to "you answered" once answered, and keeps it as history', () => {
    questions({ ...open(1, { choices: ['yes', 'no'] }), status: 'answered', answer: 'yes', answeredVia: 'app' },
      { ...open(2), status: 'answered', answer: 'later', answeredVia: 'telegram' });
    expect(bubbleOf('w1').querySelector('.waiting-choice')).toBeNull();
    expect(bubbleOf('w1').querySelector('.chat-answered').textContent).toBe('you answered: yes');
    expect(bubbleOf('w2').querySelector('.chat-answered').textContent).toBe('you answered: later (on Telegram)');
  });

  it('shows a refused tap on the question, which stays open, and dismisses with Dismiss', () => {
    questions(open(5, { choices: ['yes', 'no'] }));
    send.mockReturnValueOnce(false);
    bubbleOf('w5').querySelector('.waiting-choice').click();
    expect(bubbleOf('w5').querySelector('.waiting-error').textContent).toMatch(/Not connected/);
    expect(bubbleOf('w5').querySelector('.waiting-choice').disabled).toBe(false);
    bubbleOf('w5').querySelector('.waiting-choice').click();
    handleWaitingError({ id: 'w5', error: 'Billion is not running' });
    expect(bubbleOf('w5').querySelector('.waiting-error').textContent).toBe('Billion is not running');
    bubbleOf('w5').querySelector('.waiting-dismiss').click();
    expect(send).toHaveBeenLastCalledWith({ type: 'waiting-dismiss', id: 'w5' });
  });
});

describe('the text box', () => {
  beforeEach(() => showWaiting());

  it('sends on Enter, not on Shift+Enter, and empties only once the server took it', () => {
    type('hello', { shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    type('  hello Billion ');
    expect(send).toHaveBeenCalledWith({ type: 'chat-send', nonce: expect.any(String), text: 'hello Billion' });
    const { nonce } = send.mock.calls[0][0];
    expect(input().value).toBe('  hello Billion ');
    expect(document.getElementById('chat-send').disabled).toBe(true);
    handleChatSent({ nonce });
    expect(input().value).toBe('');
    expect(document.getElementById('chat-send').disabled).toBe(false);
  });

  it('keeps the text and says why when refused, and says when Billion is not running', () => {
    expect(input().placeholder).toBe('Billion is not running; start it to send');
    type('are you there?');
    handleChatSent({ nonce: send.mock.calls[0][0].nonce, error: 'Billion is not running; start it, then send again.' });
    expect(input().value).toBe('are you there?');
    expect(document.getElementById('chat-error').textContent).toBe('Billion is not running; start it, then send again.');
    agents.set('b', { isBillion: true });
    renderWaiting();
    expect(input().placeholder).toBe('Message Billion');
    agents.delete('b');
  });

  it('answers the oldest open blocking question, else the oldest open one, and × sends a plain message instead', () => {
    const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    questions(open(1, { at: at(9) }), open(2, { urgency: 'blocking', at: at(2) }), open(3, { urgency: 'blocking', at: at(5) }),
      { ...open(4, { at: at(20) }), status: 'answered', answer: 'x' });
    expect(answerTarget().id).toBe('w3');
    expect(document.getElementById('chat-target').textContent).toMatch(/^Answers Q3: /);
    type('go ahead');
    expect(send).toHaveBeenLastCalledWith({ type: 'chat-send', nonce: expect.any(String), text: 'go ahead', answers: 'w3' });
    handleChatSent({ nonce: send.mock.calls.at(-1)[0].nonce });

    questions(open(1, { at: at(9) }), open(7, { at: at(3) }));
    expect(answerTarget().id).toBe('w1');
    document.querySelector('.chat-target-x').click();
    expect(document.getElementById('chat-target').hidden).toBe(true);
    type('just chatting');
    expect(send).toHaveBeenLastCalledWith({ type: 'chat-send', nonce: expect.any(String), text: 'just chatting' });
  });
});

describe('the pinned strip', () => {
  beforeEach(() => showWaiting());
  const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();

  it('lists open questions blocking, then normal, then low, oldest first within each, and hides when none are open', () => {
    questions(
      open(1, { urgency: 'low', at: at(9) }),
      open(2, { at: at(8) }),                         // saved before urgency: normal
      open(3, { urgency: 'blocking', at: at(1) }),
      open(4, { urgency: 'normal', at: at(10) }),
      open(5, { urgency: 'blocking', at: at(5) }),
      open(6, { urgency: 'low', at: at(20) }),
      { ...open(7), status: 'answered', answer: 'a' },
    );
    const strip = document.getElementById('chat-strip');
    expect(strip.hidden).toBe(false);
    expect([...strip.querySelectorAll('.waiting-card-n')].map(n => n.textContent)).toEqual(['! Q5', '! Q3', 'Q4', 'Q2', 'Q6', 'Q1']);
    questions({ ...open(7), status: 'answered', answer: 'a' });
    expect(strip.hidden).toBe(true);
    expect(strip.children.length).toBe(0);
  });

  it('scrolls the thread to the question tapped', () => {
    questions(open(1), open(2));
    const target = bubbleOf('w2');
    target.scrollIntoView = vi.fn();
    document.querySelectorAll('.chat-strip-item')[1].click();
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(target.classList.contains('flash')).toBe(true);
  });

  it('marks blocking with a bold "!", leaves normal plain, and dims low', () => {
    questions(open(1, { urgency: 'blocking' }), open(2, { urgency: 'normal' }), open(3, { urgency: 'low' }));
    const n = (id) => bubbleOf(id).querySelector('.waiting-card-n');
    expect(n('w1').textContent).toBe('! Q1');
    expect(n('w1').querySelector('b.waiting-urgent').textContent).toBe('!');
    expect(n('w1').title).toBe('blocking: a worker or merge is waiting');
    expect([n('w2').textContent, n('w2').title, n('w2').className]).toEqual(['Q2', '', 'waiting-card-n']);
    expect([n('w3').textContent, n('w3').title, n('w3').classList.contains('low')]).toEqual(['Q3', 'optional', true]);
  });
});
