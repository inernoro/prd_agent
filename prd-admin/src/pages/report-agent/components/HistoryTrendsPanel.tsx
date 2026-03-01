import { useState, useEffect, useMemo } from 'react';
import { BarChart3, TrendingUp, GitCommit, CalendarCheck, Users, ChevronDown } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';

import { getPersonalTrends, getTeamTrends } from '@/services';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import type { PersonalTrendItem, TeamTrendItem } from '@/services/contracts/reportAgent';

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  'not-started': { label: '未开始', color: 'var(--text-muted)' },
  draft: { label: '草稿', color: '#f59e0b' },
  submitted: { label: '已提交', color: '#3b82f6' },
  reviewed: { label: '已审阅', color: '#22c55e' },
  returned: { label: '已退回', color: '#ef4444' },
  overdue: { label: '逾期', color: '#ef4444' },
  vacation: { label: '请假', color: '#8b5cf6' },
};

export function HistoryTrendsPanel() {
  const [mode, setMode] = useState<'personal' | 'team'>('personal');
  const [weeks, setWeeks] = useState(12);
  const [personalData, setPersonalData] = useState<PersonalTrendItem[]>([]);
  const [teamData, setTeamData] = useState<TeamTrendItem[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const teams = useReportAgentStore((s) => s.teams);
  const userId = useAuthStore((s) => s.user?.userId);

  const isLeader = useMemo(() => {
    return teams.some((t) => t.leaderUserId === userId);
  }, [teams, userId]);

  // Auto-select first team
  useEffect(() => {
    if (teams.length > 0 && !selectedTeamId) {
      setSelectedTeamId(teams[0].id);
    }
  }, [teams, selectedTeamId]);

  // Fetch data
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        if (mode === 'personal') {
          const res = await getPersonalTrends({ weeks });
          if (res.success && res.data) setPersonalData(res.data.items);
        } else if (selectedTeamId) {
          const res = await getTeamTrends({ teamId: selectedTeamId, weeks });
          if (res.success && res.data) setTeamData(res.data.items);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    void fetchData();
  }, [mode, weeks, selectedTeamId]);

  // Compute stats
  const personalStats = useMemo(() => {
    if (personalData.length === 0) return null;
    const submitted = personalData.filter(d => ['submitted', 'reviewed'].includes(d.reportStatus)).length;
    const totalCommits = personalData.reduce((s, d) => s + d.commitCount, 0);
    const totalLogDays = personalData.reduce((s, d) => s + d.dailyLogDays, 0);
    return {
      submissionRate: Math.round(submitted / personalData.length * 100),
      totalCommits,
      avgCommitsPerWeek: Math.round(totalCommits / personalData.length),
      totalLogDays,
    };
  }, [personalData]);

  const teamStats = useMemo(() => {
    if (teamData.length === 0) return null;
    const avgSubmissionRate = Math.round(teamData.reduce((s, d) => s + d.submissionRate, 0) / teamData.length);
    const totalCommits = teamData.reduce((s, d) => s + d.commitCount, 0);
    const totalOverdue = teamData.reduce((s, d) => s + d.overdueCount, 0);
    return { avgSubmissionRate, totalCommits, totalOverdue };
  }, [teamData]);

  const maxCommit = useMemo(() => {
    const data = mode === 'personal' ? personalData : teamData;
    return Math.max(1, ...data.map(d => d.commitCount));
  }, [mode, personalData, teamData]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-auto">
      {/* Controls */}
      <GlassCard variant="subtle" className="px-4 py-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <BarChart3 size={16} style={{ color: 'var(--text-secondary)' }} />
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>数据统计</span>
          </div>

          <div className="flex items-center gap-3">
            {/* Mode switch */}
            <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-tertiary)' }}>
              <button
                className="px-3 py-1 rounded-md text-[12px] transition-all"
                style={{
                  background: mode === 'personal' ? 'var(--bg-primary)' : 'transparent',
                  color: mode === 'personal' ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: mode === 'personal' ? 500 : 400,
                }}
                onClick={() => setMode('personal')}
              >
                个人趋势
              </button>
              {isLeader && (
                <button
                  className="px-3 py-1 rounded-md text-[12px] transition-all"
                  style={{
                    background: mode === 'team' ? 'var(--bg-primary)' : 'transparent',
                    color: mode === 'team' ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: mode === 'team' ? 500 : 400,
                  }}
                  onClick={() => setMode('team')}
                >
                  团队趋势
                </button>
              )}
            </div>

            {/* Team selector (team mode) */}
            {mode === 'team' && (
              <div className="relative">
                <select
                  value={selectedTeamId}
                  onChange={(e) => setSelectedTeamId(e.target.value)}
                  className="px-3 py-1.5 rounded-lg text-[12px] appearance-none pr-7"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-primary)',
                  }}
                >
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
              </div>
            )}

            {/* Weeks selector */}
            <div className="relative">
              <select
                value={weeks}
                onChange={(e) => setWeeks(Number(e.target.value))}
                className="px-3 py-1.5 rounded-lg text-[12px] appearance-none pr-7"
                style={{
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-primary)',
                }}
              >
                <option value={4}>最近 4 周</option>
                <option value={8}>最近 8 周</option>
                <option value={12}>最近 12 周</option>
                <option value={24}>最近 24 周</option>
                <option value={52}>过去一年</option>
              </select>
              <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>
        </div>
      </GlassCard>

      {loading && (
        <div className="text-center py-8 text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      )}

      {!loading && mode === 'personal' && (
        <>
          {/* Personal stats summary */}
          {personalStats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard icon={<TrendingUp size={14} />} label="提交率" value={`${personalStats.submissionRate}%`} />
              <StatCard icon={<GitCommit size={14} />} label="总提交数" value={String(personalStats.totalCommits)} />
              <StatCard icon={<GitCommit size={14} />} label="周均提交" value={String(personalStats.avgCommitsPerWeek)} />
              <StatCard icon={<CalendarCheck size={14} />} label="打点天数" value={String(personalStats.totalLogDays)} />
            </div>
          )}

          {/* Personal weekly chart */}
          <GlassCard className="p-4">
            <div className="text-[12px] font-medium mb-3" style={{ color: 'var(--text-primary)' }}>周报提交 & 代码提交趋势</div>
            <div className="flex flex-col gap-1.5">
              {personalData.map((item) => {
                const status = STATUS_LABELS[item.reportStatus] ?? STATUS_LABELS['not-started'];
                const barWidth = Math.max(4, (item.commitCount / maxCommit) * 100);
                return (
                  <div key={`${item.weekYear}-${item.weekNumber}`} className="flex items-center gap-2">
                    <div className="w-[60px] text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                      W{item.weekNumber}
                    </div>
                    <div className="w-[52px] shrink-0">
                      <span
                        className="inline-block px-1.5 py-0.5 rounded text-[10px]"
                        style={{ background: `${status.color}20`, color: status.color }}
                      >
                        {status.label}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div
                        className="h-[18px] rounded-sm transition-all"
                        style={{
                          width: `${barWidth}%`,
                          background: `linear-gradient(90deg, rgba(59,130,246,0.6), rgba(59,130,246,0.3))`,
                        }}
                      />
                    </div>
                    <div className="w-[50px] text-right text-[11px] shrink-0" style={{ color: 'var(--text-secondary)' }}>
                      {item.commitCount} 次
                    </div>
                    <div className="w-[36px] text-right text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {item.dailyLogDays}d
                    </div>
                  </div>
                );
              })}
            </div>
            {personalData.length === 0 && (
              <div className="text-center py-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            )}
          </GlassCard>
        </>
      )}

      {!loading && mode === 'team' && (
        <>
          {/* Team stats summary */}
          {teamStats && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <StatCard icon={<Users size={14} />} label="平均提交率" value={`${teamStats.avgSubmissionRate}%`} />
              <StatCard icon={<GitCommit size={14} />} label="总提交数" value={String(teamStats.totalCommits)} />
              <StatCard icon={<TrendingUp size={14} />} label="逾期总次" value={String(teamStats.totalOverdue)} color={teamStats.totalOverdue > 0 ? '#ef4444' : undefined} />
            </div>
          )}

          {/* Team weekly chart */}
          <GlassCard className="p-4">
            <div className="text-[12px] font-medium mb-3" style={{ color: 'var(--text-primary)' }}>团队提交率 & 代码趋势</div>
            <div className="flex flex-col gap-1.5">
              {teamData.map((item) => {
                const rateWidth = Math.max(4, item.submissionRate);
                const commitWidth = Math.max(4, (item.commitCount / maxCommit) * 100);
                return (
                  <div key={`${item.weekYear}-${item.weekNumber}`} className="flex items-center gap-2">
                    <div className="w-[60px] text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                      W{item.weekNumber}
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      {/* Submission rate bar */}
                      <div className="flex items-center gap-1">
                        <div
                          className="h-[10px] rounded-sm"
                          style={{
                            width: `${rateWidth}%`,
                            background: `linear-gradient(90deg, rgba(34,197,94,0.7), rgba(34,197,94,0.3))`,
                          }}
                        />
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {item.submissionRate}%
                        </span>
                      </div>
                      {/* Commit bar */}
                      <div className="flex items-center gap-1">
                        <div
                          className="h-[10px] rounded-sm"
                          style={{
                            width: `${commitWidth}%`,
                            background: `linear-gradient(90deg, rgba(59,130,246,0.6), rgba(59,130,246,0.3))`,
                          }}
                        />
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {item.commitCount}
                        </span>
                      </div>
                    </div>
                    <div className="w-[80px] text-right text-[11px] shrink-0" style={{ color: 'var(--text-secondary)' }}>
                      {item.submittedCount}/{item.memberCount}
                      {item.overdueCount > 0 && (
                        <span style={{ color: '#ef4444', marginLeft: 4 }}>
                          +{item.overdueCount}逾期
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {teamData.length === 0 && (
              <div className="text-center py-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            )}
          </GlassCard>

          {/* Legend */}
          <div className="flex items-center gap-4 px-1">
            <div className="flex items-center gap-1">
              <div className="w-3 h-2 rounded-sm" style={{ background: 'rgba(34,197,94,0.5)' }} />
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>提交率</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-2 rounded-sm" style={{ background: 'rgba(59,130,246,0.5)' }} />
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>代码提交</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <GlassCard variant="subtle" className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div style={{ color: color ?? 'var(--text-muted)' }}>{icon}</div>
        <div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
          <div className="text-[16px] font-semibold" style={{ color: color ?? 'var(--text-primary)' }}>{value}</div>
        </div>
      </div>
    </GlassCard>
  );
}
