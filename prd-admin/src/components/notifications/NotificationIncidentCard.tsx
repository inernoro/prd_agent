import { useState } from 'react';
import { ArrowUpRight, CircleCheck, CircleHelp, CircleX, Route } from 'lucide-react';
import type { AdminNotificationItem, NotificationIncidentEvidence, NotificationIncidentFollowUp } from '@/services/contracts/notifications';
import { notificationEnvironment } from '@/lib/notificationPresentation';

const ACTION = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-token-subtle px-3 text-sm font-medium hover-bg-soft disabled:opacity-50';
const EVIDENCE = {
  request_failed: { label: '请求失败', description: '已确认这笔业务请求失败。', icon: CircleX, tone: 'var(--accent-fg-danger)' },
  all_failed: { label: '请求失败', description: '这笔请求尝试的线路均失败。', icon: CircleX, tone: 'var(--accent-fg-danger)' },
  fallback_succeeded: { label: '备用成功', description: '备用线路完成了这笔请求，当时故障线路仍异常。', icon: Route, tone: 'var(--accent-fg-warning)' },
  recovered: { label: '同线路恢复', description: '同一线路的真实业务请求已成功。', icon: CircleCheck, tone: 'var(--accent-fg-success)' },
  unknown: { label: '结果待确认', description: '已观察到异常，这笔请求的最终结果待确认。', icon: CircleHelp, tone: 'var(--text-secondary)' },
} as const;
const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function incidentTitle(item: AdminNotificationItem) {
  if (item.incidentState !== 'recovered') return item.title;
  if (item.level === 'success') return item.title;
  const caller = item.title.match(/ · ([^·]+)$/)?.[1];
  return caller ? `同线路已恢复 · ${caller}` : '同线路已恢复';
}

export function incidentOwnerLabel(followUp: NotificationIncidentFollowUp | null | undefined, recovered: boolean) {
  if (followUp?.owner?.isMe) return '我已接手';
  if (followUp?.owner) return `${followUp.owner.displayName || '同事'}已接手`;
  return recovered ? '已恢复' : followUp?.canAssign ? '待接手' : '待本轮观测';
}

