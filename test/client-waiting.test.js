// @vitest-environment happy-dom
// The "Billion" tab (public/modules/waiting.js): the chat bubble's badge, the chat
// thread with question bubbles whose choices collapse on answer, the text box
// and which question it answers, and the pinned strip of open questions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { agents, setActiveSession, setBoardActive, setWaitingItems, setWaitingActive, setChatMessages, upsertChatMessage, setBillionTabOpen, activeSessionId, waitingActive, setBillionEnabled, setView } from '../public/modules/state.js';
import { updateTabs, switchToSession, removeSession, setupUpload } from '../public/modules/terminal.js';
import { readFileSync } from 'node:fs';
import { showWaiting, renderWaiting, handleWaitingError, handleChatSent, handleChatMessage, leaveWaiting, answerTarget, replyToQuestion, setBillionNotice, _resetComposer, questionGroups, setQuestionsOpen, setTelegramState, setGroupBy, _reloadQuestionPrefs } from '../public/modules/waiting.js';
import { voiceTarget, stopVoice, setupVoice } from '../public/modules/voice.js';
import { _resetReadAloud, speakingMessage, stopReading } from '../public/modules/readaloud.js';

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

  it("the phone's Terminal button opens the first agent when none is selected, never Billion's hidden tab", () => {
    const agent = (extra) => ({ state: 'IDLE', termEl: document.createElement('div'), term: { dispose() {}, focus() {}, scrollToBottom() {} }, ...extra });
    agents.set('b1', agent({ name: 'Billion', isBillion: true }));
    agents.set('w1', agent({ name: 'viper' }));
    agents.set('w2', agent({ name: 'cobra' }));
    showWaiting();
    leaveWaiting();
    expect(activeSessionId).toBe('w1');
    expect(agents.get('w1').termEl.style.display).toBe('block');
    expect(document.getElementById('terminal-empty').style.display).toBe('none');
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

  it('is where a phone opens too, lit as Billion in the bottom bar', () => {
    const app = readFileSync('public/app.js', 'utf8');
    expect(app.slice(app.indexOf('async function init()'))).toMatch(/showWaiting\(\);\s*setView\('terminal'\);/);
    document.body.dataset.view = 'office';
    showWaiting();
    setView('terminal');
    expect(document.body.dataset.view).toBe('terminal');
    expect(document.querySelector('.mobile-nav [data-view="waiting"]').getAttribute('aria-current')).toBe('true');
  });

  it('+ Agent starts on the only repo there is, rather than the home folder', () => {
    const app = readFileSync('public/app.js', 'utf8');
    expect(app).toContain("if (!repoInput.value.trim() && repos.size === 1) repoInput.value = [...repos.keys()][0];");
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

  it('has the phone button between the mic and Send, and the call bar beside the row', () => {
    const row = document.getElementById('chat-compose-row');
    const ids = [...row.children].map(c => c.id);
    expect(ids.slice(-3)).toEqual(['chat-mic', 'chat-talk', 'chat-send']);
    expect(document.getElementById('talk-bar').nextElementSibling).toBe(row);
    expect(document.querySelector('.talk-bar:not(#chat-compose *)')).not.toBeNull();
  });

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
    expect(input().placeholder).toBe('Start Billion to send');
    type('are you there?');
    handleChatSent({ nonce: send.mock.calls[0][0].nonce, error: 'Billion is not running; start it, then send again.' });
    expect(input().value).toBe('are you there?');
    expect(document.getElementById('chat-error').textContent).toBe('Billion is not running; start it, then send again.');
    agents.set('b', { isBillion: true });
    renderWaiting();
    expect(input().placeholder).toBe('Message Billion, or /command to run one');
    // A phone's box is too narrow for the /command hint.
    const matchMedia = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q === '(max-width: 700px)' });
    renderWaiting();
    expect(input().placeholder).toBe('Message Billion');
    window.matchMedia = matchMedia;
    agents.delete('b');
  });

  it('counts a stopped Billion as not running', () => {
    agents.set('b', { isBillion: true, state: 'DISCONNECTED' });
    renderWaiting();
    expect(input().placeholder).toBe('Start Billion to send');
    agents.delete('b');
  });

  it('says above the box why Billion cannot talk, with the button past it', () => {
    const bar = () => document.getElementById('chat-notice');
    setBillionEnabled(true);
    renderWaiting();
    // Never started: Start.
    expect(bar().hidden).toBe(false);
    expect(bar().textContent).toBe('Billion is not running.Start Billion');
    bar().querySelector('button').click();
    expect(send).toHaveBeenLastCalledWith({ type: 'billion-start' });
    // Its CLI missing: the reason, and still Start.
    agents.set('b', { isBillion: true, state: 'DISCONNECTED' });
    setBillionNotice('b', 'Billion runs on Claude Code, which is not installed.');
    expect(bar().textContent).toBe('Billion runs on Claude Code, which is not installed.Start Billion');
    // Running but logged out: its terminal, where the sign-in is.
    agents.set('b', { isBillion: true, state: 'IDLE', termEl: document.createElement('div'), term: { scrollToBottom() {}, focus() {} } });
    setBillionNotice('b', 'Claude Code says it is not logged in.');
    expect(bar().querySelector('button').textContent).toBe("Open Billion's terminal");
    bar().querySelector('button').click();
    expect(activeSessionId).toBe('b');
    expect(document.body.dataset.view).toBe('terminal');
    // Ready: gone.
    showWaiting();
    setBillionNotice('b', null);
    expect(bar().hidden).toBe(true);
    agents.delete('b');
    setBillionEnabled(false);
  });

  it('hides the empty thread line while a notice says Billion cannot hear', () => {
    const empty = () => document.querySelector('#waiting-list .waiting-empty');
    agents.set('b', { isBillion: true, state: 'IDLE' });
    renderWaiting();
    expect(empty().hidden).toBe(false);
    setBillionNotice('b', 'Claude Code says it is not logged in.');
    expect(empty().hidden).toBe(true);
    renderWaiting();
    expect(empty().hidden).toBe(true);
    setBillionNotice('b', null);
    expect(empty().hidden).toBe(false);
    agents.delete('b');
  });

  it('sends a plain message with questions open; only Reply makes it an answer, and × leaves it', () => {
    questions(open(1), open(2, { urgency: 'blocking', choices: ['yes', 'no'] }));
    expect(answerTarget()).toBeNull();
    expect(document.getElementById('chat-target').hidden).toBe(true);
    expect(input().placeholder).toBe('Start Billion to send');
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
    handleChatSent({ nonce: send.mock.calls.at(-1)[0].nonce });
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

describe('the open questions chip', () => {
  beforeEach(() => { setQuestionsOpen(false, { focus: false }); localStorage.clear(); showWaiting(); });

  it('counts the open questions, "!" when one is blocking, and hides when none are open', () => {
    questions(open(1, { urgency: 'low' }), open(2), { ...open(3), status: 'answered', answer: 'a' });
    const strip = document.getElementById('chat-strip');
    expect([strip.hidden, strip.textContent, strip.classList.contains('blocking')]).toEqual([false, '2open questions', false]);
    expect(strip.querySelector('.chat-wide').textContent).toBe(' questions');   // a phone shows "2 open"
    questions(open(1), open(2, { urgency: 'blocking' }));
    expect([strip.textContent, strip.classList.contains('blocking')]).toEqual(['!2open questions', true]);
    expect(strip.getAttribute('aria-label')).toBe('2 open questions, blocking: show them by project');
    questions(open(1));
    expect(strip.textContent).toBe('1open question');
    questions({ ...open(7), status: 'answered', answer: 'a' });
    expect(strip.hidden).toBe(true);
    expect(strip.children.length).toBe(0);
  });

  it('is a button in the bar that opens and closes the panel, saying which', () => {
    document.body.innerHTML = '<div id="terminal-empty"></div><div id="job-board"></div><div id="waiting-board" style="display:none"><div id="billion-bar"><div id="billion-subtabs"></div><div id="billion-status"></div></div><div id="waiting-list"></div></div>';
    _resetComposer();
    showWaiting();
    questions(open(1), open(2), open(3));
    const strip = document.getElementById('chat-strip');
    expect(strip.closest('#billion-bar')).not.toBeNull();
    expect([strip.tagName, strip.type, strip.getAttribute('aria-controls'), strip.getAttribute('aria-expanded')]).toEqual(['BUTTON', 'button', 'chat-questions', 'false']);
    expect(strip.getAttribute('aria-label')).toBe('3 open questions: show them by project');
    strip.click();
    expect(document.getElementById('chat-questions').hidden).toBe(false);
    expect([strip.getAttribute('aria-expanded'), strip.getAttribute('aria-label')]).toEqual(['true', '3 open questions: hide them by project']);
    strip.click();
    expect(document.getElementById('chat-questions').hidden).toBe(true);
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

describe('read aloud and dictation in the tab', () => {
  let spoken;
  let recs;
  const flush = () => new Promise(r => setTimeout(r, 0));
  const result = (transcript, isFinal) => ({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] });

  beforeEach(() => {
    spoken = [];
    recs = [];
    localStorage.clear();
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.speechSynthesis = { speak: vi.fn(u => spoken.push(u)), cancel: vi.fn(), resume: vi.fn(), getVoices: () => [] };
    window.SpeechRecognition = class { start() { recs.push(this); } abort() {} stop() {} };
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) }, configurable: true });
    _resetReadAloud();
    // The composer is built on the first render; rebuild it with the stubs in place.
    document.body.innerHTML += '<span id="voice-status"></span>';
    showWaiting();
  });

  const billion = (id, text) => ({ id, at: new Date().toISOString(), from: 'billion', text });

  it('puts a speaker on Billion\'s messages only, which reads it and turns into Stop', () => {
    setChatMessages([billion('m1', 'Merged **PR 3**: https://x.y/3'), { id: 'm2', at: new Date().toISOString(), from: 'owner', via: 'app', text: 'ok' }]);
    renderWaiting();
    const speakers = document.querySelectorAll('.chat-speak');
    expect(speakers.length).toBe(1);
    const btn = speakers[0];
    expect([btn.getAttribute('aria-label'), btn.getAttribute('aria-pressed')]).toEqual(['Read aloud', 'false']);
    btn.click();
    expect(spoken.map(u => u.text)).toEqual(['Merged PR 3: link.']);
    expect([btn.getAttribute('aria-label'), btn.getAttribute('aria-pressed'), btn.classList.contains('speaking')]).toEqual(['Stop reading', 'true', true]);
    btn.click();
    expect(speakingMessage()).toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Read aloud');
  });

  it('reads a question with its choices', () => {
    questions(open(51, { choices: ['Not yet', 'Done'], recommended: 'Done', text: 'Is Q50 done?' }));
    bubbleOf('w51').querySelector('.chat-speak').click();
    expect(spoken[0].text).toBe('Question 51. Is question 50 done? Choices: Not yet, Done; recommended: Done.');
  });

  it('reads new Billion messages aloud only with the header toggle on, and remembers it', () => {
    const toggle = document.getElementById('chat-autoread');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    handleChatMessage(billion('m1', 'First.'));
    expect(spoken).toEqual([]);
    toggle.click();
    expect([toggle.getAttribute('aria-pressed'), localStorage.getItem('agent007-read-aloud')]).toEqual(['true', '1']);
    spoken.at(-1).onend();                          // the "Reading new messages aloud" confirmation
    handleChatMessage(billion('m2', 'Second.'));
    handleChatMessage({ id: 'm3', at: new Date().toISOString(), from: 'owner', via: 'app', text: 'mine' });
    handleChatMessage(billion('m2', 'Second, edited.'));   // not new
    expect(spoken.map(u => u.text)).toEqual(['Reading new messages aloud.', 'Second.']);
  });

  it('after a reload, shows Resume reading instead of failing silently', () => {
    localStorage.setItem('agent007-read-aloud', '1');
    renderWaiting();
    handleChatMessage(billion('m1', 'First.'));
    const resume = document.getElementById('chat-resume');
    expect([resume.hidden, resume.textContent]).toEqual([false, 'Resume reading (1 new)']);
    expect(spoken).toEqual([]);
    resume.click();
    expect(spoken.map(u => u.text)).toEqual(['First.']);
    expect(resume.hidden).toBe(true);
  });

  it('leaving the tab stops reading', () => {
    setChatMessages([billion('m1', 'Long.')]);
    renderWaiting();
    document.querySelector('.chat-speak').click();
    leaveWaiting();
    expect(speakingMessage()).toBeNull();
    stopReading();
  });

  it('the bar\'s speaker opens a menu with the switch and the voice, and shows when reading is on', () => {
    const menu = document.getElementById('chat-read-menu');
    const pop = document.getElementById('chat-read-pop');
    expect([menu.type, menu.getAttribute('popovertarget'), pop.hasAttribute('popover')]).toEqual(['button', 'chat-read-pop', true]);
    expect(pop.contains(document.getElementById('chat-autoread'))).toBe(true);
    expect(pop.contains(document.getElementById('chat-voice-pick'))).toBe(true);
    expect([menu.getAttribute('aria-label'), menu.classList.contains('on')]).toEqual(['Read aloud settings, off', false]);
    document.getElementById('chat-autoread').click();
    expect([menu.getAttribute('aria-label'), menu.classList.contains('on')]).toEqual(['Read aloud settings, on', true]);
  });

  it('the voice picker shows when there is a choice, "Auto" naming the voice it would pick', () => {
    const box = document.getElementById('chat-voice-box');
    renderWaiting();
    expect(box.hidden).toBe(true);
    const voices = ['Albert', 'Samantha'].map((name, i) => ({ name, lang: 'en-US', voiceURI: `v${i}`, localService: true }));
    window.speechSynthesis.getVoices = () => voices;
    renderWaiting();
    expect(box.hidden).toBe(false);
    const pick = document.getElementById('chat-voice-pick');
    expect(pick.selectedOptions[0].textContent).toMatch(/^Auto/);
    expect(box.tagName).toBe('LABEL');
    pick.value = 'v1';
    pick.onchange();
    expect(pick.selectedOptions[0].textContent).toBe('Samantha');
  });

  it('the box and the voice picker are not login fields to a password manager', () => {
    for (const id of ['chat-input', 'chat-voice-pick']) {
      expect(document.getElementById(id).getAttribute('autocomplete'), id).toBe('off');
    }
  });

  it('the box, mic and Send, and the read-aloud menu share one control height token, the bar\'s controls another', () => {
    for (const id of ['chat-input', 'chat-mic', 'chat-send', 'chat-autoread', 'chat-voice-pick']) {
      expect(document.getElementById(id).classList.contains('chat-control'), id).toBe(true);
    }
    for (const id of ['chat-strip', 'chat-resume', 'chat-stop-reading', 'chat-read-menu']) {
      expect(document.getElementById(id).classList.contains('billion-bar-control'), id).toBe(true);
    }
    const css = readFileSync('public/style.css', 'utf8');
    expect(css).toMatch(/\.chat-control \{ min-height: var\(--chat-control-h\); \}/);
    expect(css).toMatch(/\.billion-bar-control \{ min-height: var\(--bar-control-h\); \}/);
    expect(css).toMatch(/\.chat-mic \{[^}]*width: var\(--chat-control-h\);/);
    // No rule anywhere, media queries included, gives one of them its own
    // height to drift from the token.
    const controls = /(#chat-input|\.chat-mic|\.waiting-send|\.chat-autoread|\.chat-resume|\.chat-stop-reading|\.chat-voice-pick|\.chat-strip|\.chat-read-menu)(?![-\w])/;
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => controls.test(sel));
    expect(rules.length).toBeGreaterThan(5);
    for (const [, sel, body] of rules) expect(body, sel.trim()).not.toMatch(/(^|[\s;])(min-|max-)?height:/);
    expect(css).toMatch(/\.chat-compose-row \{[^}]*gap: var\(--chat-gap\);/);
    expect(css).toMatch(/\.chat-head \{[^}]*gap: var\(--chat-gap\);/);
  });

  it('the mic beside the box dictates into it: interim greyed, final appended, nothing sent', async () => {
    const mic = document.getElementById('chat-mic');
    expect(mic.getAttribute('aria-label')).toBe('Dictate a reply');
    input().value = 'Done';
    mic.click();
    await flush();
    expect(voiceTarget()).toBe('chat');
    expect([mic.getAttribute('aria-pressed'), mic.classList.contains('listening')]).toEqual(['true', true]);
    const live = document.getElementById('chat-voice');
    recs[0].onresult(result('and merge it', false));
    expect([live.style.display, live.textContent, input().value]).toEqual(['flex', 'and merge it', 'Done']);
    recs[0].onresult(result('and merge it', true));
    expect(input().value).toBe('Done and merge it ');
    expect(send).not.toHaveBeenCalled();
    mic.click();
    expect([voiceTarget(), mic.getAttribute('aria-pressed'), live.style.display]).toEqual([null, 'false', 'none']);
  });

  it('dictated text answers the question the box is set to, like typed text', async () => {
    questions(open(3));
    replyToQuestion('w3');
    document.getElementById('chat-mic').click();
    await flush();
    recs[0].onresult(result('not yet', true));
    stopVoice();
    type(input().value);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat-send', text: 'not yet', answers: 'w3' }));
  });

  it('the terminal\'s mic button is still wired up by setupVoice', () => {
    document.body.insertAdjacentHTML('beforeend', '<button id="btn-voice"></button>');
    setupVoice();
    expect(typeof document.getElementById('btn-voice').onclick).toBe('function');
  });

  it('a refused chat mic leaves the terminal\'s own stops working', async () => {
    agents.set('s1', { ownerId: null, state: 'IDLE', term: { focus() {} } });
    setActiveSession('s1');
    document.body.insertAdjacentHTML('beforeend', '<button id="btn-voice"></button><div id="voice-indicator"><span class="voice-indicator-text"></span></div>');
    setupVoice();
    document.getElementById('btn-voice').onclick();
    await flush();
    expect(voiceTarget()).toBe('terminal');
    setWaitingActive(false);                       // the chat mic is refused: no Billion tab
    document.getElementById('chat-mic').click();
    expect(voiceTarget()).toBeNull();              // pressing another mic stopped the terminal's
    stopVoice({ only: 'terminal' });
    setWaitingActive(true);
  });

  it('the terminal\'s stops leave the box\'s mic alone; leaving the tab stops it', async () => {
    document.getElementById('chat-mic').click();
    await flush();
    stopVoice({ only: 'terminal', notice: 'switched agents' });
    expect(voiceTarget()).toBe('chat');
    leaveWaiting();
    expect(voiceTarget()).toBeNull();
  });
});

// Pasted, dropped or picked files: chips above the box, sent with the message.
describe('attachments', () => {
  beforeEach(() => {
    _resetComposer();
    agents.set('b1', { isBillion: true, state: 'WAITING', termEl: document.createElement('div') });
    showWaiting();
  });
  // Module state: a send an earlier test left in flight, or files it left attached.
  afterEach(() => _resetComposer());

  URL.createObjectURL ??= () => 'blob:x';
  URL.revokeObjectURL ??= () => {};
  const png = (name = 'image.png') => new File(['PNG'], name, { type: 'image/png' });
  const pdf = (name = 'notes.pdf', size = 3) => new File(['x'.repeat(size)], name, { type: 'application/pdf' });
  const chips = () => [...document.querySelectorAll('#chat-files .chat-file-chip')];
  const read = () => vi.waitFor(() => expect(document.getElementById('chat-send').disabled).toBe(false));
  const dataTransfer = (files) => ({ files, types: ['Files'], items: [], dropEffect: '' });
  const fire = (target, type, init) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, init);
    target.dispatchEvent(e);
    return e;
  };

  it('a pasted screenshot becomes a thumbnail chip, named so a second one does not replace it', async () => {
    // The terminal's paste handler (an upload to the selected agent) stays out of it.
    setupUpload();
    agents.set('a1', { name: 'Viper', repoPath: '/r', termEl: document.createElement('div') });
    setActiveSession('a1');
    const blob = png();
    const e = fire(input(), 'paste', { clipboardData: { files: [blob], items: [{ type: 'image/png', getAsFile: () => blob }] } });
    expect(e.defaultPrevented).toBe(true);
    await new Promise(r => setTimeout(r, 30));   // the upload would go once its FileReader is done
    expect(send).not.toHaveBeenCalled();
    expect(chips()).toHaveLength(1);
    expect(chips()[0].querySelector('img.chat-file-thumb').alt).toMatch(/^screenshot-\d+\.png$/);
  });

  it('files dropped on the tab light it while dragged and become chips; the paperclip picks too', () => {
    const board = document.getElementById('waiting-board');
    fire(board, 'dragenter', { dataTransfer: dataTransfer([]) });
    expect(board.classList.contains('dropping')).toBe(true);
    const drop = fire(board, 'drop', { dataTransfer: dataTransfer([pdf('a.pdf'), pdf('b.pdf', 2048)]) });
    expect(drop.defaultPrevented).toBe(true);
    expect(board.classList.contains('dropping')).toBe(false);
    expect(chips().map(c => c.textContent)).toEqual(['a.pdf3 B×', 'b.pdf2 KB×']);

    const pick = document.getElementById('chat-attach-input');
    const click = vi.spyOn(pick, 'click').mockImplementation(() => {});
    document.getElementById('chat-attach').click();
    expect(click).toHaveBeenCalled();
    Object.defineProperty(pick, 'files', { value: [pdf('c.pdf')], configurable: true });
    pick.dispatchEvent(new Event('change'));
    expect(chips()).toHaveLength(3);
    chips()[0].querySelector('.chat-file-remove').click();
    expect(chips().map(c => c.querySelector('.chat-file-name').textContent)).toEqual(['b.pdf', 'c.pdf']);
  });

  it('refuses past the job-attachment limits with a line under the box', () => {
    const big = pdf('big.pdf');
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    fire(document.getElementById('waiting-board'), 'drop', { dataTransfer: dataTransfer([big]) });
    expect(chips()).toHaveLength(0);
    expect(document.getElementById('chat-error').textContent).toBe('big.pdf is too large (max 10MB)');
  });

  it('sends files with no text, and clears the chips once the server took them', async () => {
    fire(document.getElementById('waiting-board'), 'drop', { dataTransfer: dataTransfer([pdf('a.pdf')]) });
    await vi.waitFor(() => {
      type('');
      expect(send).toHaveBeenCalledWith({ type: 'chat-send', nonce: expect.any(String), text: '', files: [{ name: 'a.pdf', type: 'application/pdf', data: btoa('xxx') }] });
    });
    handleChatSent({ nonce: send.mock.calls.at(-1)[0].nonce });
    expect(chips()).toHaveLength(0);
    await read();
  });

  it('shows the owner\'s files in the bubble: images open full size, others download', () => {
    setChatMessages([{ id: 'm1', at: new Date().toISOString(), from: 'owner', via: 'app', text: '', files: [
      { name: 'shot.png', size: 3, type: 'image/png' }, { name: 'notes.pdf', size: 2048, type: 'application/pdf' },
    ] }]);
    renderWaiting();
    const image = document.querySelector('.chat-msg .chat-file-image');
    expect([image.getAttribute('href'), image.target, image.querySelector('img').getAttribute('src')])
      .toEqual(['/api/chat/m1/files/shot.png', '_blank', '/api/chat/m1/files/shot.png']);
    const file = document.querySelector('.chat-msg a.chat-file-chip');
    expect([file.getAttribute('href'), file.download, file.textContent]).toEqual(['/api/chat/m1/files/notes.pdf', 'notes.pdf', 'notes.pdf2 KB']);
    expect(document.querySelector('.chat-msg .chat-text')).toBeNull();
  });
});

