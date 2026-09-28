// @vitest-environment happy-dom
// The "Billion" tab (public/modules/waiting.js): the bell's badge, the chat
// thread with question bubbles whose choices collapse on answer, the text box
// and which question it answers, and the pinned strip of open questions.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { agents, setActiveSession, setBoardActive, setWaitingItems, setWaitingActive, setChatMessages, upsertChatMessage } from '../public/modules/state.js';
import { updateTabs } from '../public/modules/terminal.js';
import { showWaiting, renderWaiting, handleWaitingError, handleChatSent, leaveWaiting, answerTarget } from '../public/modules/waiting.js';

const open = (n, extra = {}) => ({ id: `w${n}`, n, text: `Question ${n}?`, at: new Date().toISOString(), status: 'open', ...extra });
const bubbleOf = (qid) => document.querySelector(`.chat-msg[data-q="${qid}"]`);
// A question's bubble in the thread, carrying the same state as its item.
const qMsg = (item) => ({
  id: `m-${item.id}`, at: item.at, from: 'billion', text: item.text,
  q: { id: item.id, n: item.n, urgency: item.urgency || 'normal', status: item.status, choices: item.choices, recommended: item.recommended, answer: item.answer, answeredVia: item.answeredVia, answeredAt: item.answeredAt },
});
const questions = (...items) => { setWaitingItems(items); setChatMessages(items.map(qMsg)); renderWaiting(); };
const input = () => document.getElementById('chat-input');
const type = (text, opts = {}) => {
  input().value = text;
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...opts }));
};

const hideWaitingState = () => document.body.classList.remove('billion-chat');

beforeEach(() => {
  document.body.innerHTML = '<div id="terminal-tabs"></div><div id="terminal-empty"></div><div id="job-board"></div>'
    + '<div id="waiting-board" style="display:none"><div id="waiting-list"></div></div>'
    + '<nav class="mobile-nav"><button data-view="terminal"></button><button data-view="waiting"><span id="mobile-nav-waiting-count" hidden></span></button></nav>';
  agents.clear();
  setActiveSession(null);
  setBoardActive(false);
  setWaitingActive(false);
  setWaitingItems([]);
  setChatMessages([]);
  hideWaitingState();
  vi.clearAllMocks();
});

describe('the Billion tab', () => {
  it('sits next to Jobs as a bell and "Billion", badged with open questions only, here and in the phone bar', () => {
    setWaitingItems([open(1), open(2), { ...open(3), status: 'answered', answer: 'yes' }]);
    updateTabs();
    const tabs = [...document.querySelectorAll('.terminal-tab')];
    expect(tabs.map(t => t.textContent.replace(/\d/g, ''))).toEqual(['Jobs', 'Billion']);
    const tab = tabs[1];
    expect(tab.querySelector('.bell svg')).not.toBeNull();
    expect(tab.querySelector('.bell .board-tab-badge').textContent).toBe('2');
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

  it('sends a plain message with questions open; only Reply makes it an answer, and × leaves it', () => {
    questions(open(1), open(2, { urgency: 'blocking', choices: ['yes', 'no'] }));
    expect(answerTarget()).toBeNull();
    expect(document.getElementById('chat-target').hidden).toBe(true);
    expect(input().placeholder).toBe('Billion is not running; start it to send');
    type('not about Q2');
    expect(send).toHaveBeenLastCalledWith({ type: 'chat-send', nonce: expect.any(String), text: 'not about Q2' });
    handleChatSent({ nonce: send.mock.calls.at(-1)[0].nonce });

    // Reply sits beside the choices, and alone on a question without them.
    expect([...bubbleOf('w1').querySelector('.chat-q-foot').children].map(c => c.textContent)).toEqual(['Reply', 'Dismiss']);
    bubbleOf('w2').querySelector('.chat-reply').click();
    expect(answerTarget().id).toBe('w2');
    expect(document.getElementById('chat-target').textContent).toMatch(/^Answers Q2: /);
    type('go ahead');
    expect(send).toHaveBeenLastCalledWith({ type: 'chat-send', nonce: expect.any(String), text: 'go ahead', answers: 'w2' });
    handleChatSent({ nonce: send.mock.calls.at(-1)[0].nonce });

    bubbleOf('w1').querySelector('.chat-reply').click();
    expect(answerTarget().id).toBe('w1');
    document.querySelector('.chat-target-x').click();
    expect(document.getElementById('chat-target').hidden).toBe(true);
    type('just chatting');
    expect(send).toHaveBeenLastCalledWith({ type: 'chat-send', nonce: expect.any(String), text: 'just chatting' });
  });

  it('drops the Reply once its question is answered elsewhere', () => {
    questions(open(1));
    bubbleOf('w1').querySelector('.chat-reply').click();
    questions({ ...open(1), status: 'answered', answer: 'yes', answeredVia: 'telegram', answeredAt: new Date().toISOString() });
    expect(answerTarget()).toBeNull();
    expect(document.getElementById('chat-target').hidden).toBe(true);
  });
});

describe('Undo', () => {
  beforeEach(() => showWaiting());
  const answered = (n, msAgo, via = 'app') => ({ ...open(n), status: 'answered', answer: 'yes', answeredVia: via, answeredAt: new Date(Date.now() - msAgo).toISOString() });

  it('shows for a minute after answering and reopens the question', () => {
    questions(answered(1, 10e3), answered(2, 61e3), answered(3, 5e3, 'terminal'));
    expect(bubbleOf('w2').querySelector('.chat-undo')).toBeNull();
    expect(bubbleOf('w3').querySelector('.chat-undo')).toBeNull();
    bubbleOf('w1').querySelector('.chat-undo').click();
    expect(send).toHaveBeenLastCalledWith({ type: 'waiting-reopen', id: 'w1' });
    expect(bubbleOf('w1').querySelector('.chat-undo').disabled).toBe(true);
    handleWaitingError({ id: 'w1', error: 'Billion is not running' });
    expect(bubbleOf('w1').querySelector('.waiting-error').textContent).toBe('Billion is not running');
    expect(bubbleOf('w1').querySelector('.chat-undo').disabled).toBe(false);
    // Reopened by the server: open again, with its Reply.
    questions(open(1));
    expect(bubbleOf('w1').querySelector('.waiting-error')).toBeNull();
    expect(bubbleOf('w1').querySelector('.chat-reply')).not.toBeNull();
  });

  it('goes when its minute is up', () => {
    vi.useFakeTimers();
    try {
      questions(answered(1, 0));
      expect(bubbleOf('w1').querySelector('.chat-undo')).not.toBeNull();
      vi.advanceTimersByTime(61e3);
      expect(bubbleOf('w1').querySelector('.chat-undo')).toBeNull();
    } finally { vi.useRealTimers(); }
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

  it('scrolls the thread to the question tapped and arms the box for it', () => {
    questions(open(1), open(2));
    const target = bubbleOf('w2');
    target.scrollIntoView = vi.fn();
    document.querySelectorAll('.chat-strip-item')[1].click();
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(target.classList.contains('flash')).toBe(true);
    // And the box answers it.
    expect(answerTarget().id).toBe('w2');
    expect(document.getElementById('chat-target').textContent).toMatch(/^Answers Q2: /);
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
