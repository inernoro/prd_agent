import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Users, Eye } from 'lucide-react';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { listSiteViewers, type SiteViewer } from '@/services/real/webAnalytics';

/**
 * 站点访客痕迹抽屉 —— 站点 owner / 共享团队成员查看「谁看过这个站点」（防文档泄密）。
 *
 * 遵循 frontend-modal 规则：createPortal 挂 body、inline style 高度、min-h-0 滚动区、
 * overscrollBehavior:contain、ESC + 蒙版点击关闭、z-[10000]。
 * 主题：面板底色用不透明 token var(--bg-elevated)（不要用 var(--bg-card)，那是玻璃半透明，
 * 在弹窗上会透出底层）；文字走 var(--text-primary/secondary)，两套主题自动翻转。
 */
export function SiteViewersDrawer({
  siteId,
  siteTitle,
  onClose,
}: {
  siteId: string;
  siteTitle: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<SiteViewer[]>([]);
  const [total, setTotal] = useState(0);
  const [uniqueViewers, setUniqueViewers] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listSiteViewers(siteId, 0, 200);
    if (res.success) {
      setItems(res.data.items ?? []);
      setTotal(res.data.total ?? 0);
      setUniqueViewers(res.data.uniqueViewers ?? 0);
    } else {
      setError(res.error?.message ?? '加载访客记录失败');
    }
    setLoading(false);
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const formatTime = (iso: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const modal = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border flex flex-col"
        style={{
          height: '80vh',
          maxHeight: '80vh',
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-subtle, rgba(127,127,127,0.18))',
          color: 'var(--text-primary)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-start justify-between gap-3 px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-subtle, rgba(127,127,127,0.12))' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Eye size={16} style={{ color: 'var(--text-secondary)' }} />
              <span>访客痕迹</span>
            </div>
            <div
              className="mt-1 truncate text-xs"
              style={{ color: 'var(--text-secondary)' }}
              title={siteTitle}
            >
              {siteTitle}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 transition-colors hover:bg-black/10"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* Stats */}
        <div
          className="shrink-0 flex items-center gap-5 px-5 py-3 text-xs border-b"
          style={{
            color: 'var(--text-secondary)',
            borderColor: 'var(--border-subtle, rgba(127,127,127,0.12))',
          }}
        >
          <span className="inline-flex items-center gap-1.5">
            <Eye size={13} />
            访问 {total} 次
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Users size={13} />
            {uniqueViewers} 位访客
          </span>
        </div>

        {/* List (scroll area) */}
        <div
          className="flex-1 px-2 py-2"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <MapSectionLoader text="正在加载访客记录…" />
          ) : error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              {error}
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Users size={28} style={{ color: 'var(--text-secondary)', opacity: 0.5 }} />
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                暂无访客记录
              </div>
            </div>
          ) : (
            <ul className="flex flex-col">
              {items.map((v, idx) => (
                <li
                  key={`${v.viewerUserId}-${v.viewedAt}-${idx}`}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-black/5"
                >
                  <UserAvatar
                    src={resolveAvatarUrl({ avatarFileName: v.viewerAvatarFileName })}
                    alt={v.viewerName ?? ''}
                    className="h-8 w-8 shrink-0 rounded-full object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm" style={{ color: 'var(--text-primary)' }}>
                      {v.viewerName || '未知用户'}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {formatTime(v.viewedAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
