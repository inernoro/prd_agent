// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileNotificationsPage from './MobileNotificationsPage';

const api = vi.hoisted(() => ({ list: vi.fn(), assign: vi.fn(), handle: vi.fn(), all: vi.fn(), batch: vi.fn(), ticket: vi.fn(), navigate: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@/services', () => ({ getAdminNotifications: api.list, assignNotificationIncident: api.assign, handleAdminNotification: api.handle, handleAllAdminNotifications: api.all, handleBatchAdminNotifications: api.batch, createLlmGatewaySsoTicket: api.ticket }));
vi.mock('react-router-dom', () => ({ useNavigate: () => api.navigate }));
vi.mock('@/lib/toast', () => ({ toast: { error: api.error, success: api.success } }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsDesktop: () => true }));
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
  it('故障接力使用本轮代次，接手后仍显示故障与备用结果，选中证据可回看失败请求', async () => {
    const evidence = [
      { outcome: 'all_failed', observedAt: notice.firstOccurredAt, requestId: 'failed-request' },
      { outcome: 'fallback_succeeded', observedAt: notice.lastOccurredAt, requestId: 'backup-request' },
    ];
    const episode = { ...notice, incidentFollowUp: { episode: 0, canAssign: true, evidence } };
    api.list.mockResolvedValueOnce({ success: true, data: { items: [episode] } })
      .mockResolvedValueOnce({ success: true, data: { items: [episode] } })
      .mockResolvedValue({ success: true, data: { items: [{ ...episode, incidentFollowUp: { ...episode.incidentFollowUp,
        owner: { isMe: true, displayName: '当班同事' } } }] } });
    api.assign.mockResolvedValue({ success: true, data: { assigned: true } });
    await render();
    await click(/^故障接力$/);
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'incidents' }));
    await click(/^标记接手$/);
    expect(api.assign).toHaveBeenCalledWith(notice.id, 0, true);
    expect(api.batch).not.toHaveBeenCalled();
    const detail = host.querySelector('aside')!;
    expect(detail.textContent).toContain('我已接手');
    expect(detail.textContent).toContain('异常，等待恢复证据');
    expect(detail.textContent).toContain('1 笔失败，1 笔备用成功');
    await click(/请求失败$/);
    expect(detail.querySelector('code')?.textContent).toBe('failed-request');
  });

  it('历史故障未记录发生时间时仍显示通知记录时间，不把记录时刻当作故障发生或恢复', async () => {
    const recordedAt = '2026-11-12T10:17:56Z';
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...notice, title: '历史额度异常', message: '历史通知记录了服务额度异常。', requestOutcome: 'unknown', incidentId: undefined, incidentState: 'unknown', occurrenceCount: undefined, firstOccurredAt: undefined, lastOccurredAt: undefined, recoveredAt: undefined, createdAt: recordedAt }] } });
    await render();
    expect(host.textContent).toContain('通知记录时间');
    expect(host.textContent).not.toContain('最近发生');
    const time = host.querySelector<HTMLTimeElement>('aside time');
    expect(time?.dateTime).toBe(recordedAt);
    expect(time?.textContent).toContain('2026');
    expect(host.textContent).not.toContain('已有恢复证据');
  });

  it('进入正确对象只导航，不确认通知或改变故障', async () => {
    await render();
    await click(/查看对应对象/);
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

  it('单条确认保留最近观测异常的事实，不把确认当恢复', async () => {
    api.batch.mockResolvedValue({ success: true, data: { requested: 1, handled: 1, failed: 0, results: [{ id: notice.id, handled: true }] } });
    api.list.mockResolvedValueOnce({ success: true, data: { items: [notice] } })
      .mockResolvedValueOnce({ success: true, data: { items: [] } })
      .mockResolvedValue({ success: true, data: { items: [{ ...notice, status: 'handled' }] } });
    await render();
    const confirm = host.querySelector<HTMLButtonElement>(`[aria-label="确认通知：${notice.title}"]`)!;
    await act(async () => confirm.click());
    expect(api.batch).toHaveBeenCalledWith({ items: [{ id: notice.id, pushEpisode: 2, updatedAt: notice.updatedAt }] });
    expect(host.textContent).toContain('暂无待关注通知');
    await click(/^已归档$/);
    expect(host.textContent).toContain('最近观测异常，尚无恢复证据');
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
    expect(host.textContent).toContain('1 条重要');
    expect(host.textContent).toContain('同一故障累计182 次');
    expect(host.textContent).not.toContain('182 个');
  });

  it.each([
    ['fallback_succeeded', '该次请求备用成功'],
    ['request_succeeded', '该次请求成功'],
    ['all_failed', '该次请求已尝试线路均失败'],
    ['unknown', '该次请求结果未确认'],
  ])('直接展示服务端%s结果，不根据故障级别猜测请求结果', async (requestOutcome, expected) => {
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...notice, requestOutcome }] } });
    await render();
    expect(host.textContent).toContain(expected);
  });

  it('查看定位编号不触发对象导航或确认', async () => {
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...notice, evidenceRequestId: 'request-a' }] } });
    await render();
    expect(host.querySelector('aside code')?.textContent).toBe('request-a');
    await act(async () => host.querySelector('aside code')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(api.navigate).not.toHaveBeenCalled();
    expect(api.batch).not.toHaveBeenCalled();
    expect(api.handle).not.toHaveBeenCalled();
  });

  it('通过优先级筛选并翻页，保留已归档通知', async () => {
    const urgent = { ...notice, id: 'quota', level: 'error', title: '额度已用尽', incidentCategory: 'quota' };
    api.list.mockResolvedValueOnce({ success: true, data: { items: [urgent, notice] } })
      .mockResolvedValueOnce({ success: true, data: { items: [urgent, notice] } })
      .mockResolvedValueOnce({ success: true, data: { items: [urgent], hasMore: true, nextCursor: 'page-2' } })
      .mockResolvedValueOnce({ success: true, data: { items: [{ ...urgent, id: 'closed', title: '更早的额度通知', status: 'closed' }] } });
    await render();
    expect(host.textContent).toContain('重要');
    await click(/^全部记录$/);
    const filter = host.querySelector('select')!;
    await act(async () => { filter.value = 'urgent'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'urgent', includeHandled: true }));
    expect(host.textContent).not.toContain(notice.title);
    await click(/加载更多通知/);
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'urgent', cursor: 'page-2' }));
    expect(host.textContent).toContain('额度已用尽');
    expect(host.textContent).toContain('更早的额度通知');
  });

  it('用结果图标区分失败与恢复，并把结论和环境放在详情之前', async () => {
    const failed = { ...notice, id: 'failed', title: '生图请求失败', level: 'error', status: 'closed',
      incidentState: 'recovered', source: 'gateway-alert', environment: '正式', message: '请查看线路详情。' };
    const recovered = { ...failed, id: 'recovered', title: '生图线路已恢复', level: 'success', status: 'open' };
    api.list.mockResolvedValueOnce({ success: true, data: { items: [] } })
      .mockResolvedValue({ success: true, data: { items: [failed, recovered] } });
    await render();
    await click(/^全部记录$/);
    for (const [item, result] of [[failed, '失败'], [recovered, '已恢复']] as const) {
      const row = host.querySelector(`[data-notification-id="${item.id}"]`)!;
      expect(row.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(result);
      expect(row.textContent?.indexOf(item.title)).toBeLessThan(row.textContent?.indexOf('环境 正式') ?? -1);
      await act(async () => row.querySelector('button')!.click());
      const text = host.querySelector('aside')!.textContent || '';
      expect(text.indexOf(item.title)).toBeLessThan(text.indexOf('环境 正式'));
      expect(text.indexOf('环境 正式')).toBeLessThan(text.indexOf(item.message));
    }
    expect(host.querySelector('[data-notification-id="failed"] svg')?.getAttribute('class')).not.toBe(
      host.querySelector('[data-notification-id="recovered"] svg')?.getAttribute('class'));
  });

  it('默认将服务告警放在其他提醒之前并选中，切换记录不确认任何通知', async () => {
    const reminder = { ...notice, id: 'report', title: '周报已逾期', level: 'error', incidentId: null, incidentState: null };
    api.list.mockResolvedValue({ success: true, data: { items: [reminder, notice] } });
    await render();
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ state: 'attention' }));
    expect(host.querySelector('[data-notification-id]')?.getAttribute('data-notification-id')).toBe(notice.id);
    const detail = host.querySelector('aside')!;
    expect(detail.querySelector('h3')?.textContent).toBe(notice.title);
    expect(detail.textContent).toContain('该次请求备用成功');
    expect(detail.textContent).toContain('最近发生');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-notification-id="report"] button')!.click());
    expect(detail.querySelector('h3')?.textContent).toBe(reminder.title);
    expect(api.batch).not.toHaveBeenCalled();
  });

  it('旧告警的状态未确认，不补造独立故障数和发生次数', async () => {
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...notice, incidentId: null, occurrenceCount: undefined, requestOutcome: 'unknown', incidentState: 'unknown' }] } });
    await render();
    expect(host.textContent).toContain('当前状态未确认');
    expect(host.textContent).not.toContain('同一故障累计');
  });

  it('当前新unknown事件缺少身份时不称为历史，不补造一次或恢复', async () => {
    const now = new Date().toISOString();
    api.list.mockResolvedValue({ success: true, data: { items: [{
      ...notice, id: 'fresh-unidentified', title: '当前请求结果需要核对',
      message: '该次请求结果尚未确认，请先核对任务结果。',
      source: 'llm-gateway-quota', incidentId: null, incidentState: 'unknown', requestOutcome: 'unknown',
      occurrenceCount: 1, createdAt: now, updatedAt: now, pushEpisode: 0,
      firstOccurredAt: undefined, lastOccurredAt: undefined, recoveredAt: undefined, actionUrl: null,
    }] } });
    await render();
    expect(host.textContent).toContain('当前状态未确认');
    expect(host.textContent).not.toContain('历史');
    expect(host.textContent).not.toContain('同一故障累计');
    expect(host.textContent).not.toContain('已有恢复证据');
    expect(host.textContent).not.toContain('恢复时间');
  });
});
