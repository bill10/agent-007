// WebSocket connection management
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let messageHandler = null;
let hasConnectedBefore = false;

export function connect(onMessage) {
  messageHandler = onMessage;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

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

  ws.onclose = () => {
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
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
