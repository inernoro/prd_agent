// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionAnnouncementUpdate } from './VersionAnnouncementUpdate';
import { getProductAnnouncementRecords, getProductAnnouncementSyncStatus, updateProductAnnouncements, type ProductAnnouncementRecord } from '@/services/real/productAgent';

vi.mock('@/services/real/productAgent', () => ({ getProductAnnouncementRecords: vi.fn(), getProductAnnouncementSyncStatus: vi.fn(), updateProductAnnouncements: vi.fn() }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>更新中</span> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const status = (state: string, message: string) => ({ success: true as const, error: null, data: {
  status: state, runId: 'run', message, pages: 2, discovered: 3, updated: 1, conflicts: 0,
  total: 3, detailSucceeded: 2, failed: 1, matched: 1, pending: 0, nextPage: 3, listingComplete: true,
} });
const announcement: ProductAnnouncementRecord = {
  id: 'notice-1', url: 'https://help.miduo.com/notice-1', title: '米多营销 V2.3.4 上线公告',
  applicationName: '米多营销', version: 'V2.3.4', publishedAtRaw: '2026年10月20日', footerTimeRaw: '2026-10-21 09:30',
  status: 'succeeded', statusLabel: '已抓取', error: null, fetchedAt: '2026-10-27T01:00:00Z', attempts: 1,
  matchedCount: 1, matchStatus: 'matched', matchStatusLabel: '已匹配',
};
const records = (items: ProductAnnouncementRecord[], page = 1, total = items.length, totalPages = 1) => ({
  success: true as const, error: null, data: { items, page, total, pageSize: 20, totalPages },
});
let root: Root | null = null;
const reload = vi.fn().mockResolvedValue(undefined);
async function mount() {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(<VersionAnnouncementUpdate onUpdated={reload} />));
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ''; vi.resetAllMocks(); });

describe('公告更新入口', () => {
  it('排队后禁用重复点击，展示后台进度，成功刷新同一版本列表', async () => {
    vi.mocked(getProductAnnouncementSyncStatus).mockResolvedValue(status('idle', ''));
    vi.mocked(updateProductAnnouncements).mockResolvedValue(status('queued', '已排队，正在准备更新公告。'));
    await mount();
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
    expect(document.body.textContent).toContain('已排队');
    expect(document.body.textContent).toContain('已读取 2 页');
    expect(document.body.textContent).toContain('详情成功 2 条');
    expect(document.body.textContent).toContain('已匹配 1 条');
    expect(document.body.textContent).toContain('失败 1 条');
    expect(document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    expect(updateProductAnnouncements).toHaveBeenCalledOnce();
    // 重新进入页面能读取服务器已完成的任务，不依赖原页面的内存状态。
    await act(async () => root!.unmount());
    root = null;
    vi.mocked(getProductAnnouncementSyncStatus).mockResolvedValue(status('succeeded', '公告更新完成：回填1条版本记录。'));
    await mount();
    expect(reload).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
  });

  it('权限或环境拒绝时显示可恢复的错误，不触发列表刷新', async () => {
    vi.mocked(getProductAnnouncementSyncStatus).mockResolvedValue(status('idle', ''));
    vi.mocked(updateProductAnnouncements).mockResolvedValue({ success: false, data: null, error: { code: 'ANNOUNCEMENT_PRODUCTION_ONLY', message: '请在正式环境更新全局版本公告。' } });
    await mount();
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('请在正式环境');
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
  });

  it('通过抓取记录入口展示六项原始信息，翻页和失败筛选查询后台记录', async () => {
    vi.mocked(getProductAnnouncementSyncStatus).mockResolvedValue(status('idle', ''));
    vi.mocked(getProductAnnouncementRecords)
      .mockResolvedValueOnce(records([announcement], 1, 21, 2))
      .mockResolvedValueOnce(records([{ ...announcement, id: 'notice-2', title: '第二页公告' }], 2, 21, 2))
      .mockResolvedValueOnce(records([{ ...announcement, status: 'failed', statusLabel: '抓取失败', error: '公告暂时无法读取，请稍后更新重试。', matchStatus: 'pending', matchStatusLabel: '待匹配' }]));
    await mount();
    await act(async () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '抓取记录')!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain(announcement.title);
    expect(dialog.textContent).toContain(announcement.applicationName);
    expect(dialog.textContent).toContain(announcement.version);
    expect(dialog.textContent).toContain(announcement.publishedAtRaw);
    expect(dialog.textContent).toContain(announcement.footerTimeRaw);
    expect(dialog.querySelector('a')?.href).toBe(announcement.url);
    expect(dialog.textContent).toContain('已匹配');
    await act(async () => Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '下一页')!.click());
    expect(getProductAnnouncementRecords).toHaveBeenLastCalledWith(2, false);
    expect(dialog.textContent).toContain('第二页公告');
    await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(getProductAnnouncementRecords).toHaveBeenLastCalledWith(1, true);
    expect(dialog.textContent).toContain('抓取失败');
    expect(dialog.textContent).toContain('公告暂时无法读取，请稍后更新重试。');
    expect(dialog.textContent).toContain('第 1 / 1 页');
  });

  it('读取失败显示重试，重试成功才显示空记录引导', async () => {
    vi.mocked(getProductAnnouncementSyncStatus).mockResolvedValue(status('failed', '公告详情尚未读取完成，请点击更新公告继续。'));
    vi.mocked(getProductAnnouncementRecords)
      .mockResolvedValueOnce({ success: false, data: null, error: { code: 'SERVER_UNAVAILABLE', message: '抓取记录暂时不可用，请重试。' } })
      .mockResolvedValueOnce(records([]));
    await mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('公告详情尚未读取完成');
    expect(reload).not.toHaveBeenCalled();
    await act(async () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '抓取记录')!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('抓取记录暂时不可用');
    expect(dialog.textContent).not.toContain('还没有抓取记录');
    await act(async () => Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '重试')!.click());
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    expect(dialog.textContent).toContain('还没有抓取记录');
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
