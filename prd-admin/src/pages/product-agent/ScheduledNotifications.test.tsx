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
  webhookMasked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=********',
  webhookConfigured: true, canEdit: false, debugLastResult: null, debugLastRunAt: null,
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
  it('已发送单次仅能复制，复制明确展示已填写并直接继承Webhook', async () => {
    api.list.mockResolvedValue({ success: true, data: { canManage: true, items: [completed] } });
    api.save.mockResolvedValue({ success: true, data: { ...completed, id: 'new-copy' } });
    await render();
    expect(buttons('编辑')).toHaveLength(0);
    expect(buttons('立即调试')).toHaveLength(0);
    await click('复制为新任务');
    expect((host.querySelector('input[name=name]') as HTMLInputElement).value).toBe('原通知（副本）');
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('once');
    expect((host.querySelector('input[name=time]') as HTMLInputElement).value).toBe('18:30');
    expect(host.textContent).toContain('已填写（脱敏）');
    expect(host.querySelector('input[name=webhook]')).toBeNull();
    await click('修改');
    expect(host.querySelector('input[name=webhook]')).not.toBeNull();
    await click('取消修改');
    expect(host.querySelector('input[name=webhook]')).toBeNull();
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      sourceTaskId: completed.id, webhookUrl: undefined, enabled: true, message: completed.message,
    }), undefined);
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
