import { useEntrySkinStore } from '@/stores/entrySkinStore';
// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './LoginPage';
import { useAuthStore } from '@/stores/authStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router-dom', async (original) => ({ ...await original<typeof import('react-router-dom')>(), useNavigate: () => navigation.navigate }));
const api = vi.hoisted(() => ({ login: vi.fn(), getSsoOptions: vi.fn(), getAdminAuthzMe: vi.fn(), loginWithMiduoPlanetToken: vi.fn(), resetPassword: vi.fn() }));
vi.mock('@/services', () => api);
vi.mock('@/stores/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create((set) => ({
    isAuthenticated: false,
    login: () => set({ isAuthenticated: true }),
    setTokens: vi.fn(), setPermissions: vi.fn(), setPermissionsLoaded: vi.fn(), setCdnBaseUrl: vi.fn(),
    logout: () => set({ isAuthenticated: false }),
  })) };
});
vi.mock('@/components/effects/entryMotion', () => ({ prepareEntryScene: () => Promise.resolve(), profileEntryMotion: vi.fn(), enterWorkspace: (commit: () => void) => commit() }));
vi.mock('@/pages/home/components/Reveal', () => ({ Reveal: ({ children }: { children: ReactNode }) => children }));
let host: HTMLDivElement;
let root: Root;
async function mount() { await act(async () => { root.render(<MemoryRouter><LoginPage /></MemoryRouter>); }); }
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ isAuthenticated: false });
  sessionStorage.clear();
  useEntrySkinStore.setState({ skin: 'companion' });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  api.getSsoOptions.mockResolvedValue({ success: true, data: { items: [], passwordLoginDisabled: false } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.documentElement.removeAttribute('data-theme'); });

describe('电影式登录真实表单交互', () => {
  it('未开启皮肤时没有角色扫描，鉴权通过直接导航', async () => {
    useEntrySkinStore.setState({ skin: 'standard' });
    api.login.mockResolvedValue({ success: true, data: { user: { username: 'admin' }, accessToken: 'test-token', refreshToken: '', sessionKey: '' } });
    api.getAdminAuthzMe.mockResolvedValue({ success: true, data: { effectivePermissions: ['admin.access'] } });
    await mount();
    expect(host.querySelector('.consciousness-scene')).toBeNull();
    expect(host.querySelector('.identity-scanner')).toBeNull();
    expect(host.querySelector('details')?.textContent).toContain('部署环境安全注入');
    await fill(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, 'sample-secret');
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '开始身份确认')!.click());
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith('/', { replace: true });
    expect(host.textContent).not.toContain('核验通过');
  });
  it('空密码不可提交，密码可通过键盘访问显隐并保留输入', async () => {
    await mount();
    expect([...host.querySelectorAll('button')].find(b => b.textContent === '开始身份确认')?.disabled).toBe(true);
    const password = host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
    await fill(password, 'sample-secret');
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="显示密码"]')!;
    expect(toggle.tabIndex).toBe(0);
    await act(async () => toggle.click());
    expect(password.type).toBe('text'); expect(password.value).toBe('sample-secret');
    expect(host.querySelector('[aria-label="隐藏密码"]')).not.toBeNull();
  });
  it('提交期间扫描对应实际请求状态，失败恢复按钮并播报错误', async () => {
    let rejectLogin!: (value: unknown) => void;
    api.login.mockImplementation(() => new Promise(resolve => { rejectLogin = resolve; }));
    await mount();
    await fill(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, 'sample-secret');
    const submit = [...host.querySelectorAll('button')].find(b => b.textContent === '开始身份确认')!;
    await act(async () => submit.click());
    expect(api.login).toHaveBeenCalledWith('admin', 'sample-secret');
    expect(host.querySelector('[data-busy="true"]')).not.toBeNull(); expect(submit.disabled).toBe(true);
    await act(async () => rejectLogin({ success: false, error: { message: '账号或密码不正确，请重试' } }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('账号或密码不正确');
    expect(host.querySelector('[data-busy="false"]')).not.toBeNull(); expect(submit.disabled).toBe(false);
  });
  it('仅 SSO 的环境不会出现密码表单，无可用入口时给出恢复指引', async () => {
    api.getSsoOptions.mockResolvedValue({ success: true, data: { items: [], passwordLoginDisabled: true } });
    await mount();
    expect(host.querySelector('input[autocomplete="current-password"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('请联系管理员恢复登录服务');
    expect(host.textContent).not.toContain('MAP_PASSWORD');
  });
  it('登录令牌先落库也不提前跳转；权限通过后先显示核验结果再进入', async () => {
    let authorize!: (value: unknown) => void;
    api.login.mockResolvedValue({ success: true, data: { user: { username: 'admin' }, accessToken: 'test-token', refreshToken: '', sessionKey: '' } });
    api.getAdminAuthzMe.mockImplementation(() => new Promise(resolve => { authorize = resolve; }));
    await mount();
    await fill(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, 'sample-secret');
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '开始身份确认')!.click());
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(navigation.navigate).not.toHaveBeenCalled();
    await act(async () => authorize({ success: true, data: { effectivePermissions: ['admin.access'] } }));
    expect(host.textContent).toContain('核验通过');
    expect(navigation.navigate).not.toHaveBeenCalled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
    expect(navigation.navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('权限未通过不展示授权成功，也不进入工作空间', async () => {
    api.login.mockResolvedValue({ success: true, data: { user: { username: 'admin' }, accessToken: 'test-token', refreshToken: '', sessionKey: '' } });
    api.getAdminAuthzMe.mockResolvedValue({ success: false, error: { message: '暂无工作空间访问权限，请联系管理员' } });
    await mount();
    await fill(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, 'sample-secret');
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '开始身份确认')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂无工作空间访问权限');
    expect(host.textContent).not.toContain('核验通过');
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('权限请求异常时退出未完成的会话并恢复可重试表单', async () => {
    api.login.mockResolvedValue({ success: true, data: { user: { username: 'admin' }, accessToken: 'test-token', refreshToken: '', sessionKey: '' } });
    api.getAdminAuthzMe.mockRejectedValue(new Error('暂时无法读取访问权限，请重试'));
    await mount();
    await fill(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, 'sample-secret');
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '开始身份确认')!.click());
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('请重试');
    expect(host.querySelector('[data-phase="idle"]')).not.toBeNull();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('减少动态效果时不等待片头且只导航一次', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    api.login.mockResolvedValue({ success: true, data: { user: { username: 'admin' }, accessToken: 'test-token', refreshToken: '', sessionKey: '' } });
    api.getAdminAuthzMe.mockResolvedValue({ success: true, data: { effectivePermissions: ['admin.access'] } });
    await mount();
    await fill(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, 'sample-secret');
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '开始身份确认')!.click());
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith('/', { replace: true });
  });

});
