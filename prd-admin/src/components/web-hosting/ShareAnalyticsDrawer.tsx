import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, BarChart3, Eye, Users, Link2, Clock, Lock, Globe } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  getSiteShareAnalytics,
  type ShareAnalyticsResult,
} from '@/services';

/**
 * 网页托管分享统计抽屉 — 用户主动分享活动的简化版 Cloudflare 仪表盘。
 *
 * 三块内容：
 *   1. 聚合卡（活跃链接 / 总分享 / 时间窗 PV / 独立 IP）
 *   2. Top 链接表（按 PV 排序，最多 10 条；含 visibility / 过期信息）
 *   3. 时间线（最近 100 条访问事件，IP 已脱敏 a.b.*.*）
 *
 * 遵循 frontend-modal 规则：createPortal 挂 body、inline height、min-h-0 滚动区、
 * overscrollBehavior:contain、ESC + 蒙版点击关闭、z-[10000]。
 * 主题：var(--bg-elevated) 底 + var(--text-primary/secondary) 字，两套主题自动翻转。
 */
export function ShareAnalyticsDrawer({
  onClose,
  scopedSiteId,
  scopedSiteTitle,
}: {
  onClose: () => void;
  /** 非空 = 仅统计该站点的分享；为空 = 跨所有站点的总分享统计 */
  scopedSiteId?: string | null;
  /** scopedSiteId 时用于标题展示 */
  scopedSiteTitle?: string | null;
}) {
  const [loading, setLoading] = useState(true);
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(7);
  const [data, setData] = useState<ShareAnalyticsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getSiteShareAnalytics(rangeDays, scopedSiteId ?? undefined);
    if (res.success) {
      setData(res.data);
    } else {
      setError(res.error?.message ?? '加载统计失败');
    }
    setLoading(false);
  }, [rangeDays, scopedSiteId]);

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

  const fmtTime = (iso: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const visibilityBadge = (v: string) => {
    if (v === 'owner-only') {
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: 'rgba(34, 197, 94, 0.12)', color: '#22c55e' }}
          title="仅创建者/团队成员可访问">
          <Lock size={9} />仅我
        </span>
      );
    }
    if (v === 'logged-in') {
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: 'rgba(96, 165, 250, 0.12)', color: '#60a5fa' }}>
          需登录
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
        style={{ background: 'rgba(249, 115, 22, 0.12)', color: '#f97316' }}
        title="任何人可访问">
        <Globe size={9} />公开
      </span>
    );
  };

  const modal = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border flex flex-col"
        style={{
          height: '85vh',
          maxHeight: '85vh',
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-subtle, rgba(127,127,127,0.18))',
          color: 'var(--text-primary)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center justify-between gap-3 px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-subtle, rgba(127,127,127,0.12))' }}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <BarChart3 size={18} style={{ color: 'var(--text-secondary)' }} />
            <span className="text-sm font-semibold">
              {scopedSiteId ? '本站点分享统计' : '分享统计'}
            </span>
            {scopedSiteId && scopedSiteTitle && (
              <span
                className="text-xs truncate"
                style={{ color: 'var(--text-secondary)' }}
                title={scopedSiteTitle}
              >
                · {scopedSiteTitle}
              </span>
            )}
            <select
              value={rangeDays}
              onChange={(e) => setRangeDays(Number(e.target.value) as 7 | 30 | 90)}
              className="ml-2 rounded-md px-2 py-1 text-xs outline-none cursor-pointer"
              style={{
                background: 'var(--bg-sunken)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-default)',
              }}
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </select>
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

        {/* Body (scroll area) */}
        <div
          className="flex-1 px-5 py-4 flex flex-col gap-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <MapSectionLoader text="正在加载统计…" />
          ) : error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              {error}
            </div>
          ) : !data ? (
            <div className="text-sm text-center py-8" style={{ color: 'var(--text-secondary)' }}>
              暂无数据
            </div>
          ) : (
            <>
              {/* 聚合卡 */}
              <div className="grid grid-cols-4 gap-3">
                <StatCard icon={<Link2 size={14} />} label="活跃链接" value={data.activeShares} sub={`共 ${data.totalShares}`} />
                <StatCard icon={<Eye size={14} />} label="时间窗 PV" value={data.totalViews} />
                <StatCard icon={<Users size={14} />} label="独立 IP" value={data.uniqueIpCount} />
                <StatCard icon={<Clock size={14} />} label="已过期" value={data.expiredShares} />
              </div>

              {/* Top 链接 */}
              {data.topLinks.length > 0 && (
                <div>
                  <div className="text-xs mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                    <Link2 size={12} />
                    Top 链接 (按 PV 排序)
                  </div>
                  <div className="flex flex-col rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border-subtle, rgba(127,127,127,0.12))' }}>
                    {data.topLinks.map((link) => (
                      <div
                        key={link.shareId}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-3 items-center px-3 py-2 text-xs border-b last:border-b-0"
                        style={{
                          background: 'var(--bg-sunken)',
                          borderColor: 'var(--border-subtle, rgba(127,127,127,0.08))',
                        }}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate" style={{ color: 'var(--text-primary)' }} title={link.title || link.token}>
                            {link.title || link.token}
                          </span>
                          {visibilityBadge(link.visibility)}
                        </div>
                        <span style={{ color: 'var(--text-secondary)' }} title="总浏览量">
                          {link.viewCount} PV
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }} title="独立 IP">
                          {link.uniqueIpCount} IP
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }} title="最后访问">
                          {link.lastViewedAt ? fmtTime(link.lastViewedAt) : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 时间线 */}
              <div>
                <div className="text-xs mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                  <Clock size={12} />
                  最近访问 (IP 已脱敏)
                </div>
                {data.timeline.length === 0 ? (
                  <div className="text-xs py-4 text-center" style={{ color: 'var(--text-secondary)' }}>
                    时间窗内暂无访问
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {data.timeline.map((entry, idx) => (
                      <div
                        key={`${entry.shareToken}-${entry.viewedAt}-${idx}`}
                        className="grid grid-cols-[80px_minmax(0,1fr)_auto_auto] gap-3 items-center px-3 py-1.5 rounded text-xs"
                        style={{ background: 'var(--bg-sunken)' }}
                      >
                        <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                          {fmtTime(entry.viewedAt)}
                        </span>
                        <span className="truncate" style={{ color: 'var(--text-primary)' }}>
                          {entry.shareTitle || entry.shareToken}
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {entry.viewerName || '匿名'}
                        </span>
                        <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                          {entry.ipAddress || '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number; sub?: string }) {
  return (
    <div
      className="flex flex-col gap-1 rounded-lg px-3 py-2.5 border"
      style={{
        background: 'var(--bg-sunken)',
        borderColor: 'var(--border-subtle, rgba(127,127,127,0.12))',
      }}
    >
      <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-xl font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {value.toLocaleString()}
      </div>
      {sub && (
        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}
