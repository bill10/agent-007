// @vitest-environment happy-dom
// The Billion tab's "Briefing" view and status line (public/modules/round.js):
// the round's brief, one section per project with its cards, answered cards
// folding where they stand, the "3 of 7 done" counter, Earlier closed by
// default, a typed draft and the scroll kept through an update, the Briefing
// / Chat switch, and the status line's words.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { setWaitingItems, setRoundInfo, setBillionStatus, setWaitingActive, setChatMessages } from '../public/modules/state.js';
import { renderRound, renderBillionStatus, roundModel, statusLine, setSubTab, subTab, initSubTabs, handleRoundError, _resetRound, doneNumbers } from '../public/modules/round.js';
import { renderWaiting } from '../public/modules/waiting.js';

const ROUND = { id: '2026-10-01 15:30', label: '10/1 pm', name: 'Afternoon briefing', at: '2026-10-01T15:30:00Z', releasedAt: '2026-10-01T15:30:05Z' };
const INFO = { type: 'round-state', on: true, max: 2, current: { ...ROUND, brief: 'Billing fix shipped. Two pricing calls below.' }, next: { id: '2026-10-02 08:30', label: '10/2 am', at: Date.parse('2026-10-02T08:30:00Z') } };
const q = (n, extra = {}) => ({ id: `q${n}`, n, text: `Question ${n}?`, at: `2026-10-01T10:0${n % 10}:00Z`, status: 'open', urgency: 'normal', project: 'general', round: ROUND.id, pos: n, ...extra });
const cards = () => [...document.querySelectorAll('.round-card')].map(c => c.dataset.q);
const show = (items, info = INFO) => { setWaitingItems(items); setRoundInfo(info); renderRound(); };

beforeEach(() => {
  document.body.innerHTML = '<div id="waiting-board" data-sub="round"><div id="billion-status"></div>'
    + '<div id="billion-subtabs"><button data-sub="round"></button><button data-sub="chat"></button></div>'
    + '<div id="round-view"></div><div id="waiting-list"></div></div>';
  localStorage.clear();
  _resetRound();
  setWaitingActive(true);
  setChatMessages([]);
  setBillionStatus(null);
  vi.clearAllMocks();
});

