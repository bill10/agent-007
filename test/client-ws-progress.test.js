// @vitest-environment happy-dom
// Exercise the real socket callbacks with the chat renderer. No server, agent,
// authentication request or live owner data is used.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

let sockets;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  sockets = [];
  vi.stubGlobal('WebSocket', class {
    constructor() { sockets.push(this); }
  });
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', reload: vi.fn() });
  document.body.innerHTML = '<div id="reconnecting"></div><div id="waiting-board"><div id="billion-status"></div><div id="waiting-list"></div></div>';
  localStorage.clear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(connect, state, renderWaiting, renderBillionStatus) {
  state.setWaitingActive(true);
  const receive = vi.fn(msg => {
    if (msg.type === 'billion-status') state.setBillionStatus(msg);
    if (msg.type === 'chat-list') state.setChatMessages(msg.messages);
    renderWaiting();
    renderBillionStatus();
  });
  connect(receive);
  return receive;
}
const emit = (socket, data) => socket.onmessage({ data: JSON.stringify(data) });
const pendingMessage = () => [{ id: 'm1', from: 'owner', text: 'Check the run', at: new Date().toISOString(), awaitsReply: true, workDetails: ['Checking evidence'] }];
const workingOn = (lines) => ({ type: 'billion-status', running: true, working: true, pending: ['m1'], currentRequest: 'm1', progress: { m1: lines } });

it('keeps a pending owner message and its progress box through a short drop, shows nothing as active, and reconnects without a reload', async () => {
  const { connect } = await import('../public/modules/ws.js');
  const state = await import('../public/modules/state.js');
  const { renderWaiting } = await import('../public/modules/waiting.js');
  const { renderBillionStatus } = await import('../public/modules/round.js');
  const receive = setup(connect, state, renderWaiting, renderBillionStatus);
  sockets[0].onopen();
  emit(sockets[0], { type: 'welcome', bootId: 'boot-1', sessionIds: [] });
  const messages = pendingMessage();
  emit(sockets[0], { type: 'chat-list', messages });
  emit(sockets[0], workingOn(['Checking evidence']));
  expect(document.querySelector('.chat-progress.active')).not.toBeNull();

  receive.mockClear();
  sockets[0].onclose({ code: 1006 });
  expect(receive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'billion-status', disconnected: true, working: false }));
  // The message and its box stay, with the progress last heard; nothing is
  // shown as active while what Billion is doing is unknown.
  const row = document.querySelector('.chat-msg.mine.pending');
  expect(row?.dataset.id).toBe('m1');
  expect(row.querySelector('.chat-progress.active')).toBeNull();
  expect(row.querySelector('.chat-progress-head').textContent).toBe('Reconnecting… your message is kept');
  expect(row.querySelector('.chat-progress li').textContent).toBe('Checking evidence');
  expect(document.getElementById('billion-status').textContent).toBe('Reconnecting…');
  expect(state.chatMessages).toEqual(messages);
  expect(document.querySelector('.chat-work-details')).toBeNull();

  vi.advanceTimersByTime(1000);
  expect(sockets).toHaveLength(2);
  sockets[1].onopen();
  // The same server: the page stays, and the handshake's replay carries
  // persisted chat before current status, with progress made meanwhile.
  emit(sockets[1], { type: 'welcome', bootId: 'boot-1', sessionIds: [] });
  expect(location.reload).not.toHaveBeenCalled();
  emit(sockets[1], { type: 'chat-list', messages });
  emit(sockets[1], workingOn(['Checking evidence', 'Reading the log']));
  expect([...document.querySelectorAll('.chat-progress.active li')].map(li => li.textContent)).toEqual(['Checking evidence', 'Reading the log']);
  expect(document.querySelector('.chat-work-details')).toBeNull();
});

it('the keep-alive: an unanswered ping drops a half-dead socket and reconnects in place, keeping the pending message', async () => {
  const { connect, PING_MS, DEAD_MS } = await import('../public/modules/ws.js');
  const state = await import('../public/modules/state.js');
  const { renderWaiting } = await import('../public/modules/waiting.js');
  const { renderBillionStatus } = await import('../public/modules/round.js');
  setup(connect, state, renderWaiting, renderBillionStatus);
  const sent = [];
  sockets[0].readyState = 1;
  sockets[0].send = (data) => sent.push(JSON.parse(data));
  sockets[0].close = vi.fn();
  sockets[0].onopen();
  emit(sockets[0], { type: 'welcome', bootId: 'boot-1', sessionIds: [] });
  emit(sockets[0], { type: 'chat-list', messages: pendingMessage() });
  emit(sockets[0], workingOn(['Checking evidence']));

  // Answered pings keep the socket.
  vi.advanceTimersByTime(PING_MS);
  expect(sent).toEqual([{ type: 'ping' }]);
  emit(sockets[0], { type: 'pong' });
  vi.advanceTimersByTime(PING_MS);
  expect(sockets).toHaveLength(1);

  // The link goes quiet: no pong. Within one ping past DEAD_MS it is dropped.
  vi.advanceTimersByTime(DEAD_MS + PING_MS);
  expect(sockets[0].close).toHaveBeenCalled();
  expect(document.querySelector('.chat-msg.mine.pending .chat-progress li')?.textContent).toBe('Checking evidence');
  vi.advanceTimersByTime(1000);
  expect(sockets.length).toBeGreaterThanOrEqual(2);
  const next = sockets.at(-1);
  next.onopen();
  emit(next, { type: 'welcome', bootId: 'boot-1', sessionIds: [] });
  expect(location.reload).not.toHaveBeenCalled();
});

it('a restarted server (a new boot) reloads the page once', async () => {
  const { connect } = await import('../public/modules/ws.js');
  const state = await import('../public/modules/state.js');
  const { renderWaiting } = await import('../public/modules/waiting.js');
  const { renderBillionStatus } = await import('../public/modules/round.js');
  setup(connect, state, renderWaiting, renderBillionStatus);
  sockets[0].onopen();
  emit(sockets[0], { type: 'welcome', bootId: 'boot-1', sessionIds: [] });
  sockets[0].onclose({ code: 1006 });
  vi.advanceTimersByTime(1000);
  sockets[1].onopen();
  emit(sockets[1], { type: 'welcome', bootId: 'boot-2', sessionIds: [] });
  expect(location.reload).toHaveBeenCalledTimes(1);
});
