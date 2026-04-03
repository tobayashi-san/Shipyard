import { state } from './app/state.js';
import { api } from './api.js';

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const listeners = new Set();
let _onUnauthorized = null;

export function onWsUnauthorized(cb) { _onUnauthorized = cb; }

export function closeWebSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    ws.onclose = null; // prevent reconnect loop
    ws.onerror = null;
    ws.close();
    ws = null;
    state.ws = null;
  }
  reconnectDelay = 1000;
}

export function initWebSocket() {
  // Close any existing connection first to avoid duplicate connections on re-login
  closeWebSocket();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = api.getToken();
  const wsUrl = `${protocol}//${location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`;

  ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    reconnectDelay = 1000;
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      for (const listener of listeners) {
        listener(data);
      }
    } catch (e) {
      console.warn('WebSocket message parse error:', e);
    }
  };

  ws.onclose = (event) => {
    // 4001 = server rejected the token (unauthorized / revoked / setup required)
    if (event.code === 4001) {
      api.setToken(null);
      if (_onUnauthorized) _onUnauthorized();
      return; // do not reconnect
    }
    reconnectTimer = setTimeout(initWebSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  };

  ws.onerror = () => {
    ws.close();
  };
}

export function onWsMessage(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
