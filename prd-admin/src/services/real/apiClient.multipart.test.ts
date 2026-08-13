import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiMultipartRequest } from './apiClient';

const { authState } = vi.hoisted(() => ({
  authState: {} as Record<string, unknown>,
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => authState },
}));

describe('apiMultipartRequest', () => {
  afterEach(() => {
    for (const key of Object.keys(authState)) delete authState[key];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('令牌过期时刷新一次并重建 FormData 后重试', async () => {
    vi.stubGlobal('window', {
      location: {
        origin: 'https://admin.example.test',
        hash: '',
        pathname: '/',
        href: '/',
      },
    });
    Object.assign(authState, {
      isAuthenticated: true,
      user: { userId: 'admin-1', username: 'admin', displayName: 'Admin', role: 'ADMIN' },
      token: 'expired-token',
      refreshToken: 'refresh-token',
      sessionKey: 'session-key',
      setTokens: (token: string, refreshToken: string, sessionKey: string) => {
        Object.assign(authState, { token, refreshToken, sessionKey });
      },
      logout: vi.fn(),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '登录状态已过期' },
      }), { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          accessToken: 'renewed-token',
          refreshToken: 'renewed-refresh-token',
          sessionKey: 'renewed-session-key',
        },
        error: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { avatarFileName: 'avatar.png' },
        error: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const bodies: FormData[] = [];

    const result = await apiMultipartRequest<{ avatarFileName: string }>('/api/profile/avatar/upload', {
      createFormData: () => {
        const body = new FormData();
        body.append('file', new Blob(['avatar'], { type: 'image/png' }), 'avatar.png');
        bodies.push(body);
        return body;
      },
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toBe(bodies[1]);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer expired-token' }),
      body: bodies[0],
    }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer renewed-token' }),
      body: bodies[1],
    }));
  });
});
