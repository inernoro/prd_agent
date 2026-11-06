// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledNotifications } from './ScheduledNotifications';
import type { ScheduledNotification } from '@/services/real/productScheduledNotifications';

const api = vi.hoisted(() => ({
  list: vi.fn(), save: vi.fn(), debug: vi.fn(), getSettings: vi.fn(), saveSettings: vi.fn(),
  listGroups: vi.fn(), saveGroup: vi.fn(), removeGroup: vi.fn(),
}));
vi.mock('@/services/real/productScheduledNotifications', () => ({
  listScheduledNotifications: api.list, saveScheduledNotification: api.save, debugScheduledNotification: api.debug,
  getNotificationDebugSettings: api.getSettings, saveNotificationDebugSettings: api.saveSettings,
  listNotificationGroups: api.listGroups, saveNotificationGroup: api.saveGroup, removeNotificationGroup: api.removeGroup,
}));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <span>读取中</span> }));
vi.mock('@/components/ui/Dialog', () => ({
  Dialog: ({ title, content, actions }: { title: ReactNode; content: ReactNode; actions: ReactNode }) =>
    <div role="dialog"><h2>{title}</h2>{content}{actions}</div>,
}));

const completed: ScheduledNotification = {
  id: 'completed', revision: 'revision', name: '原通知', message: '原通知内容',
  frequency: 'once', time: '09:00', date: '2026-11-01', day: null,
  enabled: false, mentionAll: true, nextRunAt: null, lastRunAt: '2026-11-01T01:00:00Z', lastResult: 'sent',
  lastDelivery: null,
  webhookMasked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=********',
  webhookConfigured: true, webhookCount: 2, canEdit: false, debugLastResult: null, debugLastRunAt: null,
};

let host: HTMLDivElement;
let root: Root | undefined;
async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<ScheduledNotifications />));
}
function buttons(label: string) {
  return [...host.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
}
async function click(label: string) {
  const matches = buttons(label);
  expect(matches).toHaveLength(1);
  await act(async () => matches[0].click());
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  vi.resetAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  api.listGroups.mockResolvedValue({ success: true, data: { items: [] } });
});

