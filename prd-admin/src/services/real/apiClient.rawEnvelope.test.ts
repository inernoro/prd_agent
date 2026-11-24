import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadReportImageForm } from './reportAgent';
import { apiDownload, apiMultipartRequest, apiRequest, tryRefreshAdminToken } from './apiClient';

const { authState } = vi.hoisted(() => ({
  authState: {} as Record<string, unknown>,
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => authState },
}));

/**
 * apiRequest 对「2xx + 裸对象」是宽容的：最后一支兜底把它当 data 包成成功信封。
 *
 * 这条用例是为了钉住一个**否定结论**（Codex P1，2026-09-15）：复审说本地编辑保存会被
 * 判成「服务返回格式异常」，据此要求后端两处成功返回改包 ApiResponse.Ok。核对下来那句
 * 文案属于 apiMultipartRequest 那一支（FormData 上传），而本地编辑走的是 apiRequest，
 * 两支的兜底行为相反。没有这条用例，这个结论就只是一句「我读过代码」。
 *
 * 它同时是一道护栏：哪天真把 apiRequest 收严成只认信封，这里会先红，提醒去改那一批
 * 返回裸对象的端点，而不是让用户在页面上撞见「格式异常」。
 */
describe('apiRequest 对非信封 2xx 的兜底', () => {
  afterEach(() => {
    for (const key of Object.keys(authState)) delete authState[key];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('2xx 返回裸对象时按 data 收下，不判成格式异常', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://admin.example.test', hash: '', pathname: '/', href: '/' },
    });
    Object.assign(authState, {
      isAuthenticated: true,
      user: { userId: 'u-1', username: 'u', displayName: 'U', role: 'ADMIN' },
      token: 'token',
      logout: vi.fn(),
    });
    // 某些兼容端点仍返回裸对象，客户端必须按 data 收下。
    const raw = { runId: 'run-2', parentRunId: 'run-1', html: '<html></html>', contentHash: 'h', unchanged: false };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const res = await apiRequest<typeof raw>('/api/compatibility/raw-envelope', { method: 'POST', body: {} });

    expect(res.success).toBe(true);
    expect(res.data).toEqual(raw);
    expect(res.error).toBeNull();
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function envelope(status = 200, code = 'UNAUTHORIZED') {
  return new Response(JSON.stringify(status === 200
    ? { success: true, data: { value: 'done' }, error: null }
    : { success: false, data: null, error: { code, message: 'failure' } }),
  { status, headers: { 'content-type': 'application/json' } });
}
function refreshResponse(name: string) {
  return new Response(JSON.stringify({ success: true, data: {
    accessToken: `${name}-rotated`, refreshToken: `${name}-refresh-rotated`, sessionKey: `${name}-key-rotated`,
  }, error: null }), { status: 200 });
}
function login(name: string, epoch: number) {
  Object.assign(authState, {
    authSessionEpoch: epoch, isAuthenticated: true, user: { userId: name },
    token: `${name}-token`, refreshToken: `${name}-refresh`, sessionKey: `${name}-key`,
    logout: vi.fn(),
    setTokens: vi.fn((token, refreshToken, sessionKey) => Object.assign(authState, { token, refreshToken, sessionKey })),
  });
}
const transports = [
  { name: 'JSON', run: () => apiRequest('/api/write', { method: 'POST', body: { value: 'A' } }) },
  { name: 'multipart', run: () => apiMultipartRequest('/api/write', { createFormData: () => new FormData() }) },
  { name: 'download', run: async () => {
    try { return { ...await apiDownload('/api/write', 'file.txt'), error: null }; }
    catch (error) { return { error }; }
  } },
];

describe('认证刷新按发起会话隔离', () => {
  afterEach(() => {
    for (const key of Object.keys(authState)) delete authState[key];
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  function setup() {
    vi.stubGlobal('window', { location: { origin: 'https://admin.example.test', hash: '', pathname: '/', href: '/' } });
    login('A', 1);
  }

  it('迟到的 A refresh 不覆盖 B 的凭据', async () => {
    setup();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
    const refresh = tryRefreshAdminToken();
    login('B', 2);
    const setTokens = authState.setTokens;
    pending.resolve(refreshResponse('A'));
    expect(await refresh).toBe(false);
    expect(setTokens).not.toHaveBeenCalled();
    expect(authState.token).toBe('B-token');
  });

  it.each(['token', 'refreshToken', 'sessionKey', 'user'])('同 epoch 的 %s 变化也阻止旧刷新写入', async (field) => {
    setup();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
    const refresh = tryRefreshAdminToken();
    authState[field] = field === 'user' ? { userId: 'B' } : 'changed';
    pending.resolve(refreshResponse('A'));
    expect(await refresh).toBe(field === 'token');
    expect(authState.setTokens).not.toHaveBeenCalled();
  });

  it('新 epoch 独立刷新，旧 finally 不清除新会话正在共享的刷新', async () => {
    setup();
    const first = deferred<Response>(); const second = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetch);
    const a = tryRefreshAdminToken();
    login('B', 2);
    const b = tryRefreshAdminToken();
    first.resolve(refreshResponse('A'));
    expect(await a).toBe(false);
    const bConcurrent = tryRefreshAdminToken();
    expect(fetch).toHaveBeenCalledTimes(2);
    second.resolve(refreshResponse('B'));
    expect(await b).toBe(true); expect(await bConcurrent).toBe(true);
    expect(authState.token).toBe('B-rotated');
    expect(authState.setTokens).toHaveBeenCalledTimes(1);
  });

  it('同会话并发 401 只刷新一次，双方重放均用旋转后凭据', async () => {
    setup(); const refresh = deferred<Response>(); const started = deferred<void>();
    const fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (String(init?.body).includes('refreshToken')) { started.resolve(); return refresh.promise; }
      return Promise.resolve(init?.headers && (init.headers as Record<string, string>).Authorization === 'Bearer A-rotated'
        ? envelope() : envelope(401));
    });
    vi.stubGlobal('fetch', fetch);
    const first = apiRequest('/api/write', { method: 'POST', body: { value: 'first' } });
    const second = apiRequest('/api/write', { method: 'POST', body: { value: 'second' } });
    await started.promise; await Promise.resolve();
    refresh.resolve(refreshResponse('A'));
    expect((await first).success).toBe(true); expect((await second).success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(5); expect(authState.setTokens).toHaveBeenCalledTimes(1);
  });

  it('auth:false 请求不随账号切换失败，也不触发认证恢复', async () => {
    setup(); const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal('fetch', fetch);
    const result = apiRequest('/api/public', { auth: false }); login('B', 2); pending.resolve(envelope());
    expect((await result).success).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it.each(['first', 'refresh', 'replay'])('报表上传在 %s 阶段切号不写凭据、不重发旧文件', async (stage) => {
    setup(); const pending = deferred<Response>(); const started = deferred<void>();
    const fetch = vi.fn();
    if (stage === 'first') fetch.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    if (stage === 'refresh') fetch.mockResolvedValueOnce(envelope(401))
      .mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    if (stage === 'replay') fetch.mockResolvedValueOnce(envelope(401)).mockResolvedValueOnce(refreshResponse('A'))
      .mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    fetch.mockResolvedValue(envelope()); vi.stubGlobal('fetch', fetch);
    const result = uploadReportImageForm('/api/report/image', new Blob(['A-file']) as File);
    await started.promise; login('B', 2);
    pending.resolve(stage === 'refresh' ? refreshResponse('A') : envelope(401));
    expect((await result).error).toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    expect(authState.token).toBe('B-token'); expect(authState.setTokens).not.toHaveBeenCalled();
    expect(authState.logout).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(stage === 'first' ? 1 : stage === 'refresh' ? 2 : 3);
  });

  it('报表上传与普通 API 共享同会话刷新并保留文件重放', async () => {
    setup(); const refresh = deferred<Response>(); const started = deferred<void>();
    const fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (String(init?.body).includes('refreshToken')) { started.resolve(); return refresh.promise; }
      return Promise.resolve((init?.headers as Record<string, string>).Authorization === 'Bearer A-rotated'
        ? envelope() : envelope(401));
    });
    vi.stubGlobal('fetch', fetch);
    const upload = uploadReportImageForm('/api/report/image', new Blob(['A-file']) as File);
    const request = apiRequest('/api/write', { method: 'POST', body: {} });
    await started.promise; await Promise.resolve(); refresh.resolve(refreshResponse('A'));
    expect((await upload).success).toBe(true); expect((await request).success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(5); expect(authState.setTokens).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter((call) => call[0] === '/api/report/image').map((call) => call[1].body))
      .toEqual([expect.any(FormData), expect.any(FormData)]);
  });

  for (const transport of [...transports, {
    name: 'report upload', run: () => uploadReportImageForm('/api/report/image', new Blob(['A-file']) as File),
  }]) {
    it.each(['success', 'failure', 'network'])(`${transport.name}：改密已旋转凭据后旧 refresh %s 不覆盖、不退出，使用当前 token 重试一次`, async (outcome) => {
      setup(); const refresh = deferred<Response>(); const started = deferred<void>();
      const fetch = vi.fn().mockResolvedValueOnce(envelope(401))
        .mockImplementationOnce(() => { started.resolve(); return refresh.promise; }).mockResolvedValue(envelope());
      vi.stubGlobal('fetch', fetch);
      const result = transport.run(); await started.promise;
      // AccountSettings 改密成功调用同一 setTokens；合法旋转保持登录 epoch。
      (authState.setTokens as (token: string, refreshToken: string, sessionKey: string) => void)(
        'password-token', 'password-refresh', 'password-key');
      if (outcome === 'network') refresh.reject(new Error('Failed to fetch'));
      else refresh.resolve(outcome === 'success' ? refreshResponse('A') : envelope(401));
      expect((await result).error ?? null).toBeNull();
      expect(authState.token).toBe('password-token'); expect(authState.refreshToken).toBe('password-refresh');
      expect(authState.sessionKey).toBe('password-key'); expect(authState.authSessionEpoch).toBe(1);
      expect(authState.setTokens).toHaveBeenCalledTimes(1); expect(authState.logout).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer password-token');
    });
  }

  for (const transport of transports) {
    it.each([false, true])(`${transport.name}：A 的迟到 401/网络失败在切号后不刷新、不退出 B（网络失败=%s）`, async (networkFailure) => {
      setup();
      const pending = deferred<Response>();
      const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(envelope());
      vi.stubGlobal('fetch', fetch);
      const result = transport.run();
      login('B', 2);
      if (networkFailure) pending.reject(new Error('Failed to fetch')); else pending.resolve(envelope(401));
      expect((await result).error).toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(authState.logout).not.toHaveBeenCalled();
    });

    it.each([true, false])(`${transport.name}：A 刷新期间切号，不重放旧请求、不退出 B（刷新成功=%s）`, async (success) => {
      setup();
      const refresh = deferred<Response>(); const started = deferred<void>();
      const fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.body && String(init.body).includes('refreshToken')) { started.resolve(); return refresh.promise; }
        return Promise.resolve(envelope(401));
      });
      vi.stubGlobal('fetch', fetch);
      const result = transport.run(); await started.promise;
      login('B', 2);
      refresh.resolve(success ? refreshResponse('A') : envelope(401));
      expect((await result).error).toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(authState.logout).not.toHaveBeenCalled();
      expect(authState.setTokens).not.toHaveBeenCalled();
    });

    it(`${transport.name}：同用户退出重登推进 epoch，拒绝旧响应 ABA`, async () => {
      setup(); const pending = deferred<Response>();
      const fetch = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal('fetch', fetch);
      const result = transport.run(); login('A', 3); pending.resolve(envelope(401));
      expect((await result).error).toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      expect(fetch).toHaveBeenCalledTimes(1); expect(authState.logout).not.toHaveBeenCalled();
    });

    it(`${transport.name}：重放后的迟到 401 也不能登出 B`, async () => {
      setup(); const replay = deferred<Response>(); const started = deferred<void>();
      const fetch = vi.fn().mockResolvedValueOnce(envelope(401))
        .mockResolvedValueOnce(refreshResponse('A')).mockImplementationOnce(() => { started.resolve(); return replay.promise; });
      vi.stubGlobal('fetch', fetch);
      const result = transport.run(); await started.promise; login('B', 2); replay.resolve(envelope(401));
      expect((await result).error).toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      expect(authState.logout).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each([[401, 'GITHUB_UNAUTHORIZED'], [403, 'PERMISSION_DENIED'], [500, 'INTERNAL_ERROR']])(
      `${transport.name}：上游或非会话错误 %s/%s 不刷新不退出`, async (status, code) => {
        setup(); const fetch = vi.fn().mockResolvedValue(envelope(status as number, code as string));
        vi.stubGlobal('fetch', fetch);
        expect((await transport.run()).error).toMatchObject({ code });
        expect(fetch).toHaveBeenCalledTimes(1); expect(authState.logout).not.toHaveBeenCalled();
      });

    it(`${transport.name}：同一会话刷新失败仅退出一次`, async () => {
      setup(); const fetch = vi.fn().mockResolvedValue(envelope(401)); vi.stubGlobal('fetch', fetch);
      const logout = authState.logout;
      await transport.run();
      expect(fetch).toHaveBeenCalledTimes(2); expect(logout).toHaveBeenCalledTimes(1);
    });

    it(`${transport.name}：有效旋转后使用新 token 重放一次`, async () => {
      setup();
      const fetch = vi.fn().mockResolvedValueOnce(envelope(401))
        .mockResolvedValueOnce(refreshResponse('A')).mockResolvedValueOnce(envelope());
      vi.stubGlobal('fetch', fetch);
      const result = await transport.run();
      expect(result.error ?? null).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer A-rotated');
      expect(authState.logout).not.toHaveBeenCalled();
    });
  }
});
