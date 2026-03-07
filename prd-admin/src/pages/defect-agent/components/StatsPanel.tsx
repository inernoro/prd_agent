import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { useDefectStore } from '@/stores/defectStore';
import {
  getDefectStatsOverview,
  getDefectStatsTrend,
  getDefectStatsByUser,
} from '@/services';
import type {
  DefectStatsOverview,
  UserStatItem,
} from '@/services/contracts/defectAgent';
import {
  Bug,
  AlertTriangle,
  Clock,
  TrendingUp,
  CheckCircle,
  BarChart3,
  Users,
  RefreshCw,
} from 'lucide-react';

const statusLabels: Record<string, string> = {
  draft: '草稿',
  pending: '待处理',
  working: '处理中',
  verifying: '待验收',
  resolved: '已解决',
  rejected: '已驳回',
  closed: '已关闭',
};

const statusColors: Record<string, string> = {
  draft: '#64748b',
  pending: '#f59e0b',
  working: '#3b82f6',
  verifying: '#8b5cf6',
  resolved: '#22c55e',
  rejected: '#ef4444',
  closed: '#6b7280',
};

const severityLabels: Record<string, string> = {
  critical: '致命',
  major: '严重',
  minor: '一般',
  trivial: '轻微',
};

const severityColors: Record<string, string> = {
  critical: '#ef4444',
  major: '#f97316',
  minor: '#eab308',
  trivial: '#22c55e',
};