export function NotificationIncidentCard({ item, followUp, busy, assign, confirm, open, nextStep }: {
  item: AdminNotificationItem;
  followUp: NotificationIncidentFollowUp;
  busy: boolean;
  assign: (claim: boolean) => void;
  confirm: () => void;
  open?: (url: string) => void;
  nextStep?: string;
}) {
  const { evidence, owner } = followUp;
  const recovered = item.incidentState === 'recovered';
  const StatusIcon = recovered ? CircleCheck : CircleX;
  const statusColor = recovered ? 'var(--accent-fg-success)' : 'var(--accent-fg-danger)';
  const failedCount = evidence.filter(entry => entry.outcome === 'request_failed' || entry.outcome === 'all_failed').length;
  const fallbackCount = evidence.filter(entry => entry.outcome === 'fallback_succeeded').length;
  const outcomes = [failedCount && `${failedCount} 笔失败`, fallbackCount && `${fallbackCount} 笔备用成功`].filter(Boolean).join('，');
  const [selectedEvidence, setSelectedEvidence] = useState<NotificationIncidentEvidence>();
  const currentEvidence = evidence.find(entry => selectedEvidence && entry.observedAt === selectedEvidence.observedAt
    && entry.outcome === selectedEvidence.outcome && entry.requestId === selectedEvidence.requestId) ?? evidence.at(-1);
  const hasLogs = Boolean(item.actionUrl || evidence.some(entry => entry.actionUrl));
  const next = nextStep ?? (recovered
    ? failedCount > 0 ? '核对失败任务是否需要补做。' : '可查看恢复证据，并核对此前的任务结果。'
    : !hasLogs ? '请联系有网关权限的管理员核对故障。'
    : item.incidentCategory === 'quota' ? '核对供应商账户额度和可用线路。'
    : item.incidentCategory === 'rate-limit' ? '核对限流阈值、恢复窗口和受影响请求。'
    : '检查异常线路的请求记录，等待同线路成功。');

  return <div className="space-y-4 text-sm">
    <div className="flex items-start gap-3">
      <StatusIcon size={22} className="mt-0.5 shrink-0" aria-hidden="true" style={{ color: statusColor }} />
      <div className="min-w-0">
        <h3 className="break-words text-lg font-semibold leading-snug text-token-primary">{incidentTitle(item)}</h3>
        <p className="mt-1 text-xs text-token-secondary"><strong className="text-token-primary">环境 {notificationEnvironment(item) || '待确认'}</strong>
          {item.sourceLabel && <span className="ml-2">{item.sourceLabel}</span>}</p>
      </div>
    </div>

    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-token-subtle bg-token-nested p-3">
      <div><dt className="text-xs text-token-secondary">已收录的请求影响</dt>
        <dd className="mt-1 font-semibold text-token-primary">{outcomes || '暂无已确认的请求结果'}</dd></div>
      <div><dt className="text-xs text-token-secondary">服务状态</dt>
        <dd className="mt-1 font-semibold" style={{ color: statusColor }}>{recovered ? '已验证恢复' : '异常，等待恢复证据'}</dd></div>
      <div className="col-span-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <dt className="text-xs text-token-secondary">跟进状态</dt>
        <dd className="font-semibold text-token-primary" aria-live="polite">{incidentOwnerLabel(followUp, recovered)}</dd></div>
    </dl>

    <section aria-label="下一步">
      <h4 className="text-xs font-semibold text-token-primary">下一步</h4>
      <p className="mt-1 text-token-secondary">{next}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {followUp.canAssign && (!owner || owner.isMe) && <button type="button" className={ACTION} disabled={busy}
          style={owner ? undefined : { background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
          onClick={() => assign(!owner)}>{owner ? '取消接手' : '标记接手'}</button>}
        {item.status === 'open' && <button type="button" className={ACTION} disabled={busy} onClick={confirm}>确认通知</button>}
      </div>
    </section>

    <section aria-label="证据回放" className="space-y-2 border-t border-token-subtle pt-3">
      <h4 className="text-xs font-semibold text-token-primary">证据回放</h4>
      {evidence.length > 0 ? <div className="flex max-h-44 flex-wrap gap-1.5 overflow-auto px-0.5 py-1" role="group" aria-label="按时间查看已收录证据">
        {evidence.map((entry, index) => {
          const event = EVIDENCE[entry.outcome];
          const Icon = event.icon;
          return <button key={`${entry.observedAt}:${entry.outcome}:${entry.requestId || index}`} type="button"
            aria-pressed={entry === currentEvidence} onClick={() => setSelectedEvidence(entry)}
            className="min-h-11 rounded-lg border border-token-subtle px-2.5 py-1.5 text-left text-xs hover-bg-soft"
            style={entry === currentEvidence ? { borderColor: 'var(--accent-fg-blue)', background: 'var(--bg-card-hover)' } : undefined}>
            <time className="block text-token-secondary" dateTime={entry.observedAt}>{timeFormat.format(new Date(entry.observedAt))}</time>
            <span className="mt-0.5 flex items-center gap-1.5" style={{ color: event.tone }}><Icon size={13} aria-hidden="true" />{event.label}</span>
          </button>;
        })}
      </div> : <p className="text-xs text-token-secondary">暂无可核实的请求证据。</p>}
      {currentEvidence && <div className="space-y-1" aria-live="polite">
        <p className="text-token-secondary">{EVIDENCE[currentEvidence.outcome].description}</p>
        {currentEvidence.requestId && <p className="break-all text-xs text-token-secondary">请求编号 <code className="select-all">{currentEvidence.requestId}</code></p>}
        {currentEvidence.actionUrl && open && <button type="button" className={ACTION} disabled={busy} onClick={() => open(currentEvidence.actionUrl!)}>
          查看网关请求 <ArrowUpRight size={14} aria-hidden="true" />
        </button>}
      </div>}
    </section>
  </div>;
}
