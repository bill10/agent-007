// @vitest-environment happy-dom
// The "Waiting on you" tab (public/modules/waiting.js): the bell's badge, the
// cards with their choices and reply line, what answering sends, an inline
// error that keeps the card open, and the Answered section.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { agents, setActiveSession, setBoardActive, setWaitingItems, setWaitingActive } from '../public/modules/state.js';
import { updateTabs } from '../public/modules/terminal.js';
import { showWaiting, renderWaiting, handleWaitingError, leaveWaiting } from '../public/modules/waiting.js';

const open = (n, extra = {}) => ({ id: `w${n}`, n, text: `Question ${n}?`, at: new Date().toISOString(), status: 'open', ...extra });
const card = (id) => document.querySelector(`.waiting-card[data-id="${id}"]`);

beforeEach(() => {
  document.body.innerHTML = '<div id="terminal-tabs"></div><div id="terminal-empty"></div><div id="job-board"></div>'
    + '<div id="waiting-board" style="display:none"><div id="waiting-list"></div></div>'
    + '<nav class="mobile-nav"><button data-view="terminal"></button><button data-view="waiting"><span id="mobile-nav-waiting-count" hidden></span></button></nav>';
  agents.clear();
  setActiveSession(null);
  setBoardActive(false);
  setWaitingActive(false);
  setWaitingItems([]);
  vi.clearAllMocks();
});

describe('the Waiting tab', () => {
  it('sits next to Jobs as a bell alone, badged with open questions only, here and in the phone bar', () => {
    setWaitingItems([open(1), open(2), { ...open(3), status: 'answered', answer: 'yes' }]);
    updateTabs();
    const tabs = [...document.querySelectorAll('.terminal-tab')];
    expect(tabs.map(t => t.textContent.replace(/\d/g, ''))).toEqual(['Jobs', '']);
    const tab = tabs[1];
    expect(tab.querySelector('.bell svg')).not.toBeNull();
    expect(tab.querySelector('.bell .board-tab-badge').textContent).toBe('2');
    expect(tab.getAttribute('aria-label')).toBe('Waiting on you, 2 questions');
    expect(tab.title).toBe('Waiting on you, 2 questions');
    const nav = document.getElementById('mobile-nav-waiting-count');
    const navBtn = document.querySelector('.mobile-nav [data-view="waiting"]');
    expect([nav.textContent, nav.hidden, navBtn.getAttribute('aria-label')]).toEqual(['2', false, 'Waiting on you, 2 questions']);

    setWaitingItems([open(1)]);
    updateTabs();
    expect(document.querySelector('.waiting-tab').getAttribute('aria-label')).toBe('Waiting on you, 1 question');

    setWaitingItems(Array.from({ length: 10 }, (_, i) => open(i + 1)));
    updateTabs();
    expect(document.querySelector('.waiting-tab .board-tab-badge').textContent).toBe('9+');
    expect(document.querySelector('.waiting-tab').getAttribute('aria-label')).toBe('Waiting on you, 10 questions');
    expect(nav.textContent).toBe('9+');

    setWaitingItems([]);
    updateTabs();
    expect(document.querySelector('.waiting-tab .board-tab-badge').hidden).toBe(true);
    expect(document.querySelector('.waiting-tab').classList.contains('empty')).toBe(true);
    expect(document.querySelector('.waiting-tab').getAttribute('aria-label')).toBe('Waiting on you');
    expect([nav.hidden, navBtn.getAttribute('aria-label'), navBtn.title]).toEqual([true, 'Waiting on you', 'Waiting on you']);
  });

  it('opens on "Nothing waiting on you." when there is nothing, and lights the phone button', () => {
    document.body.dataset.view = 'terminal';
    showWaiting();
    expect(document.getElementById('waiting-board').style.display).toBe('flex');
    expect(document.getElementById('job-board').style.display).toBe('none');
    expect(document.getElementById('waiting-list').textContent).toBe('Nothing waiting on you.');
    expect(document.querySelector('.mobile-nav [data-view="waiting"]').getAttribute('aria-current')).toBe('true');
    // The phone's Terminal button leaves it.
    leaveWaiting();
    expect(document.getElementById('waiting-board').style.display).toBe('none');
    expect(document.getElementById('terminal-empty').style.display).toBe('flex');
    expect(document.querySelector('.mobile-nav [data-view="terminal"]').getAttribute('aria-current')).toBe('true');
  });
});

describe('a question card', () => {
  beforeEach(() => showWaiting());

  it('shows the text, the choices with the recommended one marked, and a reply line', () => {
    setWaitingItems([open(1, { text: '<b>Buy?</b>', choices: ['yes', 'no'], recommended: 'yes' })]);
    renderWaiting();
    const c = card('w1');
    expect(c.querySelector('.waiting-card-n').textContent).toBe('Q1');
    expect(c.querySelector('.waiting-card-text').textContent).toBe('<b>Buy?</b>');
    expect(c.querySelector('b')).toBeNull();
    const choices = [...c.querySelectorAll('.waiting-choice')];
    expect(choices.map(b => b.classList.contains('recommended'))).toEqual([true, false]);
    expect(choices[0].textContent).toBe('yesrecommended');
    expect(c.querySelector('.waiting-reply input')).not.toBeNull();
    choices[1].click();
    expect(send).toHaveBeenCalledWith({ type: 'waiting-answer', id: 'w1', answer: 'no' });
    // Held until the server answers: no double send.
    card('w1').querySelector('.waiting-choice').click();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a typed answer, and shows a refusal inline with the card still open', () => {
    setWaitingItems([open(2)]);
    renderWaiting();
    const input = card('w2').querySelector('input');
    input.value = '  call it Raven ';
    input.dispatchEvent(new Event('input'));
    card('w2').querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(send).toHaveBeenCalledWith({ type: 'waiting-answer', id: 'w2', answer: 'call it Raven' });
    handleWaitingError({ id: 'w2', error: 'Billion is not running' });
    expect(card('w2').querySelector('.waiting-error').textContent).toBe('Billion is not running');
    expect(card('w2').querySelector('input').value).toBe('  call it Raven ');
    expect(card('w2').querySelector('input').disabled).toBe(false);
  });

  it('says so on the card, and does not hang on Sending, when the socket is down', () => {
    setWaitingItems([open(5, { choices: ['yes', 'no'] })]);
    renderWaiting();
    send.mockReturnValueOnce(false);
    card('w5').querySelector('.waiting-choice').click();
    expect(card('w5').querySelector('.waiting-error').textContent).toMatch(/Not connected/);
    expect(card('w5').querySelector('.waiting-choice').disabled).toBe(false);
  });

  it('dismisses with ×, and moves answered ones to a collapsed Answered section', () => {
    setWaitingItems([open(1), { ...open(2), status: 'answered', answer: 'no', answeredVia: 'telegram', answeredAt: new Date().toISOString() }]);
    renderWaiting();
    expect(card('w2')).toBeNull();
    card('w1').querySelector('.waiting-dismiss').click();
    expect(send).toHaveBeenCalledWith({ type: 'waiting-dismiss', id: 'w1' });
    const answered = document.querySelector('details.waiting-answered');
    expect(answered.open).toBe(false);
    expect(answered.querySelector('summary').textContent).toBe('Answered (1)');
    expect(answered.querySelector('.waiting-answered-answer').textContent).toMatch(/^→ no · Telegram/);
  });
});
