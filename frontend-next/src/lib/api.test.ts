import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiFetchArray, apiUploadFile } from './api';

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serializes JSON bodies and returns JSON responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch<{ ok: boolean }>('/ping', {
      method: 'POST', body: { enabled: true }, skipAuth: true,
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith('/api/ping', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    }));
  });

  it('attaches the selected environment to every request', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => key === 'shipyard_environment' ? 'production' : 'test-token'),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/servers');

    expect(fetchMock).toHaveBeenCalledWith('/api/servers', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Shipyard-Environment': 'production' }),
    }));
  });

  it('returns a typed error including the API message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Denied' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(apiFetch('/servers', { skipAuth: true })).rejects.toMatchObject({
      name: 'ApiError', status: 403, message: 'Denied',
    });
  });

  it('normalizes malformed collection responses to an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ stale: true }), {
      headers: { 'content-type': 'application/json' },
    })));

    await expect(apiFetchArray('/servers', { skipAuth: true })).resolves.toEqual([]);
  });
});

describe('apiUploadFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborts the browser request when its signal is canceled', async () => {
    class MockXMLHttpRequest {
      static latest: MockXMLHttpRequest;
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      onerror: ((event: ProgressEvent) => void) | null = null;
      onabort: ((event: ProgressEvent) => void) | null = null;
      onload: ((event: ProgressEvent) => void) | null = null;
      responseText = '';
      status = 0;
      abort = vi.fn(() => this.onabort?.({} as ProgressEvent));
      open = vi.fn();
      send = vi.fn();
      setRequestHeader = vi.fn();

      constructor() {
        MockXMLHttpRequest.latest = this;
      }
    }
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);
    const controller = new AbortController();

    const upload = apiUploadFile('/files/upload', new File(['large file'], 'large.bin'), undefined, controller.signal);
    controller.abort();

    await expect(upload).rejects.toMatchObject({ status: 499, message: 'Upload canceled' });
    expect(MockXMLHttpRequest.latest.abort).toHaveBeenCalledOnce();
  });
});
