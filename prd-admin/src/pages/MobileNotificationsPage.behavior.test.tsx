// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileNotificationsPage from './MobileNotificationsPage';

const api = vi.hoisted(() => ({ list: vi.fn(), handle: vi.fn(), all: vi.fn(), batch: vi.fn(), ticket: vi.fn(), navigate: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@/services', () => ({ getAdminNotifications: api.list, handleAdminNotification: api.handle, handleAllAdminNotifications: api.all, handleBatchAdminNotifications: api.batch, createLlmGatewaySsoTicket: api.ticket }));
vi.mock('react-router-dom', () => ({ useNavigate: () => api.navigate }));
vi.mock('@/lib/toast', () => ({ toast: { error: api.error, success: api.success } }));
vi.mock('@/hooks/useAppStoreColors', () => ({ useAppStoreColors: () => ({ bg: 'white', label: 'black' }) }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>提交中</span> }));

const notice = { id: 'route-a', title: '线路甲余额不足', message: '本次请求已通过备用线路完成。', level: 'warning', status: 'open', actionUrl: '/logs?requestId=req-a', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T01:00:00Z', pushEpisode: 2, incidentId: 'incident-a', incidentState: 'active', requestOutcome: 'fallback_succeeded', occurrenceCount: 182, firstOccurredAt: '2026-11-13T00:00:00Z', lastOccurredAt: '2026-11-13T01:00:00Z' };
let host: HTMLDivElement;
let root: Root;
async function render() { await act(async () => root.render(<MobileNotificationsPage />)); }
async function click(label: RegExp) {
  const button = [...host.querySelectorAll('button')].find(item => label.test(item.textContent || ''))!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.list.mockResolvedValue({ success: true, data: { items: [notice] } });
  api.handle.mockResolvedValue({ success: true, data: { handled: true } });
  api.all.mockResolvedValue({ success: true, data: { handled: true } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('通知动作与事实真实组件交互', () => {
  it('进入正确对象只导航，不确认通知或改变故障', async () => {
    await render();
    const title = [...host.querySelectorAll('div')].find(item => item.textContent === notice.title)!;
    await act(async () => title.click());
    expect(api.navigate).toHaveBeenCalledWith(notice.actionUrl);
    expect(api.handle).not.toHaveBeenCalled();
    expect(host.textContent).toContain(notice.title);
  });

  it('批量确认提交所见快照，部分失败后显示权威剩余项和失败反馈', async () => {
    const other = { ...notice, id: 'route-b', title: '线路乙超时', incidentId: 'incident-b' };
    api.list.mockResolvedValueOnce({ success: true, data: { items: [notice, other] } })
      .mockResolvedValue({ success: true, data: { items: [other] } });
    api.batch.mockResolvedValue({ success: true, data: { requested: 2, handled: 1, failed: 1, results: [{ id: notice.id, handled: true }, { id: other.id, handled: false, reason: '通知已更新，请刷新后重试' }] } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    await click(/确认当前|一键处理/);
    expect(api.batch).toHaveBeenCalledWith({ items: [
      { id: notice.id, pushEpisode: notice.pushEpisode, updatedAt: notice.updatedAt },
      { id: other.id, pushEpisode: other.pushEpisode, updatedAt: other.updatedAt },
    ] });
    expect(api.all).not.toHaveBeenCalled();
    expect(api.error).toHaveBeenCalled();
    expect(host.textContent).toContain(other.title);
  });

  it('单条确认保留故障仍在发生的事实，不把确认当恢复', async () => {
    api.batch.mockResolvedValue({ success: true, data: { requested: 1, handled: 1, failed: 0, results: [{ id: notice.id, handled: true }] } });
    api.list.mockResolvedValueOnce({ success: true, data: { items: [notice] } })
      .mockResolvedValue({ success: true, data: { items: [{ ...notice, status: 'handled' }] } });
    await render();
    const confirm = host.querySelector<HTMLButtonElement>(`[aria-label="确认通知：${notice.title}"]`)!;
    await act(async () => confirm.click());
    expect(api.batch).toHaveBeenCalledWith({ items: [{ id: notice.id, pushEpisode: 2, updatedAt: notice.updatedAt }] });
    expect(host.textContent).toContain('故障仍在发生');
    expect(host.textContent).toContain('确认不代表故障已修复');
    expect(host.textContent).not.toContain('已有恢复证据');
  });

  it('提交期间列表不乐观消失，失败保留原通知并给重试反馈', async () => {
    let release!: (result: unknown) => void;
    api.batch.mockReturnValue(new Promise(resolve => { release = resolve; }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    await click(/确认当前/);
    expect(host.textContent).toContain(notice.title);
    expect(host.querySelector<HTMLButtonElement>('[aria-label^="确认通知："]')!.disabled).toBe(true);
    await act(async () => release({ success: false, error: { message: '确认未完成，请重试' } }));
    expect(host.textContent).toContain(notice.title);
    expect(api.error).toHaveBeenCalledWith('通知确认失败', '确认未完成，请重试');
  });

  it('取消批量确认不写入状态，也不把发生次数当成故障数', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    api.list.mockResolvedValue({ success: true, data: { items: [notice], summary: { notificationCount: 1, independentIncidentCount: 1, unclassifiedCount: 0 } } });
    await render();
    await click(/确认当前/);
    expect(api.batch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('1 个已识别独立故障');
    expect(host.textContent).toContain('同一故障发生 182 次');
    expect(host.textContent).not.toContain('182 个');
  });

  it.each([
    ['fallback_succeeded', '该次请求备用成功'],
    ['all_failed', '该次请求全部线路失败'],
    ['unknown', '该次请求结果未确认'],
  ])('直接展示服务端%s结果，不根据故障级别猜测请求结果', async (requestOutcome, expected) => {
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...notice, requestOutcome }] } });
    await render();
    expect(host.textContent).toContain(expected);
  });

  it('展开定位详情不触发对象导航或确认', async () => {
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...notice, evidenceRequestId: 'request-a' }] } });
    await render();
    await act(async () => host.querySelector('summary')!.click());
    expect(api.navigate).not.toHaveBeenCalled();
    expect(api.batch).not.toHaveBeenCalled();
    expect(api.handle).not.toHaveBeenCalled();
  });

  it('旧告警的状态未确认，不补造独立故障数和发生次数', async () => {
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...notice, incidentId: null, occurrenceCount: undefined, requestOutcome: 'unknown', incidentState: 'unknown' }] } });
    await render();
    expect(host.textContent).toContain('当前状态未确认');
    expect(host.textContent).toContain('无法确认独立故障数或发生次数');
    expect(host.textContent).not.toContain('同一故障发生');
  });
});