export function StatsPanel() {
  const { projectFilter, teamFilter } = useDefectStore();
  const [overview, setOverview] = useState<DefectStatsOverview | null>(null);
  const [trend, setTrend] = useState<{ created: Record<string, number>; closed: Record<string, number> } | null>(null);
  const [byUser, setByUser] = useState<{ byAssignee: UserStatItem[]; byReporter: UserStatItem[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStats = async () => {
    setLoading(true);
    const params = {
      projectId: projectFilter || undefined,
      teamId: teamFilter || undefined,
    };
    const [ov, tr, bu] = await Promise.all([
      getDefectStatsOverview(params),
      getDefectStatsTrend({ ...params, period: 'day' }),
      getDefectStatsByUser(params),
    ]);
    if (ov.success && ov.data) setOverview(ov.data);
    if (tr.success && tr.data) setTrend(tr.data);
    if (bu.success && bu.data) setByUser(bu.data);
    setLoading(false);
  };

  useEffect(() => {
    void loadStats();
  }, [projectFilter, teamFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-muted)' }}>
        <RefreshCw size={16} className="animate-spin mr-2" />
        加载统计数据...
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="text-center py-16 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        暂无统计数据
      </div>
    );
  }

  // Trend chart: simple bar visualization
  const trendEntries = trend ? Object.entries(trend.created).sort(([a], [b]) => a.localeCompare(b)).slice(-14) : [];
  const trendMax = trendEntries.length > 0 ? Math.max(...trendEntries.map(([, v]) => v), 1) : 1;

  return (
    <div className="space-y-4 p-1">
      {/* Overview Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Bug} label="总缺陷" value={overview.total} color="#6366f1" />
        <StatCard icon={AlertTriangle} label="未关闭" value={overview.openCount} color="#f59e0b" />
        <StatCard icon={TrendingUp} label="本周新增" value={overview.thisWeekCount} color="#3b82f6" />
        <StatCard
          icon={Clock}
          label="平均解决"
          value={overview.avgResolutionHours > 0 ? `${overview.avgResolutionHours.toFixed(1)}h` : '-'}
          color="#22c55e"
        />
      </div>

      {/* Status + Severity Distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Status Distribution */}
        <GlassCard animated variant="subtle">
          <div className="text-[12px] font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <BarChart3 size={14} />
            状态分布
          </div>
          <div className="space-y-2">
            {Object.entries(overview.statusCounts)
              .filter(([, count]) => count > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([status, count]) => (
                <div key={status} className="flex items-center gap-2">
                  <span className="text-[11px] w-14 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {statusLabels[status] || status}
                  </span>
                  <div className="flex-1 h-5 rounded-md overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    <div
                      className="h-full rounded-md transition-all duration-500"
                      style={{
                        width: `${Math.max((count / overview.total) * 100, 4)}%`,
                        background: statusColors[status] || '#6366f1',
                        opacity: 0.7,
                      }}
                    />
                  </div>
                  <span className="text-[11px] w-8 shrink-0 font-mono" style={{ color: statusColors[status] || 'var(--text-secondary)' }}>
                    {count}
                  </span>
                </div>
              ))}
          </div>
        </GlassCard>

        {/* Severity Distribution */}
        <GlassCard animated variant="subtle">
          <div className="text-[12px] font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <AlertTriangle size={14} />
            严重程度
          </div>
          <div className="space-y-2">
            {Object.entries(overview.severityCounts)
              .filter(([, count]) => count > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([severity, count]) => (
                <div key={severity} className="flex items-center gap-2">
                  <span className="text-[11px] w-14 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {severityLabels[severity] || severity}
                  </span>
                  <div className="flex-1 h-5 rounded-md overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    <div
                      className="h-full rounded-md transition-all duration-500"
                      style={{
                        width: `${Math.max((count / overview.total) * 100, 4)}%`,
                        background: severityColors[severity] || '#6366f1',
                        opacity: 0.7,
                      }}
                    />
                  </div>
                  <span className="text-[11px] w-8 shrink-0 font-mono" style={{ color: severityColors[severity] || 'var(--text-secondary)' }}>
                    {count}
                  </span>
                </div>
              ))}
          </div>
        </GlassCard>
      </div>

      {/* Trend Chart */}
      {trendEntries.length > 0 && (
        <GlassCard animated variant="subtle">
          <div className="text-[12px] font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <TrendingUp size={14} />
            近两周趋势（新增）
          </div>
          <div className="flex items-end gap-1 h-24">
            {trendEntries.map(([date, count]) => {
              const closed = trend?.closed[date] || 0;
              return (
                <div key={date} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                  <div
                    className="w-full rounded-t-sm transition-all duration-300"
                    style={{
                      height: `${Math.max((count / trendMax) * 80, 2)}px`,
                      background: 'rgba(99,102,241,0.5)',
                    }}
                    title={`${date}: 新增 ${count}, 关闭 ${closed}`}
                  />
                  <span className="text-[9px] hidden md:block" style={{ color: 'var(--text-muted)' }}>
                    {date.slice(5)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-2">
            <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              <span className="w-2 h-2 rounded-sm" style={{ background: 'rgba(99,102,241,0.5)' }} /> 新增
            </span>
          </div>
        </GlassCard>
      )}

      {/* User Leaderboard */}
      {byUser && (byUser.byAssignee.length > 0 || byUser.byReporter.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Assignee Leaderboard */}
          {byUser.byAssignee.length > 0 && (
            <GlassCard animated variant="subtle">
              <div className="text-[12px] font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Users size={14} />
                处理排行
              </div>
              <div className="space-y-1.5">
                {byUser.byAssignee.slice(0, 8).map((item, idx) => (
                  <div key={item.userId} className="flex items-center gap-2 text-[12px]">
                    <span
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{
                        background: idx < 3 ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.06)',
                        color: idx < 3 ? 'rgba(99,102,241,0.9)' : 'var(--text-muted)',
                      }}
                    >
                      {idx + 1}
                    </span>
                    <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                      {item.userName}
                    </span>
                    <span className="font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                      <span style={{ color: '#3b82f6' }}>{item.assignedCount ?? 0}</span>
                      {' / '}
                      <span style={{ color: '#22c55e' }}>{item.resolvedCount ?? 0}</span>
                    </span>
                  </div>
                ))}
                <div className="text-[10px] mt-1 flex gap-3" style={{ color: 'var(--text-muted)' }}>
                  <span><span style={{ color: '#3b82f6' }}>蓝</span>=分配</span>
                  <span><span style={{ color: '#22c55e' }}>绿</span>=已解决</span>
                </div>
              </div>
            </GlassCard>
          )}

          {/* Reporter Leaderboard */}
          {byUser.byReporter.length > 0 && (
            <GlassCard animated variant="subtle">
              <div className="text-[12px] font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <CheckCircle size={14} />
                提交排行
              </div>
              <div className="space-y-1.5">
                {byUser.byReporter.slice(0, 8).map((item, idx) => (
                  <div key={item.userId} className="flex items-center gap-2 text-[12px]">
                    <span
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{
                        background: idx < 3 ? 'rgba(249,115,22,0.2)' : 'rgba(255,255,255,0.06)',
                        color: idx < 3 ? 'rgba(249,115,22,0.9)' : 'var(--text-muted)',
                      }}
                    >
                      {idx + 1}
                    </span>
                    <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                      {item.userName}
                    </span>
                    <span className="font-mono shrink-0" style={{ color: '#f97316' }}>
                      {item.submittedCount ?? 0}
                    </span>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof Bug;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <GlassCard animated variant="subtle" className="flex items-center gap-3">
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: `${color}20` }}
      >
        <Icon size={18} style={{ color }} />
      </div>
      <div>
        <div className="text-[20px] font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
          {value}
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {label}
        </div>
      </div>
    </GlassCard>
  );
}
