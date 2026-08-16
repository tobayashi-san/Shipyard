import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  close() {
    this.readyState = 3;
  }

  emit(type: string, event: { data?: string } = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

describe('WsClient environment switching', () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('ignores a delayed close event from the superseded environment socket', async () => {
    let environment = 'production';
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => key === 'shipyard_environment' ? environment : 'token'),
    });
    vi.stubGlobal('window', {
      location: { protocol: 'https:', host: 'fleet.example' },
      setTimeout: vi.fn(),
    });
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const { ws } = await import('./ws');
    const messages: unknown[] = [];
    ws.subscribe(message => messages.push(message));
    ws.connect();
    const oldSocket = FakeWebSocket.instances[0];

    environment = 'staging';
    ws.setEnvironment('staging');
    const newSocket = FakeWebSocket.instances[1];
    oldSocket.emit('close');
    newSocket.emit('message', { data: JSON.stringify({ type: 'cache_updated' }) });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(messages).toEqual([{ type: 'cache_updated' }]);
  });
});
