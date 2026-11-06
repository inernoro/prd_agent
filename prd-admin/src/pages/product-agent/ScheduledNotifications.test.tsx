// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledNotifications } from './ScheduledNotifications';
import type { ScheduledNotification } from '@/services/real/productScheduledNotifications';

const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), debug: vi.fn(), getSettings: vi.fn(), saveSettings: vi.fn() }));
vi.mock('@/services/real/productScheduledNotifications', () => ({
  listScheduledNotifications: api.list, saveScheduledNotification: api.save, debugScheduledNotification: api.debug,
  getNotificationDebugSettings: api.getSettings, saveNotificationDebugSettings: api.saveSettings,
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

describe('定时通知真实组件交互', () => {
  it('已发送单次仅能复制，副本保留原日期、时间、开关和全部已填写的 Webhook', async () => {
    api.list.mockResolvedValue({ success: true, data: { canManage: true, items: [completed] } });
    api.save.mockResolvedValue({ success: true, data: { ...completed, id: 'new-copy' } });
    await render();
    expect(buttons('编辑')).toHaveLength(0);
    expect(buttons('立即调试')).toHaveLength(0);
    expect(host.querySelector('[role=switch]')).toBeNull();
    await click('复制为新任务');
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

  it('列表禁用任务时保留计划和已保存的 Webhook', async () => {
    const scheduled = { ...completed, canEdit: true, enabled: true, lastResult: null, lastRunAt: null };
    const disabled = { ...scheduled, enabled: false, revision: 'disabled-revision' };
    api.list.mockResolvedValueOnce({ success: true, data: { canManage: true, items: [scheduled] } })
      .mockResolvedValue({ success: true, data: { canManage: true, items: [disabled] } });
    api.save.mockResolvedValue({ success: true, data: disabled });
    await render();
    const toggle = host.querySelector<HTMLButtonElement>('[role=switch]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle.click());
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      revision: scheduled.revision, enabled: false, time: scheduled.time, date: scheduled.date,
    }), scheduled.id);
    expect(api.save.mock.calls[0][0]).not.toHaveProperty('webhooks');
    expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false');
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
    expect(buttons('复制为新任务')).toHaveLength(1);
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
