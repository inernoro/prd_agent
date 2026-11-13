// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportTeamShareViewPage from '../ReportTeamShareViewPage';
import { useAuthStore } from '@/stores/authStore';

const mocks = vi.hoisted(() => ({ view: vi.fn() }));
vi.mock('@/services', () => ({ viewTeamWeekShare: mocks.view }));
vi.mock('@/components/ui/MermaidDiagram', () => ({ MermaidDiagram: () => null }));
const user = { userId: 'author', username: 'author', displayName: '作者', role: 'ADMIN' as const };
const sharePath = '/s/report-team/session-fixture?week=46';
const success = { success: true, error: null, data: {
  team: { id: 'team', name: '恢复后的团队' }, weekYear: 2026, weekNumber: 46,
  periodStart: '2026-11-09', periodEnd: '2026-11-15', stats: { totalMembers: 0, submittedCount: 0, pendingCount: 0 },
  items: [], summary: null, shareInfo: { createdBy: 'author', createdByName: '作者', createdAt: '2026-11-13', isTeamMember: true },
} };
function LoginProbe() {
  const authed = useAuthStore(state => state.isAuthenticated), location = useLocation(), navigate = useNavigate();
  const returnUrl = new URLSearchParams(location.search).get('returnUrl') || '/';
  useEffect(() => { if (authed) navigate(returnUrl, { replace: true }); }, [authed, navigate, returnUrl]);
  return <><div>登录恢复入口</div><code>{location.search}</code><button onClick={() => { useAuthStore.getState().login(user, 'renewed-local-test-token');navigate(new URLSearchParams(location.search).get('returnUrl') || '/'); }}>完成登录</button></>;
}
function mount() {
  const container = document.createElement('div'); document.body.append(container);const root = createRoot(container);
  const element = <MemoryRouter initialEntries={[sharePath]}><Routes><Route path="/s/report-team/:token" element={<ReportTeamShareViewPage />} /><Route path="/login" element={<LoginProbe />} /></Routes></MemoryRouter>;
  return { container, root, element };
}
afterEach(() => { useAuthStore.setState({ isAuthenticated: false, user: null, token: null, refreshToken: null, sessionKey: null });document.body.replaceChildren();document.documentElement.removeAttribute('data-theme');vi.unstubAllGlobals();vi.clearAllMocks(); });

describe('独立团队分享的登录与密码恢复', () => {
  it.each([
    { code: 'AUTH_SESSION_REQUIRED', authed: false },
    { code: 'AUTH_SESSION_INVALID', authed: true },
    { code: 'AUTH_SESSION_REVOKED', authed: true },
    { code: 'UNAUTHORIZED', authed: false },
  ])('$code、已登录=$authed：显示登录恢复并可回到原分享', async ({ code, authed }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);const fetchSpy = vi.fn();vi.stubGlobal('fetch', fetchSpy);
    useAuthStore.setState({ isAuthenticated: authed, user: authed ? user : null, token: authed ? 'stale-local-test-token' : null, refreshToken: authed ? 'stale-refresh' : null, sessionKey: authed ? 'stale-session' : null });
    mocks.view.mockResolvedValue(success).mockResolvedValueOnce({ success: false, data: null, error: { code, message: '登录状态缺失，请登录后重试。' } });
    const { container, root, element } = mount();
    try {
      await act(async () => root.render(element));
      const login = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '前往登录');expect(login).toBeDefined();
      await act(async () => login!.click());
      expect(container.textContent).toContain('登录恢复入口');
      const params = new URLSearchParams(container.querySelector('code')!.textContent!);expect(params.get('returnUrl')).toBe(sharePath);
      expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, token: null, refreshToken: null, sessionKey: null });expect(fetchSpy).not.toHaveBeenCalled();
      await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '完成登录')!.click());
      expect(container.textContent).toContain('恢复后的团队');
    } finally { await act(async () => root.unmount()); }
  });

  it('已登录的业务UNAUTHORIZED保留密码入口和有效本地会话', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);useAuthStore.setState({ isAuthenticated: true, user, token: 'valid-local-test-token' });
    mocks.view.mockResolvedValue({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: '请输入正确访问密码' } });
    const { container, root, element } = mount();
    try {
      await act(async () => root.render(element));expect(container.querySelector('input[type="password"]')).not.toBeNull();
      expect(container.textContent).not.toContain('前往登录');expect(useAuthStore.getState().token).toBe('valid-local-test-token');expect(useAuthStore.getState().isAuthenticated).toBe(true);
    } finally { await act(async () => root.unmount()); }
  });

  it('NETWORK_ERROR仍提供重试，不当作会话失效或密码拒绝', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);useAuthStore.setState({ isAuthenticated: true, user, token: 'valid-local-test-token' });
    mocks.view.mockResolvedValue({ success: false, data: null, error: { code: 'NETWORK_ERROR', message: '网络请求失败' } });
    const { container, root, element } = mount();
    try {
      await act(async () => root.render(element));expect(container.textContent).toContain('网络请求失败');expect(container.textContent).not.toContain('前往登录');expect(container.querySelector('input[type="password"]')).toBeNull();
      await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '重新加载')!.click());expect(mocks.view).toHaveBeenCalledTimes(2);expect(useAuthStore.getState().token).toBe('valid-local-test-token');
    } finally { await act(async () => root.unmount()); }
  });
});
