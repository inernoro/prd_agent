import { Heart, Eye, History } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import type { ReportViewSummary, ReportVersionEntry, ReportVersionEventType } from '@/services/contracts/reportAgent';
import { ReportLikeBar } from './ReportLikeBar';

export interface RightRailPanelProps {
  reportId: string;
  viewSummary: ReportViewSummary;
  versionHistory?: ReportVersionEntry[];
  fallbackTimestamps?: {
    submittedAt?: string;
    reviewedAt?: string;
    returnedAt?: string;
  };
}

function formatViewTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const EVENT_LABEL: Record<ReportVersionEventType, string> = {
  submitted: '提交',
  reviewed: '审阅通过',
  returned: '退回',
  edited: '编辑',
};

const EVENT_COLOR: Record<ReportVersionEventType, string> = {
  submitted: 'rgba(99,102,241,.95)',
  reviewed: 'rgba(16,185,129,.95)',
  returned: 'rgba(245,158,11,.95)',
  edited: 'rgba(100,116,139,.92)',
};

const EVENT_BG: Record<ReportVersionEventType, string> = {
  submitted: 'rgba(99,102,241,.14)',
  reviewed: 'rgba(16,185,129,.14)',
  returned: 'rgba(245,158,11,.14)',
  edited: 'rgba(100,116,139,.14)',
};

/**
 * 旧周报无 versionHistory 字段时，从单值时间戳推导出最近一次事件序列作为兜底。
 * 这只能覆盖"最近一次"，无法还原多次提交/退回循环。
 */
function buildFallbackHistory(ts?: RightRailPanelProps['fallbackTimestamps']): ReportVersionEntry[] {
  if (!ts) return [];
  const out: ReportVersionEntry[] = [];
  if (ts.submittedAt) out.push({ event: 'submitted', at: ts.submittedAt });
  if (ts.returnedAt) out.push({ event: 'returned', at: ts.returnedAt });
  if (ts.reviewedAt) out.push({ event: 'reviewed', at: ts.reviewedAt });
  return out;
}

export function RightRailPanel({ reportId, viewSummary, versionHistory, fallbackTimestamps }: RightRailPanelProps) {
  const rawEntries = versionHistory && versionHistory.length > 0
    ? versionHistory
    : buildFallbackHistory(fallbackTimestamps);
  // 倒序：最新事件在最上
  const sortedEntries = [...rawEntries].sort((a, b) => {
    const ta = new Date(a.at).getTime();
    const tb = new Date(b.at).getTime();
    return tb - ta;
  });

  return (
    <aside
      className="flex-none flex flex-col min-h-0 gap-3"
      style={{ width: 280 }}
    >
      {/* 点赞段 */}
      <GlassCard variant="subtle" className="px-4 py-3 flex flex-col gap-2.5">
        <div className="flex items-center gap-1.5">
          <Heart size={13} style={{ color: 'rgba(236,72,153,.92)' }} />
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>点赞</span>
        </div>
        <ReportLikeBar reportId={reportId} compact />
      </GlassCard>

      {/* 已阅段 */}
      <GlassCard variant="subtle" className="px-4 py-3 flex-1 min-h-0 flex flex-col gap-2">
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5">
            <Eye size={13} style={{ color: 'rgba(14,165,233,.92)' }} />
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>已阅</span>
          </div>
          <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            去重 {viewSummary.count} · 总计 {viewSummary.totalViewCount}
          </span>
        </div>
        <div
          className="flex-1 min-h-0 overflow-y-auto pr-1"
          style={{ overscrollBehavior: 'contain' }}
        >
          {viewSummary.users.length === 0 ? (
            <div className="text-[11px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>
              暂无浏览记录
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {viewSummary.users.map((user) => (
                <div
                  key={user.userId}
                  className="surface-inset rounded-lg px-2.5 py-2 flex items-start justify-between gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-[11.5px] truncate flex items-center gap-1"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <span className="truncate">{user.userName}</span>
                      {user.isFrequent && (
                        <span
                          className="shrink-0 text-[10px] px-1 py-0.5 rounded"
                          style={{ color: 'rgba(16,185,129,.95)', background: 'rgba(16,185,129,.14)' }}
                        >
                          常来
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {formatViewTime(user.lastViewedAt)}
                    </div>
                  </div>
                  <span
                    className="text-[10.5px] shrink-0 mt-0.5"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {user.viewCount} 次
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </GlassCard>

      {/* 版本记录段 */}
      <GlassCard variant="subtle" className="px-4 py-3 flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <History size={13} style={{ color: 'rgba(168,85,247,.92)' }} />
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>版本记录</span>
          </div>
          {sortedEntries.length > 0 && (
            <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
              {sortedEntries.length} 条
            </span>
          )}
        </div>
        {sortedEntries.length === 0 ? (
          <div className="text-[11px] py-3 text-center" style={{ color: 'var(--text-muted)' }}>
            暂无版本记录
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {sortedEntries.map((entry, idx) => (
              <div
                key={`${entry.event}-${entry.at}-${idx}`}
                className="surface-inset rounded-lg px-2.5 py-2 flex items-center justify-between gap-2"
              >
                <span
                  className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded"
                  style={{ color: EVENT_COLOR[entry.event], background: EVENT_BG[entry.event] }}
                >
                  {EVENT_LABEL[entry.event] ?? entry.event}
                </span>
                <span className="text-[10.5px]" style={{ color: 'var(--text-secondary)' }}>
                  {formatViewTime(entry.at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </GlassCard>
    </aside>
  );
}
