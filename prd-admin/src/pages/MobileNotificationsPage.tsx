import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Download,
  Paperclip,
} from 'lucide-react';
import { getAdminNotifications } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getNotificationType, isEscalationNotification } from '@/lib/notificationTypeRegistry';
import { AS_COLOR, AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';
import { NotificationFacts } from '@/components/notifications/NotificationFacts';
import { useNotificationActions } from '@/components/notifications/useNotificationActions';
import type { GetAdminNotificationsResponse } from '@/services/contracts/notifications';
import { toast } from '@/lib/toast';

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

/**
 * 移动端系统通知页 — 展示全部通知，支持单条/确认当前 {activeNotifications.length} 条通知。
 * App Store 设计系统：纯黑/白双皮肤 + iOS 系统色 + SF 字体。
 */
export default function MobileNotificationsPage() {
  const C = useAppStoreColors();
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<GetAdminNotificationsResponse['summary']>();
  const [hasMore, setHasMore] = useState(false);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAdminNotifications({ includeHandled: true });
      if (res.success) {
        setNotifications(res.data.items ?? []);
        setSummary(res.data.summary);
        setHasMore(Boolean(res.data.hasMore));
      } else toast.error('通知读取失败', res.error?.message ?? '请稍后刷新重试。');
    } catch { toast.error('通知读取失败', '请稍后刷新重试，已有列表已保留。'); }
    finally { setLoading(false); }
  }, []);
  const { openNotification, confirmNotifications, handlingId, handlingAll } = useNotificationActions({ refresh: loadNotifications });

  useEffect(() => { void loadNotifications(); }, [loadNotifications]);

  const sortByCreatedDesc = (a: AdminNotificationItem, b: AdminNotificationItem) => {
    const ta = new Date(a.createdAt).getTime() || 0;
    const tb = new Date(b.createdAt).getTime() || 0;
    return tb - ta;
  };

  // 用户要求：通知不再出现催办。兜底过滤已下线的催办/超时提醒残留。
  const visibleNotifications = useMemo(
    () => notifications.filter((n) => !isEscalationNotification(n)),
    [notifications],
  );

  const activeNotifications = useMemo(
    () => visibleNotifications.filter((n) => n.status === 'open').slice().sort(sortByCreatedDesc),
    [visibleNotifications],
  );

  const handledNotifications = useMemo(
    () => visibleNotifications.filter((n) => n.status === 'handled').slice().sort(sortByCreatedDesc),
    [visibleNotifications],
  );


  return (
    <div className="h-full min-h-0 overflow-auto" style={{ background: C.bg, fontFamily: AS_FONT_FAMILY }}>
      <div className="px-4 pt-4 pb-28">

        {/* ── 头部操作栏 ── */}
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs" style={{ color: C.labelSecondary }}>
            {loading ? '加载中...' : `${activeNotifications.length} 条待确认通知`}
          </div>
          {activeNotifications.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-transform active:scale-95"
              style={{ background: C.pillBg, color: C.blue }}
              onClick={() => void confirmNotifications(activeNotifications, true)}
              disabled={handlingAll || Boolean(handlingId)}
            >
              <CheckCircle2 size={14} />
              确认当前 {activeNotifications.length} 条通知
            </button>
          )}
        </div>

        <div className="mb-3 text-[11px] leading-relaxed" style={{ color: C.labelSecondary }}>
          {summary && <div>{summary.independentIncidentCount} 个已识别独立故障 · {summary.unclassifiedCount} 条未分类通知</div>}
          <div>确认只更新通知处理状态，不代表故障已修复。共享通知的确认对所有有权查看者生效。</div>
          {hasMore && <div>当前仅显示最近一批通知；批量确认只作用于当前列表。</div>}
          <button type="button" className="mt-1 underline" disabled={loading} onClick={() => void loadNotifications()}>刷新通知列表</button>
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
                    borderColor: `${variant.accent}55`,
                    background: getToneBg(item.level),
                    cursor: clickable ? 'pointer' : 'default',
                  }}
                  onClick={clickable ? () => void openNotification(item) : undefined}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{ background: `${variant.accent}1f`, color: variant.fg }}
                        >
                          <ItemTypeIcon size={11} />
                          {variant.label}
                        </span>
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
            <div className="text-sm" style={{ color: C.labelSecondary }}>暂无通知</div>
          </div>
        )}

        {/* ── 已处理通知 ── */}
        {handledNotifications.length > 0 && (
          <div>
            <div className="text-xs font-medium mb-3" style={{ color: C.labelSecondary }}>
              已确认通知（不代表故障已修复）
            </div>
            <div className="space-y-2">
              {handledNotifications.slice(0, 20).map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl px-4 py-3"
                  style={{ background: C.card, border: `1px solid ${C.hairline}` }}
                >
                  <div className="text-[12px] font-medium break-words" style={{ color: C.label }}>
                    {item.title}
                  </div>
                  {item.message && (
                    <div className="text-[11px] mt-0.5 line-clamp-1" style={{ color: C.labelSecondary }}>
                      {item.message}
                    </div>
                  )}
                  <NotificationFacts item={item} />
                  {item.actionUrl && <button type="button" className="mt-2 text-[12px]" style={{ color: C.blue }} onClick={() => void openNotification(item)}>{item.actionLabel || '查看对应对象'}</button>}
                  <div className="mt-1 text-[10px]" style={{ color: C.labelTertiary }}>
                    {item.handledAt ? `确认于 ${new Date(item.handledAt).toLocaleString('zh-CN')}` : '已确认通知'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
