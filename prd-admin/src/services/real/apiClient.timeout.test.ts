import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, isSessionAuthenticationFailure } from './apiClient';
import { useAuthStore } from '@/stores/authStore';

describe('apiRequest timeout', () => {
  afterEach(() => {
    useAuthStore.setState({ isAuthenticated: false, user: null, token: null, refreshToken: null, sessionKey: null });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not clear an existing session when an unauthenticated exchange returns 401', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://example.test', hash: '', pathname: '/', href: '/current' },
    });
    useAuthStore.setState({
      isAuthenticated: true,
      user: { userId: 'admin-1', username: 'admin', displayName: 'Admin', role: 'ADMIN' },
      token: 'existing-token',
      refreshToken: 'existing-refresh',
      sessionKey: 'existing-session',
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 401,
      ok: false,
      statusText: 'Unauthorized',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '票据已失效，请重新获取后重试。' },
      }),
    } as Response)));

    const result = await apiRequest('/api/auth/synthetic-login/exchange', {
      method: 'POST',
      auth: false,
      body: { code: 'expired-code' },
    });

    expect(result.success).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().token).toBe('existing-token');
    expect(window.location.href).toBe('/current');
  });

  it('keeps the current user session when a service credential returns a classified 401', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://example.test', hash: '', pathname: '/', href: '/authorization-health' },
    });
    useAuthStore.setState({
      isAuthenticated: true,
      user: { userId: 'admin-1', username: 'admin', displayName: 'Admin', role: 'ADMIN' },
      token: 'existing-token',
      refreshToken: 'existing-refresh',
      sessionKey: 'existing-session',
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 401,
      ok: false,
      statusText: 'Unauthorized',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        success: false,
        data: null,
        error: { code: 'AUTH_AI_KEY_INVALID', message: '自动化访问凭据与当前环境不一致。' },
      }),
    } as Response)));

    const result = await apiRequest('/api/automation-probe');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('AUTH_AI_KEY_INVALID');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().token).toBe('existing-token');
    expect(window.location.href).toBe('/authorization-health');
  });

  it('classifies only session failures as logout-worthy', () => {
    expect(isSessionAuthenticationFailure(401, 'AUTH_SESSION_REVOKED')).toBe(true);
    expect(isSessionAuthenticationFailure(401, 'AUTH_AI_KEY_INVALID')).toBe(false);
    expect(isSessionAuthenticationFailure(401, 'AUTH_AGENT_KEY_INVALID')).toBe(false);
    expect(isSessionAuthenticationFailure(401)).toBe(true);
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
