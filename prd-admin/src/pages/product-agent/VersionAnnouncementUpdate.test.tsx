import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionAnnouncementUpdate } from './VersionAnnouncementUpdate';
import { getProductAnnouncementSyncStatus, updateProductAnnouncements } from '@/services/real/productAgent';

vi.mock('@/services/real/productAgent', () => ({ getProductAnnouncementSyncStatus: vi.fn(), updateProductAnnouncements: vi.fn() }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>更新中</span> }));
const status = (state: string, message: string) => ({ success: true as const, error: null, data: {
  status: state, runId: 'run', message, pages: 2, discovered: 3, updated: 1, conflicts: 0,
} });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

describe('公告更新入口', () => {
  it('排队后禁用重复点击，展示后台进度，成功刷新同一版本列表', async () => {
    vi.mocked(getProductAnnouncementSyncStatus).mockResolvedValue(status('idle', ''));
    vi.mocked(updateProductAnnouncements).mockResolvedValue(status('queued', '已排队，正在准备更新公告。'));
    const reload = vi.fn().mockResolvedValue(undefined);
    render(<VersionAnnouncementUpdate onUpdated={reload} />);
    await waitFor(() => expect(getProductAnnouncementSyncStatus).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '更新公告' }));
    await screen.findByText(/已排队/);
    expect(screen.getByRole('button', { name: /更新公告/ })).toBeDisabled();
    expect(updateProductAnnouncements).toHaveBeenCalledOnce();
    // 重新进入页面能读取服务器已完成的任务，不依赖原页面的内存状态。
    cleanup();
    vi.mocked(getProductAnnouncementSyncStatus).mockResolvedValue(status('succeeded', '公告更新完成：回填1条版本记录。'));
    render(<VersionAnnouncementUpdate onUpdated={reload} />);
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '更新公告' })).toBeEnabled();
  });

  it('权限或环境拒绝时显示可恢复的错误，不触发列表刷新', async () => {
    vi.mocked(getProductAnnouncementSyncStatus).mockResolvedValue(status('idle', ''));
    vi.mocked(updateProductAnnouncements).mockResolvedValue({ success: false, data: null, error: { code: 'ANNOUNCEMENT_PRODUCTION_ONLY', message: '请在正式环境更新全局版本公告。' } });
    const reload = vi.fn().mockResolvedValue(undefined);
    render(<VersionAnnouncementUpdate onUpdated={reload} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新公告' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('请在正式环境');
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '更新公告' })).toBeEnabled();
  });
});