describe('the Open questions panel', () => {
  beforeEach(() => { localStorage.clear(); _reloadQuestionPrefs(); setQuestionsOpen(false, { focus: false }); showWaiting(); });
  const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
  const panel = () => document.getElementById('chat-questions');
  const sections = () => [...panel().querySelectorAll('.chat-questions-group')].map(g => [
    g.querySelector('.chat-questions-name').textContent, g.querySelector('.chat-questions-count').textContent,
    [...g.querySelectorAll('.waiting-card-n')].map(n => n.textContent).join(' '),
  ]);
  const header = (name) => panel().querySelector(`.chat-questions-project[data-name="${name}"]`);
  // Sections start closed: tap each one open.
  const expand = () => {
    for (const name of questionGroups().map(g => g.name)) if (header(name).getAttribute('aria-expanded') === 'false') header(name).click();
  };
  const seed = () => questions(
    open(1, { project: 'finnamon', type: 'finance', at: at(30) }),
    open(2, { project: 'agent-007', type: 'engineering', at: at(2) }),
    open(3, { project: 'agent-007', type: 'engineering', urgency: 'blocking', at: at(1) }),
    open(4, { at: at(50), text: 'First line\nsecond line' }),   // no project: general; no type: other
    open(5, { project: 'finnamon', type: 'finance', urgency: 'low', at: at(60) }),
    open(6, { project: 'finnamon', type: 'outreach', at: at(40), choices: ['yes', 'no'], recommended: 'no' }),
    { ...open(7, { project: 'mirage', type: 'marketing' }), status: 'answered', answer: 'a' },
  );

  it('groups open questions by project: blocking first by their most urgent, then oldest; rows urgency then oldest', () => {
    seed();
    setQuestionsOpen(true);
    expand();
    expect(sections()).toEqual([
      ['agent-007', '2', '! Q3 Q2'],
      ['general', '1', 'Q4'],
      ['finnamon', '3', 'Q6 Q1 Q5'],
    ]);
    // Rows: the first line of the text and its age.
    const row = panel().querySelector('[data-q="w4"]');
    expect(row.querySelector('.chat-questions-text').textContent).toBe('First line');
    expect(row.querySelector('.chat-questions-age').textContent).toBe('2d');
    expect(panel().querySelector('[data-q="w3"] .chat-questions-age').textContent).toBe('1h');
    // A project with nothing open has no section; none at all, no panel.
    expect(questionGroups().map(g => g.name)).not.toContain('mirage');
    questions({ ...open(7), status: 'answered', answer: 'a' });
    expect(panel().hidden).toBe(true);
  });

  it('answers from a row: the choices (recommended first) and Reply, which arms the box', () => {
    seed();
    setQuestionsOpen(true);
    expand();
    const row = panel().querySelector('[data-q="w6"]');
    expect([...row.querySelectorAll('.waiting-choice')].map(b => b.firstChild.textContent)).toEqual(['no', 'yes']);
    row.querySelector('.waiting-choice').click();
    expect(send).toHaveBeenCalledWith({ type: 'waiting-answer', id: 'w6', answer: 'no' });
    panel().querySelector('[data-q="w2"] .chat-reply').click();
    expect(answerTarget().id).toBe('w2');
    expect(panel().hidden).toBe(false);   // the box sits below it on a desktop
    expect(document.activeElement).toBe(input());
  });

  it('tapping a row\'s text jumps to its bubble and closes the panel', () => {
    seed();
    setQuestionsOpen(true);
    expand();
    expect(document.getElementById('waiting-board').classList.contains('questions-open')).toBe(true);
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    panel().querySelector('[data-q="w5"] .chat-questions-line').click();
    expect(panel().hidden).toBe(true);
    expect(document.getElementById('waiting-board').classList.contains('questions-open')).toBe(false);
    expect(scroll).toHaveBeenCalled();
    expect(bubbleOf('w5').classList.contains('flash')).toBe(true);
  });

  it('closes with × and with Esc, and remembers open or closed in this browser', () => {
    seed();
    setQuestionsOpen(true);
    expect(localStorage.getItem('agent007-questions-open')).toBe('1');
    expect(document.activeElement.id).toBe('chat-questions-close');
    document.getElementById('chat-questions-close').click();
    expect(panel().hidden).toBe(true);
    expect(localStorage.getItem('agent007-questions-open')).toBe('0');
    expect(document.activeElement.id).toBe('chat-strip');
    setQuestionsOpen(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel().hidden).toBe(true);
  });

  it('opens from the tab\'s badge, which still counts every open question', () => {
    seed();
    leaveWaiting();
    updateTabs();
    const badge = document.querySelector('.waiting-tab .chat-badge');
    expect(badge.textContent).toBe('6');
    badge.click();
    expect(waitingActive).toBe(true);
    expect(panel().hidden).toBe(false);
  });
  it('groups by type with the switch, which this browser remembers across a reload', () => {
    seed();
    setQuestionsOpen(true);
    const by = () => [...panel().querySelectorAll('.chat-questions-by button')].map(b => [b.textContent, b.getAttribute('aria-pressed')]);
    expect(by()).toEqual([['by project', 'true'], ['by type', 'false']]);
    panel().querySelectorAll('.chat-questions-by button')[1].click();
    expect(by()).toEqual([['by project', 'false'], ['by type', 'true']]);
    expect(localStorage.getItem('agent007-questions-by')).toBe('type');
    // The strip's label names the grouping.
    expect(document.getElementById('chat-strip').getAttribute('aria-label')).toBe('6 open questions, blocking: hide them by type');
    expand();
    // The same rows, regrouped; a question with no type is "other".
    expect(sections()).toEqual([
      ['engineering', '2', '! Q3 Q2'],
      ['other', '1', 'Q4'],
      ['outreach', '1', 'Q6'],
      ['finance', '2', 'Q1 Q5'],
    ]);
    _reloadQuestionPrefs();
    renderWaiting();
    expect(by()[1][1]).toBe('true');
    expect(questionGroups().map(g => g.name)).toEqual(['engineering', 'other', 'outreach', 'finance']);
    expect(questionGroups(undefined, 'project').map(g => g.name)).toEqual(['agent-007', 'general', 'finnamon']);
    // Anything else stored reads as by project.
    localStorage.setItem('agent007-questions-by', 'bogus');
    _reloadQuestionPrefs();
    renderWaiting();
    expect(by()[0][1]).toBe('true');
  });

  it('starts every section closed, with its count and a "!" when a blocking question is inside; a tap opens it, kept across a reload', () => {
    seed();
    setQuestionsOpen(true);
    expect(sections()).toEqual([['agent-007', '2', ''], ['general', '1', ''], ['finnamon', '3', '']]);
    expect(panel().querySelectorAll('.chat-questions-row')).toHaveLength(0);
    const urgent = (name) => !!header(name).querySelector('.chat-questions-urgent');
    expect([urgent('agent-007'), urgent('general'), urgent('finnamon')]).toEqual([true, false, false]);
    // The "!" is hidden from screen readers; the header's name says it.
    expect(['agent-007', 'finnamon'].map(name => header(name).getAttribute('aria-label'))).toEqual(['agent-007, 2 open, blocking', 'finnamon, 3 open']);
    expect(header('agent-007').tagName).toBe('BUTTON');
    // A heading wraps the button; the button controls the body, hidden while closed.
    expect(header('agent-007').parentElement.tagName).toBe('H3');
    const body = () => document.getElementById(header('finnamon').getAttribute('aria-controls'));
    expect(body().hidden).toBe(true);
    expect(header('agent-007').getAttribute('aria-expanded')).toBe('false');
    header('finnamon').click();
    expect(header('finnamon').getAttribute('aria-expanded')).toBe('true');
    expect(body().hidden).toBe(false);
    expect(document.activeElement).toBe(header('finnamon'));
    expect(sections()[2]).toEqual(['finnamon', '3', 'Q6 Q1 Q5']);
    expect(localStorage.getItem('agent007-questions-section:project:finnamon')).toBe('1');
    // A refresh: the same sections open and closed.
    _reloadQuestionPrefs();
    showWaiting();
    expect(sections().map(g => g[2])).toEqual(['', '', 'Q6 Q1 Q5']);
    // Kept per grouping: by type, finance starts closed.
    setGroupBy('type');
    expect(panel().querySelectorAll('.chat-questions-row')).toHaveLength(0);
    setGroupBy('project');
    header('finnamon').click();
    expect(sections()[2]).toEqual(['finnamon', '3', '']);
    expect(localStorage.getItem('agent007-questions-section:project:finnamon')).toBe('0');
  });
});

