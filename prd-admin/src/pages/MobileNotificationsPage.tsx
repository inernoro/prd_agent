import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Download,
  Paperclip,
  Loader2,
} from 'lucide-react';
import { getAdminNotifications, handleAdminNotification, handleAllAdminNotifications } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';

/* ── 通知色调 ── */
const notificationTone = {
  info: { border: 'rgba(59, 130, 246, 0.4)', bg: 'rgba(59, 130, 246, 0.08)', text: '#93c5fd' },
  warning: { border: 'rgba(251, 146, 60, 0.45)', bg: 'rgba(251, 146, 60, 0.1)', text: '#fdba74' },
  error: { border: 'rgba(248, 113, 113, 0.45)', bg: 'rgba(248, 113, 113, 0.08)', text: '#fca5a5' },
  success: { border: 'rgba(34, 197, 94, 0.45)', bg: 'rgba(34, 197, 94, 0.08)', text: '#86efac' },
};

function getNotificationTone(level?: string) {
  const key = (level ?? '').toLowerCase() as keyof typeof notificationTone;
  return notificationTone[key] ?? notificationTone.info;
}

/**
 * 移动端系统通知页 — 展示全部通知，支持单条/一键处理。
 */
export default function MobileNotificationsPage() {
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [handlingIds, setHandlingIds] = useState<Set<string>>(new Set());

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    const res = await getAdminNotifications({ includeHandled: true });
    if (res.success) setNotifications(res.data.items ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void loadNotifications(); }, [loadNotifications]);

  const activeNotifications = useMemo(
    () => notifications.filter((n) => n.status === 'open'),
    [notifications],
  );

  const handledNotifications = useMemo(
    () => notifications.filter((n) => n.status === 'handled'),
    [notifications],
  );

  const handleOne = useCallback(async (id: string) => {
    setHandlingIds((s) => new Set(s).add(id));
    const res = await handleAdminNotification(id);
    if (res.success) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, status: 'handled' as const, handledAt: new Date().toISOString() } : n)),
      );
    }
    setHandlingIds((s) => { const next = new Set(s); next.delete(id); return next; });
  }, []);

  const handleAll = useCallback(async () => {
    const res = await handleAllAdminNotifications();
    if (res.success) {
      setNotifications((prev) =>
        prev.map((n) => n.status === 'open' ? { ...n, status: 'handled' as const, handledAt: new Date().toISOString() } : n),
      );
    }
  }, []);

  return (
    <div className="h-full min-h-0 overflow-auto" style={{ background: 'var(--bg-base)' }}>
      <div className="px-4 pt-4 pb-28">

        {/* ── 头部操作栏 ── */}
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {loading ? '加载中...' : `${activeNotifications.length} 条未处理`}
          </div>
          {activeNotifications.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-all active:scale-95"
              style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-primary)' }}
              onClick={handleAll}
            >
              <CheckCircle2 size={14} />
              一键处理
            </button>
          )}
        </div>

        {/* ── 未处理通知 ── */}
        {activeNotifications.length > 0 && (
          <div className="space-y-3 mb-6">
            {activeNotifications.map((item) => {
              const tone = getNotificationTone(item.level);
              const isHandling = handlingIds.has(item.id);
              return (
                <div
                  key={item.id}
                  className="rounded-2xl border px-4 py-3"
                  style={{ borderColor: tone.border, background: tone.bg }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {item.title}
                      </div>
                      {item.message && (
                        <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
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
                                background: 'rgba(255,255,255,0.06)',
                                color: 'var(--text-secondary)',
                                border: '1px solid rgba(255,255,255,0.1)',
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
                      <div className="mt-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {new Date(item.createdAt).toLocaleString('zh-CN')}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 mt-0.5 rounded-lg p-1.5 transition-all active:scale-90"
                      style={{ background: 'rgba(255,255,255,0.08)' }}
                      onClick={() => handleOne(item.id)}
                      disabled={isHandling}
                    >
                      {isHandling
                        ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                        : <CheckCircle2 size={14} style={{ color: 'var(--text-secondary)' }} />
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
            <Bell size={32} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无通知</div>
          </div>
        )}

        {/* ── 已处理通知 ── */}
        {handledNotifications.length > 0 && (
          <div>
            <div className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>
              已处理
            </div>
            <div className="space-y-2">
              {handledNotifications.slice(0, 20).map((item) => (
                <div
                  key={item.id}
                  className="surface-inset rounded-xl px-4 py-3 opacity-60"
                >
                  <div className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {item.title}
                  </div>
                  {item.message && (
                    <div className="text-[11px] mt-0.5 line-clamp-1" style={{ color: 'var(--text-muted)' }}>
                      {item.message}
                    </div>
                  )}
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {item.handledAt ? `处理于 ${new Date(item.handledAt).toLocaleString('zh-CN')}` : '已处理'}
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
