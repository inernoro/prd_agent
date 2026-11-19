import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Bell, ChevronRight, CircleHelp, RefreshCw } from 'lucide-react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { incidentLineLabel, incidentLineStatus, incidentOwnerLabel, incidentTitle, IncidentStatusSummary, NotificationIncidentCard } from '@/components/notifications/NotificationIncidentCard';
import { useNotificationActions } from '@/components/notifications/useNotificationActions';
import { useIsDesktop } from '@/hooks/useBreakpoint';
import {
  NOTIFICATION_PRIORITIES, NOTIFICATION_REQUEST_OUTCOME,
  notificationEnvironment, notificationOutcome, notificationPriority,
} from '@/lib/notificationPresentation';
import { getNotificationType, isEscalationNotification } from '@/lib/notificationTypeRegistry';
import { toast } from '@/lib/toast';
import { assignNotificationIncident, getAdminNotifications } from '@/services';
import type { AdminNotificationItem, NotificationPriority } from '@/services/contracts/notifications';

const VIEWS = [
  { key: 'attention', label: '待关注' },
  { key: 'incidents', label: '故障接力' },
  { key: 'all', label: '全部记录' },
  { key: 'archived', label: '已归档' },
] as const;
type View = typeof VIEWS[number]['key'];
type PriorityFilter = NotificationPriority | 'all';
const PRIORITIES = ['urgent', 'important', 'routine'] as const;
const OUTCOME_LABEL = { failed: '失败', recovered: '已恢复', succeeded: '已完成', notice: '通知' };
const BUTTON = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium hover-bg-soft disabled:opacity-50';
const fullDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const shortDate = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

function isServiceAlert(item: AdminNotificationItem) {
  return Boolean(item.incidentState || item.incidentId) || item.source === 'gateway-alert' || item.source === 'llm-gateway-quota';
}

function NotificationIcon({ item, unverified = false }: { item: AdminNotificationItem; unverified?: boolean }) {
  const type = getNotificationType(item);
  const Icon = unverified ? CircleHelp : type.icon;
  const outcome = notificationOutcome(item);
  return <span role="img" aria-label={unverified ? '状态待核实' : outcome === 'notice' ? type.label : OUTCOME_LABEL[outcome]}
    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={unverified
      ? { color: 'var(--text-secondary)', background: 'var(--bg-card-hover)' }
      : { color: type.fg, background: `${type.accent}20` }}>
    <Icon size={19} aria-hidden="true" />
  </span>;
}

function PriorityLabel({ item }: { item: AdminNotificationItem }) {
  const priority = NOTIFICATION_PRIORITIES[notificationPriority(item.level)];
  return <span className="whitespace-nowrap font-semibold" style={{ color: priority.color }}>{priority.label}</span>;
}

function NotificationTime({ value, short = false }: { value: string; short?: boolean }) {
  const date = new Date(value);
  return <time dateTime={value}>{Number.isNaN(date.valueOf()) ? '时间未记录' : (short ? shortDate : fullDate).format(date)}</time>;
}

