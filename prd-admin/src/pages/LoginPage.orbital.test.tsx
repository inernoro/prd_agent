// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './LoginPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ login: vi.fn(), getSsoOptions: vi.fn(), getAdminAuthzMe: vi.fn(), loginWithMiduoPlanetToken: vi.fn(), resetPassword: vi.fn() }));
vi.mock('@/services', () => api);
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ isAuthenticated: false, login: vi.fn(), setTokens: vi.fn(), setPermissions: vi.fn(), setPermissionsLoaded: vi.fn(), setCdnBaseUrl: vi.fn(), logout: vi.fn() }) }));
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
  sessionStorage.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  api.getSsoOptions.mockResolvedValue({ success: true, data: { items: [], passwordLoginDisabled: false } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.documentElement.removeAttribute('data-theme'); });

describe('轨道登录真实表单交互', () => {
  it('空密码不可提交，密码可通过键盘访问显隐并保留输入', async () => {
    await mount();
    expect([...host.querySelectorAll('button')].find(b => b.textContent === '进入 MAP')?.disabled).toBe(true);
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
    const submit = [...host.querySelectorAll('button')].find(b => b.textContent === '进入 MAP')!;
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
});
