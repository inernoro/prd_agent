import { useId, useRef, useState } from 'react';
import { ArrowUpRight, CircleCheck, CircleHelp, CircleX, Route } from 'lucide-react';
import type { AdminNotificationItem, NotificationIncidentEvidence, NotificationIncidentFollowUp } from '@/services/contracts/notifications';
import { notificationEnvironment, NOTIFICATION_REQUEST_OUTCOME } from '@/lib/notificationPresentation';

const ACTION = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-token-subtle px-3 text-sm font-medium hover-bg-soft disabled:opacity-50';
const EVIDENCE = {
  request_failed: { label: '请求失败', description: '已确认这笔业务请求失败。', icon: CircleX, tone: 'var(--accent-fg-danger)' },
  all_failed: { label: '请求失败', description: '这笔请求尝试的线路均失败。', icon: CircleX, tone: 'var(--accent-fg-danger)' },
  fallback_succeeded: { label: '备用成功', description: '备用线路完成了这笔请求，当时故障线路仍异常。', icon: Route, tone: 'var(--accent-fg-warning)' },
  recovered: { label: '同线路恢复', description: '已观测到同一线路的业务请求成功。', icon: CircleCheck, tone: 'var(--accent-fg-success)' },
  unknown: { label: '结果待核实', description: '已观察到异常，这笔请求的最终结果待核实。', icon: CircleHelp, tone: 'var(--text-secondary)' },
} as const;
const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fullTimeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

function evidenceTime(value: string, full = false) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间未记录' : (full ? fullTimeFormat : timeFormat).format(date);
}

function recoveryEvidence(followUp?: NotificationIncidentFollowUp | null) {
  return followUp?.evidence.filter(event => event.outcome === 'recovered').at(-1);
}

export function incidentLineStatus(item: AdminNotificationItem, followUp = item.incidentFollowUp) {
  if (item.incidentState === 'active') return 'active';
  const recoveredAt = recoveryEvidence(followUp)?.observedAt ?? item.recoveredAt;
  return item.incidentState === 'recovered' && recoveredAt && Number.isFinite(Date.parse(recoveredAt)) ? 'recovered' : 'unknown';
}

export function incidentLineLabel(status: ReturnType<typeof incidentLineStatus>, isRecurrence?: boolean) {
  if (status === 'recovered') return '原线路已恢复';
  if (status === 'active') return isRecurrence ? '原线路再次异常' : '原线路仍异常';
  return '当前状态待核实';
}

function requestCounts(followUp?: NotificationIncidentFollowUp | null) {
  const evidence = followUp?.evidence ?? [];
  return {
    failed: evidence.filter(event => event.outcome === 'request_failed' || event.outcome === 'all_failed').length,
    fallback: evidence.filter(event => event.outcome === 'fallback_succeeded').length,
  };
}

export function incidentTitle(item: AdminNotificationItem, followUp = item.incidentFollowUp) {
  const status = incidentLineStatus(item, followUp);
  if (status === 'unknown' && item.incidentState === 'recovered') return '恢复记录待核实';
  if (!followUp) return item.title;
  const { failed, fallback } = requestCounts(followUp);
  let result: string;
  if (status === 'recovered') {
    result = failed ? '原线路已恢复，历史失败待核对' : '恢复请求已成功';
  } else if (failed && fallback) {
    result = '有请求失败，备用线路完成了部分请求';
  } else if (failed) {
    result = followUp.isRecurrence ? '故障再次发生，有请求失败' : '有请求失败';
  } else if (fallback) {
    result = '备用线路已完成请求';
  } else {
    return item.title;
  }
  const caller = item.title.match(/ · ([^·]+)$/)?.[1];
  return caller ? `${result} · ${caller}` : result;
}

export function incidentOwnerLabel(followUp: NotificationIncidentFollowUp | null | undefined, status: ReturnType<typeof incidentLineStatus>) {
  if (followUp?.owner?.isMe) return '我已接手';
  if (followUp?.owner) return `${followUp.owner.displayName || '同事'}已接手`;
  if (status === 'recovered') return '未记录接手人';
  if (followUp?.canAssign) return followUp.isRecurrence ? '新一轮待接手' : '待接手';
  return '接手状态待核实';
}

