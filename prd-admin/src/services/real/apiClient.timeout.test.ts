import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './apiClient';

describe('apiRequest timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborts a request that never returns headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      location: { origin: 'https://example.test', hash: '', pathname: '/' },
    });
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));

    const request = apiRequest('/api/recording-timeout-test', {
      auth: false,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    const result = await request;
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('TIMEOUT');
  });

  it('keeps the timeout active while the response body is stalled', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      location: { origin: 'https://example.test', hash: '', pathname: '/' },
    });
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => Promise.resolve({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    } as Response)));

    const request = apiRequest('/api/recording-body-timeout-test', {
      auth: false,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    const result = await request;
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('TIMEOUT');
  });
});
