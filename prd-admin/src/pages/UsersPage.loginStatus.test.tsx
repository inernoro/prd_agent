// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsersPage from './UsersPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { getUsers } = vi.hoisted(() => ({ getUsers: vi.fn() }));
vi.mock('@/services', () => ({ getUsers }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isMobile: false }), useIsMobile: () => false }));
vi.mock('@/components/ui/UserProfilePopover', () => ({ UserProfilePopover: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/AvatarEditDialog', () => ({ AvatarEditDialog: () => null }));
const user = { userId: 'existing-memory-user', username: 'existing_user', displayName: '已有账号', role: 'ADMIN', status: 'Active', createdAt: '2026-01-01', isLocked: false, lockoutRemainingSeconds: 0 };
const response = (patch = {}) => ({ success: true, data: { items: [{ ...user, ...patch }], total: 1 } });
let host: HTMLDivElement;
let root: Root;
async function mount() { await act(async () => { root.render(<MemoryRouter><UsersPage /></MemoryRouter>); }); }
async function focus() { await act(async () => { window.dispatchEvent(new Event('focus')); }); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  getUsers.mockResolvedValue(response());
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('用户页登录限制快照（无网络、无真实账户）', () => {
  it('账号启用与登录锁定同时呈现，重新聚焦读取新限制，过期须服务端确认', async () => {
    await mount();
    expect(host.textContent).toContain('已有账号');
    getUsers.mockResolvedValue(response({ isLocked: true, lockoutRemainingSeconds: 821 }));
    await focus();
    expect(host.textContent).toContain('登录暂时锁定');
    expect(host.textContent).toContain('状态读取于');
    expect(host.textContent).toContain('已启用');
    getUsers.mockResolvedValue(response());
    await focus();
    expect(host.textContent).not.toContain('登录暂时锁定');
    expect(host.textContent).toContain('读取时未锁定');
  });

  it('刷新失败保留且标明旧快照，手动重试可恢复，禁用与锁定互不遮盖', async () => {
    await mount();
    getUsers.mockResolvedValue({ success: false, error: { message: 'private diagnostic must not render' } });
    await focus();
    expect(host.querySelector('[role=alert]')?.textContent).toContain('当前展示上次读取结果');
    expect(host.textContent).not.toContain('private diagnostic');
    getUsers.mockResolvedValue(response({ status: 'Disabled', isLocked: true, lockoutRemainingSeconds: 30 }));
    const refresh = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('刷新状态'))!;
    await act(async () => refresh.click());
    expect(host.querySelector('[role=alert]')).toBeNull();
    expect(host.textContent).toContain('已禁用');
    expect(host.textContent).toContain('登录暂时锁定');
  });

  it('较早请求迟到不能覆盖最新结果，初次读取失败不显示暂无数据', async () => {
    getUsers.mockResolvedValueOnce({ success: false, error: { message: 'private network error' } });
    await mount();
    expect(host.textContent).toContain('暂未读取到用户');
    expect(host.textContent).not.toContain('暂无数据');
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    getUsers.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await focus();
    getUsers.mockResolvedValue(response({ isLocked: true, lockoutRemainingSeconds: 60 }));
    await focus();
    await act(async () => resolveOld(response()));
    expect(host.textContent).toContain('登录暂时锁定');
  });
});
