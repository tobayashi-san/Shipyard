import { getToken } from './auth';

type Listener = (data: unknown) => void;

class WsClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: number | null = null;
  private retryDelay = 1000;
  private closedByUser = false;

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    const tok = getToken();
    if (!tok) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(tok)}`;
    try {
      this.socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket.addEventListener('open', () => { this.retryDelay = 1000; });
    this.socket.addEventListener('message', (ev) => {
      let parsed: unknown = ev.data;
      try { parsed = JSON.parse(String(ev.data)); } catch { /* keep raw */ }
      this.listeners.forEach((l) => { try { l(parsed); } catch { /* swallow */ } });
    });
    this.socket.addEventListener('close', () => {
      this.socket = null;
      if (!this.closedByUser) this.scheduleReconnect();
    });
    this.socket.addEventListener('error', () => { try { this.socket?.close(); } catch { /* ignore */ } });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      this.connect();
    }, this.retryDelay);
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer != null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

export const ws = new WsClient();
