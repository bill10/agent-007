// WebSocket connection management
import { getToken, clearToken, showLogin, WS_UNAUTHORIZED } from './auth.js';

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let messageHandler = null;
let hasConnectedBefore = false;

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

  ws.onclose = (event) => {
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
    const msg = JSON.parse(event.data);
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
