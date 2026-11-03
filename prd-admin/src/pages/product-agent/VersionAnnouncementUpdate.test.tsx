// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionAnnouncementUpdate } from './VersionAnnouncementUpdate';
import { getProductAnnouncementSyncStatus, updateProductAnnouncements } from '@/services/real/productAgent';

vi.mock('@/services/real/productAgent', () => ({ getProductAnnouncementSyncStatus: vi.fn(), updateProductAnnouncements: vi.fn() }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>更新中</span> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const status = (state: string, message: string) => ({ success: true as const, error: null, data: {
  status: state, runId: 'run', message, pages: 2, discovered: 3, updated: 1, conflicts: 0,
} });
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
});
