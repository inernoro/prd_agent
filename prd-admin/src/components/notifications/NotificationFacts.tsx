import type { AdminNotificationItem } from '@/services/contracts/notifications';
import { NOTIFICATION_INCIDENT_STATE, NOTIFICATION_REQUEST_OUTCOME } from '@/lib/notificationPresentation';

const time = (value: string) => new Date(value).toLocaleString();

/** 状态与请求结果由生产者提供；不从标题、级别或确认状态猜测恢复。 */
export function NotificationFacts({ item }: { item: AdminNotificationItem }) {
  if (!item.incidentId && !item.incidentState) return (
    <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
      通知发生于 {time(item.createdAt)}
    </div>
  );
  return (
    <div className="mt-2 space-y-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
      <div>{NOTIFICATION_INCIDENT_STATE[item.incidentState ?? 'unknown'] ?? NOTIFICATION_INCIDENT_STATE.unknown} · {NOTIFICATION_REQUEST_OUTCOME[item.requestOutcome ?? 'unknown'] ?? NOTIFICATION_REQUEST_OUTCOME.unknown}</div>
      {item.incidentId && item.occurrenceCount != null && <div>同一故障已记录 {item.occurrenceCount} 次{(item.pushEpisode ?? 0) > 0 ? ` · 第 ${(item.pushEpisode ?? 0) + 1} 轮` : ''}</div>}
      {!item.incidentId && <div>历史通知缺少故障身份，无法确认独立故障数或发生次数。</div>}
      {item.firstOccurredAt && <div>首次记录：{time(item.firstOccurredAt)}</div>}
      {item.lastOccurredAt && <div>最近发生：{time(item.lastOccurredAt)}</div>}
      {item.recoveredAt && item.incidentState === 'recovered' && <div>恢复证据时间：{time(item.recoveredAt)}</div>}
      {item.evidenceRequestId && <details onClick={event => event.stopPropagation()}><summary className="cursor-pointer">定位编号</summary><span>{item.evidenceRequestId}</span></details>}
      {item.status === 'handled' && <div>通知已确认；确认不代表故障已修复。</div>}
    </div>
  );
}
