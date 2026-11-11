// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SiteCollectionHistory } from './SiteCollectionHistory';
import { getCollectionHistory } from '@/services/real/hostedCollections';

vi.mock('@/services/real/hostedCollections', () => ({ getCollectionHistory: vi.fn() }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => 'account-token' }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>正在读取</span> }));
vi.mock('@/components/ui/AnchoredMenu', () => ({ AnchoredMenu: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('点击一次列出原合集分享，第二次可直接打开旧凭证，失效记录仍可找回', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const items = [
    { id: 'old', title: '早期评审合集', shareUrl: '/s/wp/original-token', createdAt: '2025-01-01T00:00:00Z', memberCount: 3, isActive: true, statusLabel: '有效', accessLevel: 'password' },
    { id: 'revoked', title: '已撤销合集', shareUrl: '/s/wp/revoked-token', createdAt: '2024-01-01T00:00:00Z', memberCount: 5, isActive: false, statusLabel: '已撤销', accessLevel: 'public' },
  ];
  vi.mocked(getCollectionHistory).mockResolvedValue({ success: true, data: { items, total: 21, page: 1, pageSize: 20 }, error: null });
  try {
    await act(async () => root.render(<SiteCollectionHistory siteId="document-a" siteTitle="发布说明" />));
    expect(getCollectionHistory).not.toHaveBeenCalled();
    await act(async () => element.querySelector<HTMLButtonElement>('[data-site-collection-history]')!.click());
    expect(getCollectionHistory).toHaveBeenCalledWith('document-a', 1);
    const links = [...element.querySelectorAll('a')];
    expect(links).toHaveLength(1); expect(links[0].getAttribute('href')).toBe('/s/wp/original-token'); expect(links[0].target).toBe('_blank');
    expect(element.textContent).toContain('密码保护'); expect(element.textContent).toContain('已撤销');
    expect(element.querySelector('[aria-label="复制原链接：已撤销合集"]')).not.toBeNull();
    await act(async () => [...element.querySelectorAll('button')].find(button => button.textContent === '下一页')!.click());
    expect(getCollectionHistory).toHaveBeenLastCalledWith('document-a', 2);
    await act(async () => element.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(element.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => element.querySelector<HTMLButtonElement>('[data-site-collection-history]')!.click());
    expect(getCollectionHistory).toHaveBeenLastCalledWith('document-a', 1);
  } finally { act(() => root.unmount()); element.remove(); }
});

it('读取失败显示可重试错误，不误报为没有合集', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div'); const root = createRoot(element);
  vi.mocked(getCollectionHistory).mockResolvedValue({ success: false, data: null as never, error: { code: 'UNAVAILABLE', message: '合集历史暂时无法读取' } });
  try {
    await act(async () => root.render(<SiteCollectionHistory siteId="a" siteTitle="文档" />));
    await act(async () => element.querySelector<HTMLButtonElement>('button')!.click());
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('暂时无法读取');
    expect(element.textContent).not.toContain('还没有包含');
    await act(async () => [...element.querySelectorAll('button')].find(button => button.textContent === '重试')!.click());
    expect(getCollectionHistory).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); }
});
