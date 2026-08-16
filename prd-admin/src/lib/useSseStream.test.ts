import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authState: {
    token: 'expired-token' as string | null,
    isAuthenticated: true,
    logout: vi.fn(),
  },
  refresh: vi.fn(),
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: {
    getState: () => mocks.authState,
  },
}));

vi.mock('@/services/real/apiClient', () => ({
  tryRefreshAdminToken: mocks.refresh,
}));

import { connectSse } from '@/lib/useSseStream';

describe('connectSse 登录态恢复', () => {
  beforeEach(() => {
    mocks.authState.token = 'expired-token';
    mocks.authState.isAuthenticated = true;
    mocks.authState.logout.mockReset();
    mocks.refresh.mockReset();
    vi.unstubAllGlobals();
  });

  it('首次返回 401 时刷新令牌并用新令牌重连一次', async () => {
    mocks.refresh.mockImplementation(async () => {
      mocks.authState.token = 'renewed-token';
      return true;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('event: status\ndata: {"status":"completed"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const events: string[] = [];
    const result = await connectSse({
      url: '/api/profile/avatar/generations/run-1/events',
      onEvent: event => events.push(event.event ?? ''),
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer expired-token' });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer renewed-token' });
    expect(events).toEqual(['status']);
    expect(mocks.authState.logout).not.toHaveBeenCalled();
  });
});
