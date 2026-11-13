import type { AdminNotificationItem } from '@/services/contracts/notifications';

export const NOTIFICATION_INCIDENT_STATE: Record<string, string> = {
  active: '最近观测异常，尚无恢复证据', recovered: '已有恢复证据', unknown: '当前状态未确认',
};
export const NOTIFICATION_REQUEST_OUTCOME: Record<string, string> = {
  request_failed: '该次请求失败', fallback_succeeded: '该次请求备用成功', all_failed: '该次请求已尝试线路均失败', unknown: '该次请求结果未确认',
};

/** 只屏蔽当前故障代次和严重程度；复发、升级和恢复均重新可见。 */
export function notificationToastKey(item: AdminNotificationItem): string {
  return `${item.id}:${item.pushEpisode ?? 0}:${item.level}:${item.incidentState ?? 'unknown'}`;
}

export function notificationBatchConfirmation(items: AdminNotificationItem[]): string {
  const shared = items.filter(item => !item.targetUserId).length;
  return `确认当前列表中的 ${items.length} 条通知？${shared ? `其中 ${shared} 条为共享通知，确认结果对所有有权查看者生效。` : '仅影响这些个人通知。'}仅将通知标记为已处理，不会重新检测或修复故障；新到通知不受影响。`;
}