describe('Briefing', () => {
  it('shows the brief, then one section per project with its cards, in the order the round released them', () => {
    show([q(1, { project: 'beta', pos: 1 }), q(2, { project: 'alpha', pos: 0 }), q(3, { project: 'beta', pos: 2 }),
      q(4, { round: '2026-10-01 08:30', status: 'consolidated' }), q(5, { status: 'queued', round: undefined })]);
    expect(document.querySelector('.round-title').textContent).toBe('Afternoon briefing · 10/1');
    expect(document.querySelector('.round-brief').textContent).toBe('Billing fix shipped. Two pricing calls below.');
    expect([...document.querySelectorAll('.round-dept-title')].map(h => h.textContent)).toEqual(['alpha', 'beta']);
    expect(cards()).toEqual(['q2', 'q1', 'q3']);
    expect(document.querySelector('.round-count').textContent).toBe('0 of 3 done');
  });

  it('puts a question sent outside the round first, as Needs you now', () => {
    show([q(1), q(2, { round: undefined, urgency: 'blocking', outside: true })]);
    expect([...document.querySelectorAll('.round-dept-title')].map(h => h.textContent)).toEqual(['Needs you now', 'general']);
    expect(document.querySelector('.round-dept.urgent .waiting-urgent').textContent).toBe('!');
  });

  it('answers with a tap or a typed reply, and folds an answered card where it stands', () => {
    show([q(1, { choices: ['yes', 'no'], recommended: 'no' }), q(2)]);
    const choices = [...document.querySelectorAll('[data-q="q1"] .waiting-choice')];
    expect(choices.map(b => b.firstChild.textContent)).toEqual(['no', 'yes']);
    choices[0].click();
    expect(send).toHaveBeenCalledWith({ type: 'waiting-answer', id: 'q1', answer: 'no' });
    expect(choices[1].disabled).toBe(true);

    const box = document.querySelector('[data-q="q2"] .round-reply-input');
    box.value = 'Ship it Friday';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(send).toHaveBeenLastCalledWith({ type: 'waiting-answer', id: 'q2', answer: 'Ship it Friday' });

    const before = document.querySelector('[data-q="q1"]');
    show([q(1, { choices: ['yes', 'no'], status: 'answered', answer: 'no', answeredVia: 'app', answeredAt: new Date().toISOString() }), q(2)]);
    const after = document.querySelector('[data-q="q1"]');
    expect(after).toBe(before);   // the same node: nothing moved
    expect(after.classList.contains('done')).toBe(true);
    expect(after.querySelector('.round-card-answer').textContent).toMatch(/^✓ you answered: no/);
    expect(document.querySelector('.round-count').textContent).toBe('1 of 2 done');
    after.querySelector('.chat-link').click();
    expect(send).toHaveBeenLastCalledWith({ type: 'waiting-reopen', id: 'q1' });
  });

  it('keeps a draft, its focus and the scroll through an update that adds a card', () => {
    show([q(1), q(2)]);
    const view = document.getElementById('round-view');
    const box = document.querySelector('[data-q="q2"] .round-reply-input');
    box.value = 'half typed';
    box.dispatchEvent(new Event('input'));
    box.focus();
    view.scrollTop = 40;
    const scrolled = view.scrollTop;
    show([q(1), q(2), q(3, { round: undefined, urgency: 'blocking' })]);
    const again = document.querySelector('[data-q="q2"] .round-reply-input');
    expect(again.value).toBe('half typed');
    expect(document.activeElement).toBe(again);
    expect(view.scrollTop).toBe(scrolled);
  });

  it('shows why a tap did not go through on its card', () => {
    show([q(1, { choices: ['yes', 'no'] })]);
    document.querySelector('.waiting-choice').click();
    handleRoundError({ id: 'q1', error: 'Billion is not running' });
    expect(document.querySelector('[data-q="q1"] .waiting-error').textContent).toBe('Billion is not running');
    expect(document.querySelector('.waiting-choice').disabled).toBe(false);
  });

  it('keeps Earlier closed until asked, with what past rounds consolidated or got answered', () => {
    show([q(1), q(4, { round: 'old', status: 'consolidated', consolidatedAt: '2026-10-01T15:30:05Z' }), q(5, { round: 'old', status: 'answered', answer: 'ok', answeredAt: '2026-10-01T09:00:00Z' })]);
    const toggle = document.querySelector('.round-earlier-toggle');
    expect([toggle.textContent, toggle.getAttribute('aria-expanded'), document.getElementById('round-earlier').hidden]).toEqual(['Earlier (2)', 'false', true]);
    toggle.click();
    expect([...document.querySelectorAll('.round-earlier-what')].map(r => r.textContent)).toEqual(['consolidated', 'answered: ok']);
  });

  it('says when the next briefing is when there is nothing for the owner', () => {
    show([], { ...INFO, current: null });
    expect(document.querySelector('.round-title').textContent).toBe('No briefing yet');
    expect(document.querySelector('.round-empty').textContent).toMatch(/^Billion's questions come in briefings, twice a day\. Next briefing .* Until then they show here as soon as Billion asks\.$/);
  });

  it('before the first round, shows each question as Open questions rather than an emergency', () => {
    show([q(1, { round: undefined })], { ...INFO, current: null });
    expect([...document.querySelectorAll('.round-dept-title')].map(h => h.textContent)).toEqual(['Open questions']);
  });

  it('with rounds off, shows every open question by project', () => {
    const model = roundModel([q(1, { round: undefined }), q(2, { round: undefined, project: 'x' }), q(3, { status: 'answered', round: undefined })], { on: false });
    expect(model.sections.map(s => [s.title, s.items.map(i => i.id)])).toEqual([['general', ['q1']], ['x', ['q2']]]);
  });
});

describe('the switch between This round and Chat', () => {
  it('opens on Chat until a round has been released, so a new install sees the introduction and any setup notice', () => {
    initSubTabs(vi.fn());
    show([], { ...INFO, current: null });
    expect(document.getElementById('waiting-board').dataset.sub).toBe('chat');
    show([], INFO);
    expect(document.getElementById('waiting-board').dataset.sub).toBe('round');
    // The owner's own pick wins either way.
    setSubTab('chat');
    show([], INFO);
    expect(subTab()).toBe('chat');
  });

  it('opens on This round once there has been one, remembers Chat, and draws the thread when it is shown', () => {
    const chat = vi.fn();
    setRoundInfo(INFO);
    initSubTabs(chat);
    expect(subTab()).toBe('round');
    document.querySelector('#billion-subtabs [data-sub="chat"]').click();
    expect(document.getElementById('waiting-board').dataset.sub).toBe('chat');
    expect(document.querySelector('#billion-subtabs [data-sub="chat"]').getAttribute('aria-selected')).toBe('true');
    expect(chat).toHaveBeenCalled();
    expect(localStorage.getItem('agent007-billion-sub')).toBe('chat');
    setSubTab('round');
    expect(document.getElementById('waiting-board').dataset.sub).toBe('round');
  });
});

describe('the status line', () => {
  const next = Date.parse('2026-10-01T19:30:00Z');
  const now = Date.parse('2026-10-01T16:00:00Z');
  it('says what Billion is doing, how many workers run and when the next briefing is', () => {
    expect(statusLine({ running: true, working: true, text: 'reviewing PR #120', workers: 3, nextRoundAt: next }, { on: true }, now))
      .toMatch(/^Working: reviewing PR #120 · 3 workers running · next briefing \d{1,2}:30 (am|pm)$/);
    expect(statusLine({ running: true, working: true, workers: 1 }, { on: true }, now)).toBe('Thinking… · 1 worker running');
    expect(statusLine({ running: true, working: false }, { on: false }, now)).toBe('Idle');
    expect(statusLine({ running: true, working: false, awaitingReply: true, text: 'x' }, {}, now)).toBe('Replying shortly…');
    expect(statusLine({ running: false }, {}, now)).toBe('Billion is not running');
  });

  it('draws once per change, pulsing while Billion works', () => {
    setBillionStatus({ running: true, working: true, text: 'reviewing PR #120', workers: 0 });
    setRoundInfo({ on: false });
    renderBillionStatus();
    const line = document.getElementById('billion-status');
    expect([line.dataset.mood, line.textContent]).toEqual(['busy', 'Working: reviewing PR #120']);
    const dot = line.querySelector('.billion-status-dot');
    renderBillionStatus();
    expect(line.querySelector('.billion-status-dot')).toBe(dot);
    setBillionStatus({ running: true, working: false, awaitingReply: true, pending: ['m1'] });
    renderBillionStatus();
    expect([line.dataset.mood, line.textContent]).toEqual(['idle', 'Replying shortly…']);
  });
});

describe('numbered items, Done and "1d"', () => {
  it('shows each item\'s number, sends Done for it, and reads "1d 3d" typed in any card\'s box', () => {
    show([q(1, { num: 1, numRound: ROUND.id }), q(2, { num: 2, numRound: ROUND.id })]);
    expect([...document.querySelectorAll('.round-card-num')].map(n => n.textContent)).toEqual(['1', '2']);
    document.querySelector('[data-q="q2"] .round-done').click();
    expect(send).toHaveBeenLastCalledWith({ type: 'round-done', id: 'q2', nums: [2] });
    const box = document.querySelector('[data-q="q1"] .round-reply-input');
    box.value = '1d 2d';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(send).toHaveBeenLastCalledWith({ type: 'round-done', id: 'q1', nums: [1, 2] });
    show([q(1, { num: 1, status: 'answered', answer: 'done', done: true, answeredVia: 'app', answeredAt: '2026-10-01T15:40:00Z' }), q(2, { num: 2 })]);
    expect(document.querySelector('[data-q="q1"] .round-card-answer').textContent).toBe('✓ done');
  });

  it('reads "1d" the way the server does (test/owner-rounds.test.js has the same cases)', () => {
    expect(['1d', '1d 3d', '1d, 3D', '2 d', '1', 'done', '1d3d', '12 dogs'].map(doneNumbers)).toEqual([[1], [1, 3], [1, 3], [2], null, null, null, null]);
  });
});

describe('Start the round now', () => {
  it('shows while questions wait for the next briefing, and asks the server to release it', () => {
    show([q(1)], { ...INFO, queued: 0 });
    expect(document.querySelector('.round-start')).toBeNull();
    show([q(1)], { ...INFO, queued: 4 });
    const btn = document.querySelector('.round-start');
    expect(btn.textContent).toBe('Start the briefing now (4 waiting)');
    btn.click();
    expect(send).toHaveBeenLastCalledWith({ type: 'round-start' });
    expect(document.querySelector('.round-start').disabled).toBe(true);
    show([q(1)], { ...INFO, queued: 1, current: { ...ROUND, id: 'next' } });
    expect(document.querySelector('.round-start').disabled).toBe(false);
  });
});

describe('the progress box', () => {
  const owner = id => ({ id, at: new Date().toISOString(), from: 'owner', text: `Question ${id}?` });
  const row = id => document.querySelector(`.chat-msg[data-id="${id}"]`);
  it('shows pending → live summaries → collapsed Work details when the answer binds, even before the status arrives', () => {
    setChatMessages([owner('m1')]);
    setBillionStatus({ running: true, working: true, pending: ['m1'], progress: { m1: [] } });
    renderWaiting();
    expect(row('m1').querySelector('.chat-progress').textContent).toContain('Working…');
    setBillionStatus({ running: true, working: true, pending: ['m1'], progress: { m1: ['Checking launch metrics', 'Found two missing runs'] } });
    renderWaiting();
    expect(row('m1').querySelectorAll('li').length).toBe(2);
    setChatMessages([owner('m1'), { id: 'a1', from: 'billion', text: 'Two runs need recovery.', replyTo: 'm1', workDetails: ['Checking launch metrics', 'Found two missing runs'] }]);
    renderWaiting();
    expect(document.querySelector('.chat-progress')).toBeNull();
    expect(row('m1').classList.contains('pending')).toBe(false);
    const details = row('a1').querySelector('details');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toBe('Work details');
    details.open = true;
    renderWaiting();
    expect(row('a1').querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
  });

  it('associates rapid messages separately and ignores agent updates and legacy raw steps', () => {
    setChatMessages([owner('m1'), owner('m2'), { id: 'notice', from: 'billion', text: 'Worker finished.', notice: true }]);
    setBillionStatus({ running: true, working: true, pending: ['m1', 'm2'], text: 'Global status', steps: ['SECRET_RAW_TOOL_OUTPUT'], progress: { m1: ['Checking first'], m2: [] } });
    renderWaiting();
    expect(row('notice').textContent).toContain('System update');
    expect(row('m1').textContent).toContain('Checking first');
    expect(row('m2').textContent).not.toContain('Checking first');
    expect(row('m2').textContent).toContain('Answering your earlier message first');
    expect(document.body.textContent).not.toContain('SECRET_RAW_TOOL_OUTPUT');
    expect(document.querySelectorAll('.chat-progress.active')).toHaveLength(1);
    setChatMessages([owner('m1'), owner('m2'), { id: 'a1', from: 'billion', text: 'First answer', replyTo: 'm1' }]);
    setBillionStatus({ running: true, working: false, pending: ['m2'], progress: { m2: ['Checking second'] } });
    renderWaiting();
    expect(row('m1').querySelector('.chat-progress')).toBeNull();
    expect(row('m2').textContent).toContain('Checking second');
    expect(document.querySelectorAll('.chat-progress.active')).toHaveLength(0);
    expect(row('a1').querySelector('details')).toBeNull();
  });

  it('does not claim to work on a newer message while an expired earlier request still owns the reply', () => {
    setChatMessages([owner('m1'), owner('m2')]);
    setBillionStatus({ running: true, working: true, pending: ['m2'], currentRequest: 'm1', progress: { m1: ['Checking first'], m2: [] } });
    renderWaiting();
    expect(row('m1').querySelector('.chat-progress')).toBeNull();
    expect(row('m2').textContent).toContain('Answering your earlier message first');
    expect(document.querySelector('.chat-progress.active')).toBeNull();
  });

  it('removes active progress when stopped and restores persisted request summaries after reconnect', () => {
    const saved = { ...owner('m1'), workDetails: ['Evidence found'] };
    setChatMessages([saved]);
    setBillionStatus({ running: true, working: true, pending: ['m1'], currentRequest: 'm1', progress: { m1: ['Evidence found'] } });
    renderWaiting();
    expect(row('m1').querySelector('.chat-progress.active')).not.toBeNull();
    setBillionStatus({ running: false, working: false, pending: [], currentRequest: 'm1', progress: { m1: ['Evidence found'] } });
    renderWaiting();
    expect(document.querySelector('.chat-progress')).toBeNull();
    setBillionStatus(null);
    renderWaiting();
    expect(document.querySelector('.chat-progress')).toBeNull();
    setBillionStatus({ running: true, working: false, pending: ['m1'], currentRequest: 'm1' });
    renderWaiting();
    expect(row('m1').querySelector('li').textContent).toBe('Evidence found');
    expect(row('m1').querySelector('.chat-progress.active')).toBeNull();
  });

  it('drops blank and non-text summary entries without creating empty answer details', () => {
    setChatMessages([owner('m1'), { id: 'a2', from: 'billion', replyTo: 'm2', text: 'Done', workDetails: [null, '', '  ', 42] }]);
    setBillionStatus({ running: true, working: false, pending: ['m1'], progress: { m1: [null, '', '  ', 42] } });
    renderWaiting();
    expect(row('m1').querySelector('li').textContent).toBe('Waiting to start…');
    expect(row('a2').querySelector('details')).toBeNull();
  });

  it('reconstructs saved details on reconnect, escapes HTML and omits empty details', () => {
    const text = '<img src=x onerror=alert(1)>';
    setChatMessages([owner('m1'), { id: 'a1', from: 'billion', text: 'Done', replyTo: 'm1', workDetails: [text] }, { id: 'a2', from: 'billion', text: 'Done', replyTo: 'm2', workDetails: [] }]);
    setBillionStatus({ running: false, pending: [], progress: {} });
    renderWaiting();
    expect(row('a1').querySelector('details').open).toBe(false);
    expect(row('a1').querySelector('li').textContent).toBe(text);
    expect(row('a1').querySelector('img')).toBeNull();
    expect(row('a2').querySelector('details')).toBeNull();
    setChatMessages([owner('m3')]);
    setBillionStatus({ running: true, working: true, pending: ['m3'], progress: { m3: [text] } });
    renderWaiting();
    expect(row('m3').querySelector('li').textContent).toBe(text);
    expect(row('m3').querySelector('img')).toBeNull();
  });
});
