// WebSocket connection management
import { getToken, clearToken, showLogin, WS_UNAUTHORIZED } from './auth.js';

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let messageHandler = null;
let hasConnectedBefore = false;
// A socket half-dead after a network change can stay OPEN for minutes. The
// page pings every PING_MS and gives up on a ping left unanswered (by anything
// at all) for DEAD_MS, so the reconnect below runs. Judged by the ping, not by
// silence: a background tab's timers may run once a minute.
export const PING_MS = 15 * 1000;
export const DEAD_MS = 20 * 1000;
let pinger = null;
let lastHeard = 0;
let lastPing = 0;

export function connect(onMessage) {
  messageHandler = onMessage;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Browsers can't set handshake headers, so the token rides on the URL.
  const token = getToken();
  const query = token ? `/?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${protocol}//${location.host}${query}`);

  ws.onopen = () => {
    if (hasConnectedBefore) {
      // Server restarted, reload to get clean state
      location.reload();
      return;
    }
    hasConnectedBefore = true;
    document.getElementById('reconnecting').style.display = 'none';
    reconnectDelay = 1000;
  };

  lastHeard = lastPing = 0;
  clearInterval(pinger);
  pinger = setInterval(() => {
    const unanswered = lastPing > lastHeard;
    if (unanswered && Date.now() - lastPing > DEAD_MS) {
      // close() on a dead link waits out the closing handshake; go now.
      const dead = ws;
      ws = null;
      dead.onclose?.({ code: 1006 });
      dead.onopen = dead.onclose = dead.onmessage = null;
      try { dead.close(); } catch {}
    } else if (!unanswered && send({ type: 'ping' })) lastPing = Date.now();
  }, PING_MS);

  ws.onclose = (event) => {
    clearInterval(pinger);
    // Activity is unknown while disconnected. Clear live progress through the
    // existing status handler; the reconnect snapshot restores saved details.
    messageHandler?.({ type: 'billion-status', disconnected: true, running: false, working: false, awaitingReply: false, pending: [] });
    // 4401 = server requires auth and our token was missing/invalid. Don't
    // reconnect-loop; clear the bad token and prompt for a new one.
    if (event && event.code === WS_UNAUTHORIZED) {
      clearToken();
      showLogin();
      return;
    }
    document.getElementById('reconnecting').style.display = 'block';
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect(messageHandler);
    }, reconnectDelay);
  };

  ws.onmessage = (event) => {
    lastHeard = Date.now();
    const msg = JSON.parse(event.data);
    if (msg.type === 'pong') return;
    if (messageHandler) messageHandler(msg);
  };
}

export function send(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

export const connected = () => !!ws && ws.readyState === 1;