describe('Telegram in the Billion tab', () => {
  beforeEach(() => { setWaitingActive(true); setTelegramState({ offers: [] }); });

  it('names the group member who answered, and who wrote a Telegram message', () => {
    const q = { id: 'w1', n: 1, urgency: 'normal', status: 'answered', answer: 'Merge', answeredVia: 'telegram', answeredBy: 'Alice', answeredAt: new Date(0).toISOString() };
    setChatMessages([
      { id: 'm1', at: new Date().toISOString(), from: 'billion', text: 'Merge?', q },
      { id: 'm2', at: new Date().toISOString(), from: 'owner', via: 'telegram', name: 'Alice', text: 'done' },
    ]);
    renderWaiting();
    expect(bubbleOf('w1').querySelector('.chat-answered').textContent).toBe('Alice answered: Merge (on Telegram)');
    expect(document.querySelector('.chat-msg[data-id="m2"] .chat-meta').textContent).toMatch(/^Alice on Telegram · /);
  });

  it('offers a chat with "Use this chat" and Dismiss, then says it is connected', () => {
    renderWaiting();
    setTelegramState({ type: 'telegram-state', on: true, connected: false, offers: [{ chatId: '-5', name: 'Team' }] });
    const bar = document.getElementById('chat-telegram');
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Telegram: a message from Team (chat -5). Use it for Billion?');
    [...bar.querySelectorAll('button')].find(b => b.textContent === 'Use this chat').click();
    expect(send).toHaveBeenCalledWith({ type: 'telegram-use', chatId: '-5' });
    [...bar.querySelectorAll('button')].find(b => b.textContent === 'Dismiss').click();
    expect(send).toHaveBeenCalledWith({ type: 'telegram-dismiss', chatId: '-5' });
    setTelegramState({ type: 'telegram-state', on: true, connected: true, connectedTo: 'Team', offers: [] });
    expect(bar.textContent).toBe('Telegram connected: Team');
  });
});