function NotificationRow({ item, incidentView, showLiveState, selected, select }: { item: AdminNotificationItem; incidentView: boolean; showLiveState: boolean; selected: boolean; select: () => void }) {
  const type = getNotificationType(item);
  const environment = notificationEnvironment(item);
  const status = incidentLineStatus(item);
  const recovered = incidentView && status === 'recovered';
  const unverified = showLiveState && isServiceAlert(item) && status === 'unknown';
  const evidenceAt = recovered || notificationOutcome(item) === 'recovered' ? item.recoveredAt : item.lastOccurredAt;
  const impact = item.requestOutcome && item.requestOutcome !== 'unknown' ? NOTIFICATION_REQUEST_OUTCOME[item.requestOutcome] : undefined;
  return <li data-notification-id={item.id} className="border-b border-token-subtle last:border-b-0">
    <button type="button" aria-current={selected ? 'true' : undefined} onClick={select}
      className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-l-2 px-3 py-3 text-left hover-bg-soft sm:px-4"
      style={{ background: selected ? 'var(--bg-card-hover)' : undefined, borderLeftColor: selected ? 'var(--accent-fg-blue)' : 'transparent' }}>
      <NotificationIcon item={recovered ? { ...item, level: 'success' } : item} unverified={unverified} />
      <span className="min-w-0">
        <span className="block break-words text-sm font-semibold leading-5 text-token-primary">{incidentView ? incidentTitle(item) : item.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-4 text-token-secondary">
          {environment && <span className="font-medium text-token-primary">环境 {environment}</span>}
          <span>{type.label}</span>
          {incidentView ? <><span>{incidentLineLabel(status, item.incidentFollowUp?.isRecurrence)}</span>
            <span>{incidentOwnerLabel(item.incidentFollowUp, status)}</span></> : <>
            {unverified && <span>当前状态待核实</span>}
            {item.incidentId && item.occurrenceCount != null && <span>记录 {item.occurrenceCount} 次</span>}
            {item.status !== 'open' && <span>{item.status === 'closed' ? '已归档' : '已确认'}</span>}
          </>}
        </span>
        {!incidentView && impact && <span className="mt-1 block text-xs leading-4 text-token-secondary lg:hidden">{impact}</span>}
      </span>
      <span className="flex min-w-0 flex-col items-end gap-1 text-xs leading-4 text-token-secondary">
        {recovered ? <span style={{ color: 'var(--accent-fg-success)' }}>恢复</span> : <PriorityLabel item={item} />}
        <span className="whitespace-nowrap tabular-nums" title={evidenceAt ? '故障证据时间' : '通知更新时间'}><NotificationTime value={evidenceAt || item.updatedAt} short /></span>
      </span>
    </button>
  </li>;
}

function NotificationDetail({ item, handling, busy, onOpen, onConfirm }: {
  item: AdminNotificationItem;
  handling: boolean;
  busy: boolean;
  onOpen: () => void;
  onConfirm: () => void;
}) {
  const environment = notificationEnvironment(item);
  const type = getNotificationType(item);
  const incident = isServiceAlert(item);
  const lineStatus = incidentLineStatus(item, null);
  const confirmScopeId = useId();
  const canViewRecovery = lineStatus === 'recovered' && item.level === 'success' && Boolean(item.actionUrl);
  const facts = [
    { label: incident ? '最近发生' : '通知时间', value: incident ? item.lastOccurredAt : item.createdAt },
    { label: '首次发生', value: item.firstOccurredAt },
    { label: '通知记录时间', value: lineStatus !== 'unknown' && !item.firstOccurredAt && !item.lastOccurredAt ? item.createdAt : null },
  ];
  const hasOccurrenceCount = item.incidentId && item.occurrenceCount != null;
  return <div className="space-y-4 text-sm">
    <div className="flex items-start gap-3">
      <NotificationIcon item={item} unverified={incident && lineStatus === 'unknown'} />
      <div className="min-w-0">
        <h3 className="break-words text-lg font-semibold leading-snug text-token-primary">{incident ? incidentTitle(item, null) : item.title}</h3>
        <div className="mt-1 text-xs text-token-secondary">
          {environment && <span className="mr-2 font-medium text-token-primary">环境 {environment}</span>}
          <PriorityLabel item={item} />
          <span className="ml-2">{type.label}</span>
        </div>
      </div>
    </div>

    {incident && <IncidentStatusSummary item={item} busy={busy} onViewRecovery={canViewRecovery ? onOpen : undefined} />}

    {incident && (hasOccurrenceCount || facts.some(fact => fact.value)) && <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {facts.map(fact => fact.value && <div key={fact.label}>
        <dt className="text-xs text-token-secondary">{fact.label}</dt>
        <dd className="mt-1 text-token-primary"><NotificationTime value={fact.value} /></dd>
      </div>)}
      {hasOccurrenceCount && <div>
        <dt className="text-xs text-token-secondary">同一故障累计</dt><dd className="mt-1 font-semibold text-token-primary">{item.occurrenceCount} 次</dd>
      </div>}
    </dl>}

    <div className="flex flex-wrap items-center gap-2">
      {item.actionUrl && !canViewRecovery && <button type="button" className={BUTTON} disabled={busy} onClick={onOpen}
        style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}>
        {item.actionLabel || '查看对应对象'} <ArrowUpRight size={15} aria-hidden="true" />
      </button>}
      {item.status === 'open' ? <button type="button" className={`${BUTTON} border border-token-subtle text-token-secondary`}
        aria-describedby={!item.targetUserId ? confirmScopeId : undefined}
        disabled={busy} onClick={onConfirm} aria-label={`确认通知：${item.title}`}>
        {handling && <MapSpinner size={13} />}确认通知
      </button> : <span className="text-xs text-token-secondary">{item.status === 'closed' ? '已归档' : '已确认通知'}</span>}
    </div>
    {item.status === 'open' && !item.targetUserId && <p id={confirmScopeId} className="text-xs leading-relaxed text-token-secondary">
      共享确认 · 会同步给所有有权查看的人
    </p>}

    {item.message && <section aria-label="通知说明">
      <h4 className="mb-1 text-xs font-semibold text-token-primary">{incident ? '情况与处理建议' : '通知内容'}</h4>
      <p className="whitespace-pre-line break-words leading-relaxed text-token-secondary">{item.message}</p>
    </section>}
    {!incident && <div className="text-xs text-token-secondary">通知时间 <NotificationTime value={item.createdAt} /></div>}
    {item.attachments && item.attachments.length > 0 && <div className="flex flex-wrap gap-2" aria-label="附件">
      {item.attachments.map((file, index) => <a key={`${file.url}-${index}`} href={file.url} target="_blank" rel="noopener noreferrer"
        className="max-w-full break-words rounded-lg border border-token-subtle px-2.5 py-1.5 text-xs hover-bg-soft">{file.name}</a>)}
    </div>}
    {item.evidenceRequestId && <div className="break-all text-xs text-token-secondary">定位编号 <code className="ml-1 select-all text-token-primary">{item.evidenceRequestId}</code></div>}

  </div>;
}

