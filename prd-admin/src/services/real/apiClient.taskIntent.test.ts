import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './apiClient';

vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: null }) } }));

describe('平台提交意图', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('两次明确的新操作采用不同意图，调用方提供的稳定标识保持不变', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: {}, error: null }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { origin: 'https://admin.example.test', pathname: '/', hash: '' } });
    await apiRequest('/future-operation', { method: 'POST', auth: false, body: { prompt: '同一文本' } });
    await apiRequest('/future-operation', { method: 'POST', auth: false, body: { prompt: '同一文本' } });
    const first = fetchMock.mock.calls[0][1].headers['Idempotency-Key'];
    const second = fetchMock.mock.calls[1][1].headers['Idempotency-Key'];
    expect(first).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    await apiRequest('/future-operation', { method: 'POST', auth: false, headers: { 'Idempotency-Key': 'explicit-intent' } });
    expect(fetchMock.mock.calls[2][1].headers['Idempotency-Key']).toBe('explicit-intent');
  });
});
