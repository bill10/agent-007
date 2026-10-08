// @vitest-environment happy-dom
// A slow or dropped link (remote, over a relay): the box's send outlasts its
// timeout, the socket's heartbeat, the draft across the reconnect's reload,
// and the stalled badge fed by pty-activity for a terminal not on screen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const DOM = '<div id="reconnecting"></div><div id="terminal-tabs"></div><div id="terminal-empty"></div><div id="job-board"></div>'
  + '<div id="waiting-board" style="display:none"><div id="waiting-list"></div></div>';

// A fresh page: modules as a reload would load them, with ws.js stubbed.
async function page({ up = true } = {}) {
  vi.resetModules();
  const link = { up };
  const send = vi.fn(() => link.up);
  vi.doMock('../public/modules/ws.js', () => ({ send, connected: () => link.up }));
  document.body.innerHTML = DOM;
  const state = await import('../public/modules/state.js');
  const waiting = await import('../public/modules/waiting.js');
  state.agents.set('b', { isBillion: true });
  waiting.showWaiting();
  return { link, send, state, waiting };
}
const input = () => document.getElementById('chat-input');
const error = () => document.getElementById('chat-error');
const type = (text) => {
  input().value = text;
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
};
const owner = (nonce, text) => ({ id: `m-${nonce}`, from: 'owner', via: 'app', text, at: new Date().toISOString(), utterance: `chat-${nonce}` });

beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.doUnmock('../public/modules/ws.js'); });

describe('a send on a slow link', () => {
  it('keeps waiting while the socket is up, and a late chat-sent still finishes it', async () => {
    const { send, waiting } = await page();
    type('hello');
    const { nonce } = send.mock.calls[0][0];
    vi.advanceTimersByTime(60_000);
    expect(error().hidden).toBe(true);
    expect(document.getElementById('chat-send').disabled).toBe(true);
    waiting.handleChatSent({ nonce });
    expect(input().value).toBe('');
  });

  it('takes the message arriving in the thread as sent', async () => {
    const { send, waiting } = await page();
    type('hello');
    const { nonce } = send.mock.calls[0][0];
    waiting.handleChatMessage(owner(nonce, 'hello'));
    expect(input().value).toBe('');
    expect(document.getElementById('chat-send').disabled).toBe(false);
  });

  it('says so when the socket dropped, keeps the text, and sends it again under the same nonce', async () => {
    const { send, link, waiting } = await page();
    type('hello');
    const first = send.mock.calls[0][0].nonce;
    link.up = false;
    vi.advanceTimersByTime(20_000);
    expect(error().textContent).toBe('Not sent: connection dropped.');
    expect(input().value).toBe('hello');
    link.up = true;
    type('hello');
    expect(send.mock.calls[1][0].nonce).toBe(first);   // the server takes it as the one already in
    waiting.handleChatSent({ nonce: first });
    type('hello again');
    expect(send.mock.calls[2][0].nonce).not.toBe(first);
  });
});

describe('the draft across the reconnect reload', () => {
  it('brings back the text and files, and clears them once the thread shows the send went in', async () => {
    const first = await page();
    first.waiting.attachFiles([new File(['xyz'], 'a.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => {
      type('did it go?');
      expect(first.send).toHaveBeenCalled();
    });
    const { nonce } = first.send.mock.calls[0][0];
    window.dispatchEvent(new Event('pagehide'));

    const second = await page();
    expect(input().value).toBe('did it go?');
    expect(document.querySelectorAll('#chat-files .chat-file-chip')).toHaveLength(1);
    second.state.setChatMessages([owner(nonce, 'did it go?')]);
    second.waiting.settleFromThread();
    expect(input().value).toBe('');
    expect(document.querySelectorAll('#chat-files .chat-file-chip')).toHaveLength(0);
  });

  it('says it was not sent when the thread lacks it, and a resend keeps the nonce', async () => {
    const first = await page();
    type('lost?');
    const { nonce } = first.send.mock.calls[0][0];
    window.dispatchEvent(new Event('pagehide'));

    const second = await page();
    second.state.setChatMessages([]);
    second.waiting.settleFromThread();
    expect(error().textContent).toBe('Not sent: connection dropped.');
    type('lost?');
    expect(second.send.mock.calls[0][0].nonce).toBe(nonce);
  });

  it('keeps a plain draft that was never sent', async () => {
    await page();
    input().value = 'half a thought';
    window.dispatchEvent(new Event('pagehide'));
    await page();
    expect(input().value).toBe('half a thought');
    expect(error().hidden).toBe(true);
  });
});

describe('the socket heartbeat', () => {
  it('pings, and drops a socket that has gone quiet so the reconnect runs', async () => {
    vi.resetModules();
    vi.doUnmock('../public/modules/ws.js');
    const sockets = [];
    vi.stubGlobal('WebSocket', class {
      constructor() { this.readyState = 1; this.send = vi.fn(); this.close = vi.fn(); sockets.push(this); }
    });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', reload: vi.fn() });
    document.body.innerHTML = DOM;
    const { connect, connected, PING_MS, DEAD_MS } = await import('../public/modules/ws.js');
    const heard = vi.fn();
    connect(heard);
    sockets[0].onopen();
    vi.advanceTimersByTime(PING_MS);
    expect(sockets[0].send).toHaveBeenCalledWith('{"type":"ping"}');
    sockets[0].onmessage({ data: '{"type":"pong"}' });
    expect(heard).not.toHaveBeenCalled();   // answered here, not by the app
    expect(connected()).toBe(true);

    // A background tab's timers run once a minute: a long quiet gap with
    // every ping answered is not a dead socket.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    vi.advanceTimersByTime(PING_MS);
    expect(sockets[0].send).toHaveBeenCalledTimes(2);
    expect(connected()).toBe(true);

    // That ping goes unanswered: dropped, and the reconnect runs.
    vi.advanceTimersByTime(2 * PING_MS);   // the second tick finds it past DEAD_MS
    expect(connected()).toBe(false);
    expect(sockets[0].close).toHaveBeenCalled();
    expect(document.getElementById('reconnecting').style.display).toBe('block');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});

describe('a terminal not on screen', () => {
  it('feeds the stalled badge from pty-activity, and a replay is not activity', async () => {
    vi.resetModules();
    vi.doMock('../public/modules/ws.js', () => ({ send: vi.fn(() => true), connected: () => true }));
    const { agents } = await import('../public/modules/state.js');
    const { handlePtyActivity, handlePtyOutput } = await import('../public/modules/terminal.js');
    const term = { write: vi.fn(), reset: vi.fn() };
    const stale = Date.now() - 4 * 60 * 1000;   // past STALLED_AFTER_MS
    agents.set('s1', { state: 'WAITING', lastOutputAt: stale, term });

    handlePtyOutput({ sessionId: 's1', data: btoa('old screen'), replay: true, reset: true });
    handlePtyOutput({ sessionId: 's1', data: btoa('more of it'), replay: true });   // a long scrollback's next chunk
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(agents.get('s1').lastOutputAt).toBe(stale);

    handlePtyActivity({ sessionId: 's1' });
    expect(Date.now() - agents.get('s1').lastOutputAt).toBeLessThan(1000);
    handlePtyOutput({ sessionId: 's1', data: btoa('new') });
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(() => handlePtyActivity({ sessionId: 'gone' })).not.toThrow();
  });
});