describe('定时通知真实组件交互', () => {
  it('保存常用群后可按名称选择两个群，通知仅提交群引用', async () => {
    const first = { id: 'sales', revision: 'v1', name: '销售群', webhookMasked: completed.webhookMasked };
    const second = { id: 'ops', revision: 'v2', name: '运营群', webhookMasked: completed.webhookMasked };
    api.list.mockResolvedValue({ success: true, data: { canManage: true, items: [] } });
    api.listGroups.mockResolvedValueOnce({ success: true, data: { items: [first] } })
      .mockResolvedValue({ success: true, data: { items: [first, second] } });
    api.saveGroup.mockResolvedValue({ success: true, data: second });
    api.save.mockResolvedValue({ success: true, data: completed });
    await render();
    await click('常用群');
    await click('添加常用群');
    const form = host.querySelector<HTMLFormElement>('#notification-group-form')!;
    form.querySelector<HTMLInputElement>('[name=name]')!.value = second.name;
    form.querySelector<HTMLInputElement>('[name=webhook]')!.value = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake-test-key';
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(api.saveGroup).toHaveBeenCalledWith(expect.objectContaining({ name: second.name }), undefined);
    await click('关闭');
    await click('新建任务');
    const editor = host.querySelector<HTMLFormElement>('#scheduled-notification-form')!;
    const picker = [...editor.querySelectorAll('select')].find((item) => item.labels?.[0].textContent?.includes('选择常用群'))!;
    for (const group of [first, second]) {
      await act(async () => {
        picker.value = group.id;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    expect(editor.querySelector('input[type=password]')).toBeNull();
    expect(editor.textContent).toContain(first.name);
    expect(editor.textContent).toContain(second.name);
    await act(async () => { editor.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      webhooks: [{ groupId: first.id, groupRevision: first.revision }, { groupId: second.id, groupRevision: second.revision }],
    }), undefined);
  });

  it('已发送单次仅能复制，副本保留原日期、时间、启用设置和全部已填写的 Webhook', async () => {
    api.list.mockResolvedValue({ success: true, data: { canManage: true, items: [completed] } });
    api.save.mockResolvedValue({ success: true, data: { ...completed, id: 'new-copy' } });
    await render();
    expect(buttons('编辑')).toHaveLength(0);
    expect(buttons('立即调试')).toHaveLength(0);
    expect(buttons('启用')).toHaveLength(0);
    expect(host.querySelector('[role=switch]')).toBeNull();
    expect(host.querySelectorAll('tbody td')[2].textContent).toBe('已发送');
    await click('复制');
    expect((host.querySelector('input[name=name]') as HTMLInputElement).value).toBe(completed.name);
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('once');
    expect((host.querySelector('input[name=time]') as HTMLInputElement).value).toBe(completed.time);
    expect((host.querySelector('input[name=date]') as HTMLInputElement).value).toBe(completed.date);
    expect(host.textContent).toContain('已填写（脱敏）');
    expect(host.querySelector('input[type=password]')).toBeNull();
    await act(async () => buttons('修改')[0].click());
    expect(host.querySelector('input[name=webhook-0]')).not.toBeNull();
    await click('取消修改');
    expect(host.querySelector('input[type=password]')).toBeNull();
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      sourceTaskId: completed.id, sourceRevision: completed.revision, enabled: false,
      name: completed.name, message: completed.message, time: completed.time, date: completed.date, mentionAll: true,
      webhooks: [{ existingIndex: 0 }, { existingIndex: 1 }],
    }), undefined);
  });

  it('操作列的文字启停各行独立，过期启用错误显示在当前行', async () => {
    const scheduled = { ...completed, canEdit: true, enabled: true, lastResult: null, lastRunAt: null };
    const disabled = { ...scheduled, enabled: false, revision: 'disabled-revision' };
    const past = { ...disabled, id: 'past' };
    let visible = [scheduled, past];
    let finishDisable!: (response: { success: true; data: ScheduledNotification }) => void;
    const pendingDisable = new Promise<{ success: true; data: ScheduledNotification }>((resolve) => { finishDisable = resolve; });
    const errorMessage = '启用单次通知时请选择未来时间。';
    api.list.mockImplementation(async () => ({ success: true, data: { canManage: true, items: visible } }));
    api.save.mockReturnValueOnce(pendingDisable)
      .mockResolvedValueOnce({ success: false, error: { code: 'INVALID_NOTIFICATION_SCHEDULE', message: errorMessage } });
    await render();
    const [scheduledRow, pastRow] = host.querySelectorAll<HTMLTableRowElement>('tbody tr');
    expect(pastRow.cells[2].textContent).toBe('待发送');
    expect(scheduledRow.cells[5].contains(buttons('禁用')[0])).toBe(true);
    expect(pastRow.cells[5].contains(buttons('启用')[0])).toBe(true);
    await click('禁用');
    expect(buttons('保存中…')[0].disabled).toBe(true);
    expect(buttons('启用')[0].disabled).toBe(false);
    await click('启用');
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, date: past.date }), past.id);
    expect(pastRow.cells[5].querySelector('[role=alert]')?.textContent).toBe(errorMessage);
    visible = [disabled, past];
    await act(async () => finishDisable({ success: true, data: disabled }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      revision: scheduled.revision, enabled: false, time: scheduled.time, date: scheduled.date,
    }), scheduled.id);
    expect(api.save.mock.calls[0][0]).not.toHaveProperty('webhooks');
    expect(scheduledRow.cells[2].textContent).toBe('待发送');
    expect(buttons('启用')).toHaveLength(2);
  });

  it('到点发送结果自动刷新，完成后隐藏编辑入口', async () => {
    vi.useFakeTimers();
    api.list.mockResolvedValueOnce({ success: true, data: {
      canManage: true, items: [{ ...completed, enabled: true, canEdit: true, lastRunAt: null, lastResult: null }],
    } }).mockResolvedValue({ success: true, data: { canManage: true, items: [completed] } });
    await render();
    expect(host.textContent).toContain('等待到点发送');
    expect(buttons('编辑')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(host.textContent).toContain('发送成功');
    expect(buttons('编辑')).toHaveLength(0);
    expect(buttons('复制')).toHaveLength(1);
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
