// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useNotificationToast } from './useNotificationToast';
import { notificationToastKey } from '@/lib/notificationPresentation';
import type { AdminNotificationItem } from '@/services/contracts/notifications';

const error: AdminNotificationItem = { id: 'urgent', title: '线路失败', level: 'error', status: 'open', pushEpisode: 0, createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' };
const info = { ...error, id: 'new-info', title: '周报可读', level: 'info', createdAt: '2026-11-13T01:00:00Z' };

it('同批严重事件先展示，超时不吞未展示项；旧批不接力弹出，复发升级唤醒且遵守免打扰', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const consumed: string[] = [];
  function Probe({ items, snoozed = false }: { items: AdminNotificationItem[]; snoozed?: boolean }) {
    const [dismissed, setDismissed] = useState(new Set<string>());
    const [collapsed, setCollapsed] = useState(false);
    const current = useNotificationToast({ notifications: items, dismissed, collapsed, snoozed, paused: false,
      onCollapsedChange: setCollapsed, onDismiss: key => { consumed.push(key); setDismissed(previous => new Set(previous).add(key)); } });
    return <div>{collapsed || snoozed ? '铃铛' : current?.title}</div>;
  }
  try {
    await act(async () => root.render(<Probe items={[info, error]} />));
    expect(host.textContent).toBe(error.title);
    await act(async () => vi.advanceTimersByTime(12000));
    expect(host.textContent).toBe('铃铛');
    expect(consumed).toEqual([notificationToastKey(error)]);
    await act(async () => { root.render(<Probe items={[{ ...info }, { ...error, occurrenceCount: 182 }]} />); vi.advanceTimersByTime(60000); });
    expect(host.textContent).toBe('铃铛');
    expect(consumed).not.toContain(notificationToastKey(info));
    const recurrence = { ...error, pushEpisode: 1 };
    await act(async () => root.render(<Probe items={[info, recurrence]} />));
    expect(host.textContent).toBe(error.title);
    await act(async () => vi.advanceTimersByTime(12000));
    const upgrade = { ...info, level: 'error' };
    await act(async () => root.render(<Probe items={[upgrade, recurrence]} snoozed />));
    expect(host.textContent).toBe('铃铛');
    await act(async () => { vi.advanceTimersByTime(60000); root.render(<Probe items={[upgrade, recurrence]} />); });
    expect(host.textContent).toBe(info.title);
    expect(consumed).not.toContain(notificationToastKey(upgrade));
  } finally { act(() => root.unmount()); host.remove(); vi.useRealTimers(); }
});
