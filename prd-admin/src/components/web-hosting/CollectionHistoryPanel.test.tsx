// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CollectionHistoryPanel } from './CollectionHistoryPanel';
import { getCollectionHistory } from '@/services/real/hostedCollections';

vi.mock('@/services/real/hostedCollections', () => ({ getCollectionHistory: vi.fn() }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => 'account-token' }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>正在读取</span> }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('大量记录服务端分页，搜索可以找到当前页之外的原链接', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const records = Array.from({ length: 45 }, (_, index) => ({ id: String(index + 1), title: `评审合集 ${index + 1}`, shareUrl: `/s/wp/original-${index + 1}`, createdAt: '2025-01-01T08:12:00Z', memberCount: 3, isActive: index !== 1, statusLabel: index === 1 ? '已撤销' : '有效', accessLevel: 'password' }));
  vi.mocked(getCollectionHistory).mockImplementation(async (_id, page = 1, keyword = '') => {
    const filtered = records.filter(item => item.title.includes(keyword) || item.shareUrl.includes(keyword));
    return { success: true, data: { items: filtered.slice((page - 1) * 20, page * 20), total: filtered.length, page, pageSize: 20 }, error: null };
  });
  try {
    await act(async () => root.render(<CollectionHistoryPanel siteId="document-a" />));
    expect(getCollectionHistory).toHaveBeenCalledWith('document-a', 1, '');
    expect(element.querySelectorAll('.collection-history-record')).toHaveLength(20);
    expect(element.querySelector('a')?.getAttribute('href')).toBe('/s/wp/original-1');
    expect(element.textContent).toContain('/s/wp/original-2');
    expect(element.querySelector('a[href="/s/wp/original-2"]')).toBeNull();
    expect(element.textContent).toContain('密码保护');
    await act(async () => [...element.querySelectorAll('button')].find(button => button.textContent === '下一页')!.click());
    expect(getCollectionHistory).toHaveBeenLastCalledWith('document-a', 2, '');
    const input = element.querySelector<HTMLInputElement>('[aria-label="搜索合集分享"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'original-45'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(getCollectionHistory).toHaveBeenLastCalledWith('document-a', 1, 'original-45');
    expect(element.querySelectorAll('.collection-history-record')).toHaveLength(1);
    expect(element.querySelector('a')?.getAttribute('href')).toBe('/s/wp/original-45');
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="清除合集搜索"]')!.click());
    expect(getCollectionHistory).toHaveBeenLastCalledWith('document-a', 1, '');
    expect(element.textContent).toContain('共 45 条分享记录');
  } finally { act(() => root.unmount()); element.remove(); }
});

it('读取失败显示可重试错误，不误报为没有合集', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div'); const root = createRoot(element);
  vi.mocked(getCollectionHistory).mockResolvedValue({ success: false, data: null as never, error: { code: 'UNAVAILABLE', message: '合集历史暂时无法读取' } });
  try {
    await act(async () => root.render(<CollectionHistoryPanel siteId="a" />));
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('暂时无法读取');
    expect(element.textContent).not.toContain('还没有包含');
    await act(async () => [...element.querySelectorAll('button')].find(button => button.textContent === '重试')!.click());
    expect(getCollectionHistory).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); }
});