export default function MobileNotificationsPage() {
  const desktop = useIsDesktop();
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).get('view') === 'incidents' ? 'incidents' : 'attention');
  const [priority, setPriority] = useState<PriorityFilter>('all');
  const [result, setResult] = useState<{ query: string; items: AdminNotificationItem[]; nextCursor?: string; hasMore: boolean }>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<string>();
  const [showMobileDetail, setShowMobileDetail] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const requestSequence = useRef(0);
  const query = `${view}:${priority}`;
  const current = result?.query === query ? result : undefined;

  const loadPage = useCallback(async (cursor?: string) => {
    const request = ++requestSequence.current;
    setLoading(true);
    setFailed(false);
    try {
      const response = await getAdminNotifications({
        includeHandled: true, includeIncidentFollowUp: true, cursor, priority: priority === 'all' ? undefined : priority,
        state: view === 'all' ? undefined : view,
      });
      if (request !== requestSequence.current) return;
      if (!response.success) {
        setFailed(true);
        toast.error('通知读取失败', response.error?.message ?? '请稍后刷新重试。');
        return;
      }
      const items = (response.data.items ?? []).filter(item => !isEscalationNotification(item));
      setResult(previous => ({
        query, items: cursor && previous?.query === query
          ? [...new Map([...previous.items, ...items].map(item => [item.id, item])).values()] : items,
        nextCursor: response.data.nextCursor || undefined, hasMore: Boolean(response.data.hasMore),
      }));
    } catch {
      if (request === requestSequence.current) {
        setFailed(true);
        toast.error('通知读取失败', '请稍后刷新重试。');
      }
    } finally {
      if (request === requestSequence.current) setLoading(false);
    }
  }, [priority, query, view]);
  const refresh = useCallback(() => loadPage(), [loadPage]);
  const { openNotification, confirmNotifications, handlingId, handlingAll } = useNotificationActions({ refresh });
  useEffect(() => { void refresh(); return () => { requestSequence.current += 1; }; }, [refresh]);

  const notifications = current?.items ?? [];
  const incidentView = view === 'incidents';
  const serviceAlerts = view === 'attention' ? notifications.filter(isServiceAlert) : [];
  const otherNotifications = view === 'attention' ? notifications.filter(item => !isServiceAlert(item)) : notifications;
  const selectedByUser = notifications.find(item => item.id === selection);
  const selected = selectedByUser ?? serviceAlerts[0] ?? notifications[0];
  const urgentCount = view === 'attention' ? notifications.filter(item => notificationPriority(item.level) === 'urgent').length : 0;
  const confirmable = notifications.filter(item => item.status === 'open').slice(0, 200);
  const busy = assigning || handlingAll || Boolean(handlingId);
  const assign = async (item: AdminNotificationItem, episode: number, claim: boolean) => {
    if (busy) return;
    setAssigning(true);
    try {
      const response = await assignNotificationIncident(item.id, episode, claim);
      if (!response.success) toast.error('接手状态更新失败', response.error?.message ?? '请查看最新状态后重试。');
    } catch {
      toast.error('接手状态更新失败', '请查看最新状态后重试。');
    } finally {
      await refresh();
      setAssigning(false);
    }
  };
  const followUp = view === 'attention' || incidentView || selected?.level === 'success' ? selected?.incidentFollowUp : null;
  const detail = !selected ? null : followUp ? <NotificationIncidentCard
    key={`${selected.id}:${followUp.episode}`} item={selected} followUp={followUp} busy={busy}
    assign={claim => void assign(selected, followUp.episode, claim)} confirm={() => void confirmNotifications([selected], false)}
    open={actionUrl => void openNotification({ ...selected, actionUrl, actionKind: 'llm-gateway' })} />
    : <NotificationDetail item={selected} busy={busy} handling={handlingId === selected.id}
      onOpen={() => void openNotification(selected)} onConfirm={() => void confirmNotifications([selected], false)} />;
  const select = (item: AdminNotificationItem) => {
    setSelection(item.id);
    if (!desktop) setShowMobileDetail(true);
  };
  const showRows = (items: AdminNotificationItem[]) => <ul>{items.map(item => <NotificationRow key={item.id} item={item}
    incidentView={incidentView || view === 'attention' && Boolean(item.incidentFollowUp)}
    showLiveState={incidentView || view === 'attention'}
    selected={desktop && selected?.id === item.id} select={() => select(item)} />)}</ul>;
  const changeView = (next: View) => {
    if (view === next) return;
    setView(next);
    setPriority('all');
    setSelection(undefined);
    setShowMobileDetail(false);
  };

  return <div className="h-full min-h-0 overflow-auto bg-[var(--bg-base)] text-token-primary">
    <div className="mx-auto max-w-[1240px] px-4 pb-24 pt-5 sm:px-8 sm:pt-8">
      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[30px]">通知中心</h1>
          <p className="mt-1 text-sm text-token-secondary">{
            view === 'attention' ? '紧急和重要的待确认通知' : incidentView ? '查看仍在发生的故障、接手人和恢复证据'
              : view === 'all' ? '查看收到的通知和处理记录' : '查看已确认或已关闭的通知'
          }</p>
        </div>
        <button type="button" className={`${BUTTON} border border-token-subtle text-token-secondary`} disabled={loading || busy} onClick={() => void refresh()}>
          <RefreshCw size={15} aria-hidden="true" />刷新
        </button>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-token-subtle">
        <nav aria-label="通知视图" className="flex gap-4 sm:gap-6">
          {VIEWS.map(tab => <button key={tab.key} type="button" aria-pressed={view === tab.key} disabled={busy} onClick={() => changeView(tab.key)}
            className="min-h-11 whitespace-nowrap border-b-2 px-0.5 text-sm font-semibold text-token-secondary"
            style={view === tab.key ? { color: 'var(--text-primary)', borderColor: 'var(--accent-fg-blue)' } : { borderColor: 'transparent' }}>
            {tab.label}
          </button>)}
        </nav>
        <select aria-label="通知优先级" value={priority} disabled={busy} className="mb-1 min-h-9 max-w-full rounded-lg border border-token-subtle bg-token-card px-2 text-sm text-token-primary"
          onChange={event => { setPriority(event.target.value as PriorityFilter); setSelection(undefined); }}>
          <option value="all">全部级别</option>
          {PRIORITIES.filter(key => (view !== 'attention' && !incidentView) || key !== 'routine').map(key => <option key={key} value={key}>{NOTIFICATION_PRIORITIES[key].label}</option>)}
        </select>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-5">
        <section aria-label="通知列表" aria-busy={loading} className="min-w-0 overflow-hidden rounded-xl border border-token-subtle bg-token-card">
          {current && <div className="flex flex-wrap items-center justify-between gap-x-2 border-b border-token-subtle px-4 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-token-secondary" role="status">
              {view === 'attention' && notifications.length > 0 ? <>
                {current.hasMore && <span>已显示</span>}
                {urgentCount > 0 && <span style={{ color: NOTIFICATION_PRIORITIES.urgent.color }}>{urgentCount} 条紧急</span>}
                {urgentCount < notifications.length && <span style={{ color: NOTIFICATION_PRIORITIES.important.color }}>{notifications.length - urgentCount} 条重要</span>}
              </> : <span>{current.hasMore ? '已显示 ' : ''}{notifications.length} {incidentView ? '起故障' : '条通知'}</span>}
            </div>
            {!incidentView && confirmable.length > 0 && <button type="button" className={`${BUTTON} text-xs text-token-secondary`} disabled={busy || loading}
              onClick={() => void confirmNotifications(confirmable, true)}>确认当前 {confirmable.length} 条通知</button>}
          </div>}
          {serviceAlerts.length > 0 && <section aria-label="服务告警">
            <h2 className="px-4 pb-1 pt-3 text-xs font-semibold text-token-secondary">服务告警</h2>
            {showRows(serviceAlerts)}
          </section>}
          {otherNotifications.length > 0 && (view === 'attention' ? <section aria-label="其他提醒" className={serviceAlerts.length ? 'border-t border-token-subtle' : undefined}>
            <h2 className="px-4 pb-1 pt-3 text-xs font-semibold text-token-secondary">其他提醒</h2>
            {showRows(otherNotifications)}
          </section> : showRows(otherNotifications))}
          {notifications.length === 0 && <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-token-secondary" role="status">
            {loading ? <MapSpinner size={24} /> : <Bell size={24} aria-hidden="true" />}
            <p>{loading ? '正在读取通知…' : failed ? '暂时无法读取通知，请刷新重试。' : view === 'attention' ? '暂无待关注通知'
              : incidentView ? '暂无已识别的网关故障' : '当前筛选下暂无通知'}</p>
            {!loading && !failed && incidentView && <a href="/_dev/notification-handoff" className={`${BUTTON} border border-token-subtle text-token-primary`}>
              打开故障接力演练 <ChevronRight size={15} aria-hidden="true" />
            </a>}
            {!loading && !failed && (view === 'attention' || incidentView) && <button type="button" className={BUTTON} onClick={() => changeView('all')}>
              查看全部记录 <ChevronRight size={15} aria-hidden="true" />
            </button>}
          </div>}
          {current?.nextCursor && <div className="flex justify-center border-t border-token-subtle p-2">
            <button type="button" className={`${BUTTON} text-token-secondary`} disabled={loading || busy}
              onClick={() => void loadPage(current.nextCursor)}>{loading ? '加载中…' : incidentView ? '加载更多故障' : '加载更多通知'}</button>
          </div>}
        </section>
        {desktop && selected && <aside aria-labelledby="notification-detail-title" className="sticky top-4 min-w-0 rounded-xl border border-token-subtle bg-token-card px-5 pb-5 pt-4">
          <h2 id="notification-detail-title" className="mb-4 border-b border-token-subtle pb-3 text-sm font-semibold text-token-secondary">{followUp ? '故障详情' : '通知详情'}</h2>
          {detail}
        </aside>}
      </div>
    </div>
    {!desktop && <BottomSheet open={showMobileDetail && Boolean(selectedByUser)} onOpenChange={setShowMobileDetail} title={followUp ? '故障详情' : '通知详情'}>{detail}</BottomSheet>}
  </div>;
}
