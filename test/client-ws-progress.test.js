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

it('clears active progress on socket loss, never invents an answer, and restores saved progress from fresh events', async () => {
  const { connect } = await import('../public/modules/ws.js');
  const state = await import('../public/modules/state.js');
  const { renderWaiting } = await import('../public/modules/waiting.js');
  const { renderBillionStatus } = await import('../public/modules/round.js');
  state.setWaitingActive(true);
  const receive = vi.fn(msg => {
    if (msg.type === 'billion-status') state.setBillionStatus(msg);
    if (msg.type === 'chat-list') state.setChatMessages(msg.messages);
    renderWaiting();
    renderBillionStatus();
  });
  connect(receive);
  const emit = (socket, data) => socket.onmessage({ data: JSON.stringify(data) });
  sockets[0].onopen();
  const messages = [{ id: 'm1', from: 'owner', text: 'Check the run', at: new Date().toISOString(), awaitsReply: true, workDetails: ['Checking evidence'] }];
  const status = { type: 'billion-status', running: true, working: true, pending: ['m1'], currentRequest: 'm1', progress: { m1: ['Checking evidence'] } };
  emit(sockets[0], { type: 'chat-list', messages });
  emit(sockets[0], status);
  expect(document.querySelector('.chat-progress.active')).not.toBeNull();

  receive.mockClear();
  sockets[0].onclose({ code: 1006 });
  expect(receive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'billion-status', disconnected: true, working: false, pending: [] }));
  expect(document.querySelector('.chat-progress')).toBeNull();
  expect(document.getElementById('billion-status').textContent).toBe('Reconnecting…');
  expect(state.chatMessages).toEqual(messages);
  expect(document.querySelector('.chat-work-details')).toBeNull();

  vi.advanceTimersByTime(1000);
  expect(sockets).toHaveLength(2);
  sockets[1].onopen();
  expect(location.reload).toHaveBeenCalledOnce();
  // A fresh page's handshake carries persisted chat before current status.
  emit(sockets[1], { type: 'chat-list', messages });
  emit(sockets[1], status);
  expect(document.querySelector('.chat-progress.active li').textContent).toBe('Checking evidence');
  expect(document.querySelector('.chat-work-details')).toBeNull();
});