describe('Telegram in Settings', async () => {
  const { renderTelegramSettings } = await import('../public/modules/settings.js');
  beforeEach(() => { document.body.innerHTML = '<div id="telegram-settings" hidden></div>'; });
  const box = () => document.getElementById('telegram-settings');

  it('names the connected chat, and Change forgets it', () => {
    renderTelegramSettings({ on: true, connected: true, chat: { chatId: '-5', name: 'Team', fromEnv: false } });
    expect(box().hidden).toBe(false);
    expect(box().querySelector('.settings-telegram').textContent).toBe('Connected to Team (chat -5).');
    [...box().querySelectorAll('button')].find(b => b.textContent === 'Change').click();
    expect(send).toHaveBeenCalledWith({ type: 'telegram-forget' });
  });

  it('has no Change for a chat set by TELEGRAM_CHAT_ID, and gives the steps when none is connected', () => {
    renderTelegramSettings({ on: true, connected: true, chat: { chatId: '42', name: '', fromEnv: true } });
    expect(box().textContent).toContain('Connected to chat 42, set by TELEGRAM_CHAT_ID.');
    expect(box().querySelector('button')).toBeNull();
    renderTelegramSettings({ on: true, connected: false, offers: [] });
    expect(box().textContent).toContain('Press "Use this chat" in the Billion tab');
  });
});
