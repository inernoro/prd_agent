import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiDownload, resolveApiUrl } from './apiClient';

const { authState } = vi.hoisted(() => ({
  authState: {} as Record<string, unknown>,
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => authState },
}));

describe('apiDownload', () => {
  afterEach(() => {
    for (const key of Object.keys(authState)) delete authState[key];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('原生下载地址复用带路径前缀的独立 API 基址', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/platform/');

    expect(resolveApiUrl('/api/video-download'))
      .toBe('https://api.example.test/platform/api/video-download');
  });

  it('访问令牌过期时刷新一次并用新令牌重试下载', async () => {
    vi.stubGlobal('window', {
      location: {
        origin: 'https://admin.example.test',
        hash: '',
        pathname: '/visual-agent/workspace-1',
        href: '/visual-agent/workspace-1',
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
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          accessToken: 'renewed-token',
          refreshToken: 'renewed-refresh-token',
          sessionKey: 'renewed-session-key',
        },
        error: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Blob(['image-bytes'], { type: 'image/png' }), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-disposition': 'attachment; filename="generated.png"',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiDownload('/api/visual-agent/image-gen/download?url=test', 'fallback.png');

    expect(result.contentType).toBe('image/png');
    expect(result.fileName).toBe('generated.png');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer expired-token' }),
    }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer renewed-token' }),
    }));
  });
});
