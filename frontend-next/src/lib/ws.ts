import { getToken } from './auth';

type Listener = (data: unknown) => void;

class WsClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: number | null = null;
  private retryDelay = 1000;
  private closedByUser = false;
  private environmentId = '';

  connect(): void {
    let environmentId = 'default';
    try { environmentId = localStorage.getItem('shipyard_environment') || 'default'; } catch { /* use default */ }
    if (this.socket && this.environmentId === environmentId && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    if (this.socket) { try { this.socket.close(); } catch { /* ignore */ } this.socket = null; }
    this.environmentId = environmentId;
    this.closedByUser = false;
    const tok = getToken();
    if (!tok) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(tok)}&environment=${encodeURIComponent(environmentId)}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
      this.socket = socket;
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.addEventListener('open', () => {
      if (this.socket === socket) this.retryDelay = 1000;
    });
    socket.addEventListener('message', (ev) => {
      if (this.socket !== socket) return;
      let parsed: unknown = ev.data;
      try { parsed = JSON.parse(String(ev.data)); } catch { /* keep raw */ }
      this.listeners.forEach((l) => { try { l(parsed); } catch { /* swallow */ } });
    });
    socket.addEventListener('close', () => {
      // A close event from the superseded environment socket may arrive after
      // its replacement is already connected. It must never clear or restart
      // that newer connection.
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.closedByUser) this.scheduleReconnect();
    });
    socket.addEventListener('error', () => { try { socket.close(); } catch { /* ignore */ } });
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

  setEnvironment(environmentId: string): void {
    if (environmentId === this.environmentId) return;
    const shouldReconnect = Boolean(this.socket) || this.reconnectTimer != null;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.environmentId = '';
    if (this.socket) { try { this.socket.close(); } catch { /* ignore */ } this.socket = null; }
    if (shouldReconnect) this.connect();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

export const ws = new WsClient();
