import { describe, expect, it } from 'vitest';
import { notificationBatchConfirmation, notificationToastKey } from '../notificationPresentation';
import type { AdminNotificationItem } from '@/services/contracts/notifications';

const item: AdminNotificationItem = { id: 'same-fault', title: '线路失败', level: 'warning', status: 'open', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T01:00:00Z', pushEpisode: 0, incidentState: 'active' };
describe('通知收起与操作范围', () => {
  it('持续重复保持收起，复发、升级和恢复各自重新可见', () => {
    const hidden = new Set([notificationToastKey(item)]);
    expect(hidden.has(notificationToastKey({ ...item, occurrenceCount: 182, updatedAt: '2026-11-13T02:00:00Z' }))).toBe(true);
    for (const changed of [{ ...item, pushEpisode: 1 }, { ...item, level: 'error' }, { ...item, incidentState: 'recovered' }]) {
      expect(hidden.has(notificationToastKey(changed))).toBe(false);
    }
  });
  it('批量说明准确的通知数量、共享范围和不修故障效果', () => {
    const text = notificationBatchConfirmation([item, { ...item, id: 'personal', targetUserId: 'me' }]);
    for (const fact of ['2 条通知', '1 条为共享通知', '所有有权查看者', '不会重新检测或修复故障', '新到通知不受影响']) expect(text).toContain(fact);
  });
});
