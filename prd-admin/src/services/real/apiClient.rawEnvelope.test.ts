import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './apiClient';

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
    // 就是 md-to-ppt 本地编辑那条端点的真实返回形状。
    const raw = { runId: 'run-2', parentRunId: 'run-1', html: '<html></html>', contentHash: 'h', unchanged: false };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const res = await apiRequest<typeof raw>('/api/md-to-ppt/runs/run-1/local-edit', { method: 'POST', body: {} });

    expect(res.success).toBe(true);
    expect(res.data).toEqual(raw);
    expect(res.error).toBeNull();
  });
});
