// @vitest-environment happy-dom
// The "Waiting on you" tab (public/modules/waiting.js): the bell's count, the
// cards with their choices and reply line, what answering sends, an inline
// error that keeps the card open, and the Answered section.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { agents, setActiveSession, setBoardActive, setWaitingItems, setWaitingActive } from '../public/modules/state.js';
import { updateTabs } from '../public/modules/terminal.js';
import { showWaiting, renderWaiting, handleWaitingError } from '../public/modules/waiting.js';

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
  it('sits next to Jobs with a bell, counting open questions only, here and in the phone bar', () => {
    setWaitingItems([open(1), open(2), { ...open(3), status: 'answered', answer: 'yes' }]);
    updateTabs();
    const tabs = [...document.querySelectorAll('.terminal-tab')];
    expect(tabs.map(t => t.textContent.replace(/\d/g, ''))).toEqual(['Jobs', 'Waiting']);
    expect(tabs[1].querySelector('svg')).not.toBeNull();
    expect(tabs[1].querySelector('.board-tab-badge').textContent).toBe('2');
    const nav = document.getElementById('mobile-nav-waiting-count');
    expect([nav.textContent, nav.hidden]).toEqual(['2', false]);
    setWaitingItems([]);
    updateTabs();
    expect(document.querySelector('.waiting-tab .board-tab-badge')).toBeNull();
    expect(nav.hidden).toBe(true);
  });

  it('opens on "Nothing waiting on you." when there is nothing, and lights the phone button', () => {
    document.body.dataset.view = 'terminal';
    showWaiting();
    expect(document.getElementById('waiting-board').style.display).toBe('flex');
    expect(document.getElementById('job-board').style.display).toBe('none');
    expect(document.getElementById('waiting-list').textContent).toBe('Nothing waiting on you.');
    expect(document.querySelector('.mobile-nav [data-view="waiting"]').getAttribute('aria-current')).toBe('true');
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
