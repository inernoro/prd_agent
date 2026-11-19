import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Download,
  Paperclip,
  RefreshCw,
} from 'lucide-react';
import { getAdminNotifications } from '@/services';
import type { AdminNotificationItem, GetAdminNotificationsResponse, NotificationListState, NotificationPriority } from '@/services/contracts/notifications';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getNotificationType, isEscalationNotification } from '@/lib/notificationTypeRegistry';
import { AS_COLOR, AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';
import { NotificationFacts } from '@/components/notifications/NotificationFacts';
import { useNotificationActions } from '@/components/notifications/useNotificationActions';
import { toast } from '@/lib/toast';
import { NOTIFICATION_PRIORITIES, notificationPriority } from '@/lib/notificationPresentation';

/* ── 通知色调背景（iOS 语义色轻底，双主题通用；卡片边框/徽章走 registry 的 accent） ── */
const TONE_BG: Record<string, string> = {
  info: `${AS_COLOR.blue}14`,
  warning: `${AS_COLOR.orange}1a`,
  error: `${AS_COLOR.red}14`,
  success: `${AS_COLOR.green}14`,
};
function getToneBg(level?: string) {
  return TONE_BG[(level ?? '').toLowerCase()] ?? TONE_BG.info;
}

const PRIORITIES = ['urgent', 'important', 'routine'] as const;
const STATES = [{ key: 'all', label: '全部状态' }, { key: 'open', label: '待确认' }, { key: 'archived', label: '已归档' }] as const;

function PriorityLabel({ item }: { item: AdminNotificationItem }) {
  const tone = NOTIFICATION_PRIORITIES[notificationPriority(item.level)];
  return <span className="whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-semibold"
    style={{ borderColor: 'var(--border-subtle)', color: tone.color }}>{tone.label}</span>;
}

export default function MobileNotificationsPage() {
  const C = useAppStoreColors();
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<GetAdminNotificationsResponse['summary']>();
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();
  const [priority, setPriority] = useState<NotificationPriority | 'all'>('all');
  const [state, setState] = useState<NotificationListState | 'all'>('all');
  const requestSequence = useRef(0);

  const loadPage = useCallback(async (cursor?: string) => {
    const request = ++requestSequence.current;
    setLoading(true);
    try {
      const res = await getAdminNotifications({
        includeHandled: true, cursor,
        priority: priority === 'all' ? undefined : priority,
        state: state === 'all' ? undefined : state,
      });
      if (request !== requestSequence.current) return;
      if (res.success) {
        const items = res.data.items ?? [];
        setNotifications(previous => cursor ? [...new Map([...previous, ...items].map(item => [item.id, item])).values()] : items);
        if (!cursor) setSummary(res.data.summary);
        setHasMore(Boolean(res.data.hasMore));
        setNextCursor(res.data.nextCursor || undefined);
      } else toast.error('通知读取失败', res.error?.message ?? '请稍后刷新重试。');
    } catch {
      if (request === requestSequence.current) toast.error('通知读取失败', '请稍后刷新重试，已有列表已保留。');
    } finally {
      if (request === requestSequence.current) setLoading(false);
    }
  }, [priority, state]);
  const loadNotifications = useCallback(() => loadPage(), [loadPage]);
  const { openNotification, confirmNotifications, handlingId, handlingAll } = useNotificationActions({ refresh: loadNotifications });

  useEffect(() => { void loadNotifications(); return () => { requestSequence.current += 1; }; }, [loadNotifications]);

  const sortByPriorityThenTime = (a: AdminNotificationItem, b: AdminNotificationItem) =>
    NOTIFICATION_PRIORITIES[notificationPriority(b.level)].rank - NOTIFICATION_PRIORITIES[notificationPriority(a.level)].rank
    || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);

  // 用户要求：通知不再出现催办。兜底过滤已下线的催办/超时提醒残留。
  const visibleNotifications = useMemo(
    () => notifications.filter(n => !isEscalationNotification(n)
      && (priority === 'all' || notificationPriority(n.level) === priority)
      && (state === 'all' || (n.status === 'open') === (state === 'open'))),
    [notifications, priority, state],
  );

  const activeNotifications = useMemo(
    () => visibleNotifications.filter(n => n.status === 'open').sort(sortByPriorityThenTime),
    [visibleNotifications],
  );

  const handledNotifications = useMemo(
    () => visibleNotifications.filter(n => n.status !== 'open').sort(sortByPriorityThenTime),
    [visibleNotifications],
  );


  const confirmationPage = activeNotifications.slice(0, 200);
  const filterStyle = (selected: boolean) => ({
    color: selected ? C.blue : C.labelSecondary,
    background: selected ? C.pillBg : C.card,
    borderColor: C.hairline,
  });
  return (
    <div className="h-full min-h-0 overflow-auto" style={{ background: C.bg, fontFamily: AS_FONT_FAMILY }}>
      <div className="mx-auto max-w-[1080px] px-4 pt-5 pb-24 md:px-9 md:pt-9">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-[32px]" style={{ color: C.label }}>通知中心</h1>
            <div className="mt-1 text-sm" style={{ color: C.labelSecondary }} role="status">
            {loading ? '加载中...' : `${activeNotifications.length} 条待确认通知`}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs" style={filterStyle(false)}
              disabled={loading} onClick={() => void loadNotifications()}><RefreshCw size={14} aria-hidden="true" />刷新</button>
          {confirmationPage.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-transform active:scale-95"
              style={{ background: C.pillBg, color: C.blue }}
              onClick={() => void confirmNotifications(confirmationPage, true)}
              disabled={handlingAll || Boolean(handlingId)}
            >
              <CheckCircle2 size={14} />
              确认当前 {confirmationPage.length} 条通知
            </button>
          )}
          </div>
        </header>
        <div className="mb-4 flex flex-wrap gap-3 rounded-xl border p-2 sm:items-center sm:justify-between"
          style={{ background: C.card, borderColor: C.hairline }}>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="通知优先级">
            {(['all', ...PRIORITIES] as const).map(key => <button key={key} type="button"
              aria-pressed={priority === key} className="min-h-9 rounded-lg border px-3 text-xs font-medium"
              style={filterStyle(priority === key)} onClick={() => setPriority(key)}>
              {key === 'all' ? '全部优先级' : NOTIFICATION_PRIORITIES[key].label}
            </button>)}
          </div>
          <select aria-label="通知状态" value={state} onChange={event => setState(event.target.value as typeof state)}
            className="min-h-9 rounded-lg border px-3 text-xs" style={filterStyle(false)}>
            {STATES.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </div>

        <div className="mb-3 text-[11px] leading-relaxed" style={{ color: C.labelSecondary }}>
          {summary && <div>{summary.independentIncidentCount} 个已识别独立故障 · {summary.unclassifiedCount} 条未分类通知</div>}
          <div>确认不代表故障已修复。共享通知的确认对所有有权查看者生效。</div>
          {hasMore && !nextCursor && <div>当前服务仅返回最近一批通知。</div>}
        </div>
        {/* ── 未处理通知 ── */}
        {activeNotifications.length > 0 && (
          <div className="space-y-3 mb-6">
            {activeNotifications.map((item) => {
              const variant = getNotificationType(item);
              const ItemTypeIcon = variant.icon;
              const isHandling = handlingId === item.id || handlingAll;
              const clickable = !!item.actionUrl;
              return (
                <div
                  key={item.id}
                  className="rounded-2xl border px-4 py-3"
                  style={{
                    borderColor: C.hairline,
                    background: C.card,
                    cursor: clickable ? 'pointer' : 'default',
                  }}
                  onClick={clickable ? () => void openNotification(item) : undefined}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px]" style={{ background: getToneBg(item.level), color: variant.fg }}>
                      <ItemTypeIcon size={19} aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{ background: `${variant.accent}1f`, color: variant.fg }}
                        >
                          {variant.label}
                        </span>
                        <PriorityLabel item={item} />
                      </div>
                      <div className="text-[13px] font-semibold" style={{ color: C.label }}>
                        {item.title}
                      </div>
                      {item.message && (
                        <div className="mt-1 text-[12px] leading-relaxed" style={{ color: C.labelSecondary }}>
                          {item.message}
                        </div>
                      )}
                      {item.attachments && item.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {item.attachments.map((att, idx) => (
                            <a
                              key={idx}
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px]"
                              style={{
                                background: C.surface,
                                color: C.labelSecondary,
                                border: `1px solid ${C.hairline}`,
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Paperclip size={10} />
                              <span className="truncate max-w-[120px]">{att.name}</span>
                              <Download size={10} className="shrink-0 opacity-60" />
                            </a>
                          ))}
                        </div>
                      )}
                      <NotificationFacts item={item} />
                      {item.actionUrl && <button
                        type="button"
                        className="mt-2 rounded-lg px-2 py-1.5 text-[11px]"
                        style={{ background: C.surface, color: C.blue }}
                        onClick={(event) => { event.stopPropagation(); void openNotification(item); }}
                        disabled={handlingAll || Boolean(handlingId)}
                      >{item.actionLabel || '查看对应对象'}</button>}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 mt-0.5 rounded-lg p-1.5 transition-transform active:scale-90"
                      style={{ background: C.surface }}
                      onClick={(e) => { e.stopPropagation(); void confirmNotifications([item], false); }}
                      disabled={handlingAll || Boolean(handlingId)}
                      aria-label={`确认通知：${item.title}`}
                      title="仅确认此通知，不会修复故障；共享通知的确认对所有有权查看者生效"
                    >
                      {isHandling
                        ? <MapSpinner size={14} color={C.labelSecondary} />
                        : <CheckCircle2 size={14} style={{ color: C.labelSecondary }} />
                      }
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── 空状态 ── */}
        {!loading && activeNotifications.length === 0 && handledNotifications.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Bell size={32} style={{ color: C.labelTertiary }} />
            <div className="text-sm" style={{ color: C.labelSecondary }}>当前筛选下暂无通知</div>
          </div>
        )}

        {/* ── 已处理通知 ── */}
        {handledNotifications.length > 0 && (
          <div>
            <div className="text-xs font-medium mb-3" style={{ color: C.labelSecondary }}>
              已归档通知
            </div>
            <div className="space-y-2">
              {handledNotifications.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl px-4 py-3"
                  style={{ background: C.card, border: `1px solid ${C.hairline}` }}
                >
                  <div className="text-[12px] font-medium break-words" style={{ color: C.label }}>
                    <span className="mr-2">{item.title}</span><PriorityLabel item={item} />
                  </div>
                  {item.message && (
                    <div className="text-[11px] mt-0.5 line-clamp-1" style={{ color: C.labelSecondary }}>
                      {item.message}
                    </div>
                  )}
                  <NotificationFacts item={item} />
                  {item.actionUrl && <button type="button" className="mt-2 text-[12px]" style={{ color: C.blue }} onClick={() => void openNotification(item)}>{item.actionLabel || '查看对应对象'}</button>}
                  <div className="mt-1 text-[10px]" style={{ color: C.labelTertiary }}>
                    {item.status === 'closed' ? '已归档' : item.handledAt ? `确认于 ${new Date(item.handledAt).toLocaleString('zh-CN')}` : '已确认通知'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {nextCursor && <div className="mt-5 flex justify-center">
          <button type="button" className="rounded-lg border px-5 py-2 text-sm" style={filterStyle(false)}
            disabled={loading} onClick={() => void loadPage(nextCursor)}>{loading ? '加载中…' : '加载更早通知'}</button>
        </div>}
      </div>
    </div>
  );
}