export function IncidentStatusSummary({ item, followUp, onViewRecovery, busy }: {
  item: AdminNotificationItem;
  followUp?: NotificationIncidentFollowUp | null;
  onViewRecovery?: () => void;
  busy?: boolean;
}) {
  const status = incidentLineStatus(item, followUp);
  const evidence = recoveryEvidence(followUp);
  const { failed, fallback } = requestCounts(followUp);
  const outcomes = [failed && (status === 'recovered' ? `${failed} 笔历史失败待核对` : `${failed} 笔失败`), fallback && `${fallback} 笔备用成功`].filter(Boolean).join('，');
  const requestImpact = outcomes || (NOTIFICATION_REQUEST_OUTCOME[item.requestOutcome ?? 'unknown'] ?? NOTIFICATION_REQUEST_OUTCOME.unknown);
  const latest = followUp?.evidence.at(-1)?.observedAt ?? item.lastOccurredAt ?? item.firstOccurredAt;
  const confirmedAt = evidence?.observedAt ?? item.recoveredAt;
  const StatusIcon = status === 'recovered' ? CircleCheck : status === 'active' ? CircleX : CircleHelp;
  const tone = status === 'recovered' ? 'var(--accent-fg-success)' : status === 'active' ? 'var(--accent-fg-danger)' : 'var(--text-secondary)';
  const label = incidentLineLabel(status, followUp?.isRecurrence);
  const recoveryRequestId = evidence?.requestId ?? (item.level === 'success' ? item.evidenceRequestId : null);

  return <div className="rounded-lg border border-token-subtle bg-token-nested">
    <dl aria-label="故障当前状态" className="grid grid-cols-1 sm:grid-cols-3">
      <div className="min-w-0 px-3 py-2.5">
        <dt className="text-xs text-token-secondary">请求影响</dt>
        <dd className="mt-1">
          <span className="font-semibold text-token-primary">{requestImpact}</span>
          {outcomes && <span className="mt-0.5 block text-xs text-token-secondary">已收录的请求</span>}
        </dd>
      </div>
      <div className="min-w-0 border-t border-token-subtle px-3 py-2.5 sm:border-l sm:border-t-0">
        <dt className="text-xs text-token-secondary">线路状态</dt>
        <dd className="mt-1">
          <span className="flex items-start gap-1.5 font-semibold" style={{ color: tone }}>
            <StatusIcon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />{label}
          </span>
          {status === 'active' && <span className="mt-0.5 block text-xs text-token-secondary">
            {latest ? <>最近异常 · <time dateTime={latest}>{evidenceTime(latest)}</time></> : '等待同线路恢复证据'}
          </span>}
          {status === 'unknown' && <span className="mt-0.5 block text-xs text-token-secondary">
            {latest ? '最后可核实的观测' : '通知记录时间'} <time dateTime={latest ?? item.createdAt}>{evidenceTime(latest ?? item.createdAt, true)}</time>
          </span>}
          {status === 'recovered' && confirmedAt && <span className="mt-0.5 block break-words text-xs text-token-secondary">
            真实请求成功 · <time dateTime={confirmedAt}>{evidenceTime(confirmedAt)}</time>
          </span>}
        </dd>
      </div>
      <div className="min-w-0 border-t border-token-subtle px-3 py-2.5 sm:border-l sm:border-t-0">
        <dt className="text-xs text-token-secondary">跟进状态</dt>
        <dd className="mt-1 break-words">
          <span className="font-semibold text-token-primary" aria-live="polite">{incidentOwnerLabel(followUp, status)}</span>
          {followUp?.owner?.claimedAt && <time className="mt-0.5 block text-xs text-token-secondary" dateTime={followUp.owner.claimedAt}>
            {evidenceTime(followUp.owner.claimedAt)} 接手
          </time>}
        </dd>
      </div>
    </dl>
    {status === 'recovered' && <div aria-label="恢复证据" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-token-subtle px-3 py-2 text-xs">
      <div className="min-w-0 space-y-1">
        <p className="break-words text-token-primary">{evidence?.routeLabel || '本次故障线路'} · 同线路成功</p>
        {recoveryRequestId && <p className="break-all text-token-secondary">成功请求 <code className="select-all">{recoveryRequestId}</code></p>}
      </div>
      {onViewRecovery && <button type="button" className={ACTION} disabled={busy} onClick={onViewRecovery}>
        查看恢复证据 <ArrowUpRight size={14} aria-hidden="true" />
      </button>}
    </div>}
  </div>;
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
  const status = incidentLineStatus(item, followUp);
  const recovery = recoveryEvidence(followUp);
  const hasLogs = Boolean(item.actionUrl || evidence.some(entry => entry.actionUrl));
  const failedRequest = evidence.filter(entry => entry.actionUrl && (entry.outcome === 'request_failed' || entry.outcome === 'all_failed')).at(-1);
  const investigationUrl = failedRequest?.actionUrl || evidence.at(-1)?.actionUrl || item.actionUrl;
  const next = nextStep ?? (status === 'recovered'
    ? '核对历史失败任务是否需要补做。'
    : status === 'unknown' ? '查看最近一次有效观测，核对当前线路和请求结果。'
    : !hasLogs ? '请联系有网关权限的管理员核对故障。'
    : item.incidentCategory === 'quota' ? '核对供应商账户额度和可用线路。'
    : item.incidentCategory === 'rate-limit' ? '核对限流阈值、恢复窗口和受影响请求。'
    : '检查异常线路的请求记录，等待同线路成功。');
  const history = useRef<HTMLDetailsElement>(null);
  const confirmScopeId = useId();
  const [selectedEvidence, setSelectedEvidence] = useState<NotificationIncidentEvidence>();
  const currentEvidence = evidence.find(entry => selectedEvidence && entry.observedAt === selectedEvidence.observedAt
    && entry.outcome === selectedEvidence.outcome && entry.requestId === selectedEvidence.requestId) ?? evidence.at(-1);
  const evidenceAction = currentEvidence?.actionUrl;
  const viewRecovery = recovery ? () => {
    if (open && recovery.actionUrl) {
      open(recovery.actionUrl);
      return;
    }
    setSelectedEvidence(recovery);
    if (history.current) history.current.open = true;
    history.current?.querySelector('summary')?.focus();
  } : undefined;

  return <div className="space-y-4 text-sm">
    <header className="min-w-0">
      <h3 className="break-words text-lg font-semibold leading-snug text-token-primary">{incidentTitle(item, followUp)}</h3>
      <p className="mt-1 text-xs text-token-secondary"><strong className="text-token-primary">环境 {notificationEnvironment(item) || '待确认'}</strong>
        {item.sourceLabel && <span className="ml-2">{item.sourceLabel}</span>}</p>
    </header>
    <IncidentStatusSummary item={item} followUp={followUp} busy={busy} onViewRecovery={viewRecovery} />

    <section aria-label="下一步">
      <h4 className="text-xs font-semibold text-token-primary">下一步</h4>
      <p className="mt-1 text-token-secondary">{next}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {followUp.canAssign && (!owner || owner.isMe) && <button type="button" className={ACTION} disabled={busy}
          style={owner ? undefined : { background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
          onClick={() => assign(!owner)}>{owner ? '取消接手' : '标记接手'}</button>}
        {status !== 'recovered' && investigationUrl && open && <button type="button" className={ACTION} disabled={busy}
          onClick={() => open(investigationUrl)}>{failedRequest ? '查看失败请求' : '查看网关请求'} <ArrowUpRight size={14} aria-hidden="true" /></button>}
        {item.status === 'open' && <button type="button" className={ACTION} disabled={busy} onClick={confirm}
          aria-describedby={!item.targetUserId ? confirmScopeId : undefined}>确认通知</button>}
        {item.status === 'handled' && <span className="text-xs text-token-secondary" role="status">通知已确认</span>}
      </div>
      {!item.targetUserId && item.status === 'open' && <p id={confirmScopeId} className="mt-1 text-xs text-token-secondary">
        共享确认 · 会同步给所有有权查看的人
      </p>}
    </section>

    <details ref={history} className="border-t border-token-subtle pt-2">
      <summary className="cursor-pointer py-1 text-sm font-semibold text-token-primary">证据回放</summary>
      {evidence.length > 0 ? <div className="mt-2 flex max-h-44 flex-wrap gap-1.5 overflow-auto px-0.5 py-1" role="group" aria-label="按时间查看已收录证据">
        {evidence.map((entry, index) => {
          const event = EVIDENCE[entry.outcome];
          const Icon = event.icon;
          return <button key={`${entry.observedAt}:${entry.outcome}:${entry.requestId || index}`} type="button"
            aria-pressed={entry === currentEvidence} onClick={() => setSelectedEvidence(entry)}
            className="min-h-11 rounded-lg border border-token-subtle px-2.5 py-1.5 text-left text-xs hover-bg-soft"
            style={entry === currentEvidence ? { borderColor: 'var(--accent-fg-blue)', background: 'var(--bg-card-hover)' } : undefined}>
            <time className="block text-token-secondary" dateTime={entry.observedAt}>{evidenceTime(entry.observedAt)}</time>
            <span className="mt-0.5 flex items-center gap-1.5" style={{ color: event.tone }}><Icon size={13} aria-hidden="true" />{event.label}</span>
          </button>;
        })}
      </div> : <p className="mt-2 text-xs text-token-secondary">暂无可核实的请求证据。</p>}
      {currentEvidence && <div className="mt-2 space-y-1" aria-live="polite">
        <p className="text-token-secondary">{EVIDENCE[currentEvidence.outcome].description}</p>
        {currentEvidence.requestId && <p className="break-all text-xs text-token-secondary">请求编号 <code className="select-all">{currentEvidence.requestId}</code></p>}
        {evidenceAction && open && <button type="button" className={ACTION} disabled={busy} onClick={() => open(evidenceAction)}>
          查看网关请求 <ArrowUpRight size={14} aria-hidden="true" />
        </button>}
      </div>}
    </details>
  </div>;
}
