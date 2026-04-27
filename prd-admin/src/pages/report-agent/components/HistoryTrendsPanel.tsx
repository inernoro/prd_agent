import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useState, useEffect, useMemo } from 'react';
import { BarChart3, TrendingUp, GitCommit, CalendarCheck, Users, ChevronDown, AlertTriangle } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';

import { getPersonalTrends, getTeamTrends } from '@/services';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import type { PersonalTrendItem, TeamTrendItem } from '@/services/contracts/reportAgent';
import { useDataTheme } from '../hooks/useDataTheme';

function buildStatusLabels(isLight: boolean): Record<string, { label: string; color: string }> {
  if (isLight) {
    return {
      'not-started': { label: '未开始', color: 'rgba(71, 85, 105, 1)' },     // slate-600
      draft:         { label: '草稿',   color: 'rgba(180, 83, 9, 1)' },      // amber-700
      submitted:     { label: '已提交', color: 'rgba(29, 78, 216, 1)' },     // blue-700
      reviewed:      { label: '已审阅', color: 'rgba(21, 128, 61, 1)' },     // green-700
      returned:      { label: '已退回', color: 'rgba(185, 28, 28, 1)' },     // red-700
      overdue:       { label: '逾期',   color: 'rgba(185, 28, 28, 1)' },
      vacation:      { label: '请假',   color: 'rgba(109, 40, 217, 1)' },    // violet-700
    };
  }
  return {
    'not-started': { label: '未开始', color: 'rgba(156, 163, 175, 0.7)' },
    draft:         { label: '草稿',   color: 'rgba(251, 191, 36, 0.9)' },
    submitted:     { label: '已提交', color: 'rgba(59, 130, 246, 0.9)' },
    reviewed:      { label: '已审阅', color: 'rgba(34, 197, 94, 0.9)' },
    returned:      { label: '已退回', color: 'rgba(239, 68, 68, 0.9)' },
    overdue:       { label: '逾期',   color: 'rgba(239, 68, 68, 0.9)' },
    vacation:      { label: '请假',   color: 'rgba(139, 92, 246, 0.9)' },
  };
}

export function HistoryTrendsPanel() {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const STATUS_LABELS = useMemo(() => buildStatusLabels(isLight), [isLight]);
  const accentColor = isLight ? 'var(--accent-claude)' : 'rgba(59, 130, 246, 0.8)';
  const accentSoft  = isLight ? 'var(--accent-claude-soft)' : 'rgba(59, 130, 246, 0.06)';
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

  useEffect(() => {
    if (teams.length > 0 && !selectedTeamId) {
      setSelectedTeamId(teams[0].id);
    }
  }, [teams, selectedTeamId]);

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
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-auto">
      {/* Controls — card-wrapped */}
      <GlassCard variant="subtle" className="px-5 py-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: accentSoft }}>
            <BarChart3 size={16} style={{ color: accentColor }} />
          </div>
          <span
            className="text-[16px] font-semibold"
            style={{
              color: 'var(--text-primary)',
              fontFamily: isLight ? 'var(--font-serif)' : undefined,
              letterSpacing: isLight ? '-0.005em' : undefined,
            }}
          >
            数据统计
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Mode toggle */}
          <div className="flex items-center rounded-lg p-0.5" style={{ background: 'var(--bg-tertiary)' }}>
            <button
              className="px-3 py-1.5 rounded-md text-[12px] transition-all duration-200"
              style={{
                background: mode === 'personal' ? 'var(--bg-primary)' : 'transparent',
                color: mode === 'personal' ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: mode === 'personal' ? 500 : 400,
                boxShadow: mode === 'personal' ? 'var(--shadow-card-sm)' : 'none',
              }}
              onClick={() => setMode('personal')}
            >
              个人趋势
            </button>
            {isLeader && (
              <button
                className="px-3 py-1.5 rounded-md text-[12px] transition-all duration-200"
                style={{
                  background: mode === 'team' ? 'var(--bg-primary)' : 'transparent',
                  color: mode === 'team' ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: mode === 'team' ? 500 : 400,
                  boxShadow: mode === 'team' ? 'var(--shadow-card-sm)' : 'none',
                }}
                onClick={() => setMode('team')}
              >
                团队趋势
              </button>
            )}
          </div>

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
        <MapSectionLoader />
      )}

      {!loading && mode === 'personal' && (
        <>
          {/* Stats grid */}
          {personalStats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <MetricCard
                icon={<TrendingUp size={15} />}
                label="提交率"
                value={`${personalStats.submissionRate}%`}
                color="rgba(34, 197, 94, 0.9)"
                bg="rgba(34, 197, 94, 0.08)"
              />
              <MetricCard
                icon={<GitCommit size={15} />}
                label="总提交数"
                value={String(personalStats.totalCommits)}
                color="rgba(59, 130, 246, 0.9)"
                bg="rgba(59, 130, 246, 0.08)"
              />
              <MetricCard
                icon={<GitCommit size={15} />}
                label="周均提交"
                value={String(personalStats.avgCommitsPerWeek)}
                color="rgba(168, 85, 247, 0.9)"
                bg="rgba(168, 85, 247, 0.08)"
              />
              <MetricCard
                icon={<CalendarCheck size={15} />}
                label="记录天数"
                value={String(personalStats.totalLogDays)}
                color="rgba(249, 115, 22, 0.9)"
                bg="rgba(249, 115, 22, 0.08)"
              />
            </div>
          )}

          {/* Chart */}
          <GlassCard className="p-5">
            <div className="text-[13px] font-medium mb-4" style={{ color: 'var(--text-primary)' }}>
              周报提交 & 代码提交趋势
            </div>
            <div className="flex flex-col gap-1">
              {personalData.map((item) => {
                const status = STATUS_LABELS[item.reportStatus] ?? STATUS_LABELS['not-started'];
                const barWidth = Math.max(4, (item.commitCount / maxCommit) * 100);
                return (
                  <div
                    key={`${item.weekYear}-${item.weekNumber}`}
                    className="flex items-center gap-3 py-1.5 px-2 rounded-lg transition-colors duration-150 hover:bg-[var(--bg-tertiary)]"
                  >
                    <div className="w-[56px] text-[11px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                      W{String(item.weekNumber).padStart(2, '0')}
                    </div>
                    <div className="w-[56px] shrink-0">
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px]"
                        style={{ background: `${status.color}15`, color: status.color }}
                      >
                        {status.label}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0 h-6 rounded-md overflow-hidden" style={{ background: isLight ? 'var(--border-faint)' : 'var(--bg-tertiary)' }}>
                      <div
                        className="h-full rounded-md transition-all duration-300"
                        style={{
                          width: `${barWidth}%`,
                          background: isLight
                            ? `linear-gradient(90deg, rgba(204,120,92,0.80), rgba(204,120,92,0.35))`
                            : `linear-gradient(90deg, rgba(59,130,246,0.65), rgba(59,130,246,0.25))`,
                        }}
                      />
                    </div>
                    <div className="w-[48px] text-right text-[11px] font-mono shrink-0" style={{ color: 'var(--text-secondary)' }}>
                      {item.commitCount}
                    </div>
                    <div className="w-[32px] text-right text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {item.dailyLogDays}d
                    </div>
                  </div>
                );
              })}
            </div>
            {personalData.length === 0 && (
              <div className="text-center py-8 text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            )}
            {/* Legend */}
            {personalData.length > 0 && (
              <div className="flex items-center gap-5 mt-4 pt-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-2.5 rounded-sm" style={{ background: isLight ? 'rgba(204, 120, 92, 0.75)' : 'rgba(59,130,246,0.5)' }} />
                  <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>代码提交数</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>Nd</span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>记录天数</span>
                </div>
              </div>
            )}
          </GlassCard>
        </>
      )}

      {!loading && mode === 'team' && (
        <>
          {/* Team stats */}
          {teamStats && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <MetricCard
                icon={<Users size={15} />}
                label="平均提交率"
                value={`${teamStats.avgSubmissionRate}%`}
                color="rgba(34, 197, 94, 0.9)"
                bg="rgba(34, 197, 94, 0.08)"
              />
              <MetricCard
                icon={<GitCommit size={15} />}
                label="总提交数"
                value={String(teamStats.totalCommits)}
                color="rgba(59, 130, 246, 0.9)"
                bg="rgba(59, 130, 246, 0.08)"
              />
              <MetricCard
                icon={<AlertTriangle size={15} />}
                label="逾期总次"
                value={String(teamStats.totalOverdue)}
                color={teamStats.totalOverdue > 0 ? 'rgba(239, 68, 68, 0.9)' : 'rgba(148, 163, 184, 0.6)'}
                bg={teamStats.totalOverdue > 0 ? 'rgba(239, 68, 68, 0.08)' : 'rgba(148, 163, 184, 0.06)'}
              />
            </div>
          )}

          {/* Team chart */}
          <GlassCard className="p-5">
            <div className="text-[13px] font-medium mb-4" style={{ color: 'var(--text-primary)' }}>
              团队提交率 & 代码趋势
            </div>
            <div className="flex flex-col gap-1">
              {teamData.map((item) => {
                const rateWidth = Math.max(4, item.submissionRate);
                const commitWidth = Math.max(4, (item.commitCount / maxCommit) * 100);
                return (
                  <div
                    key={`${item.weekYear}-${item.weekNumber}`}
                    className="flex items-center gap-3 py-1.5 px-2 rounded-lg transition-colors duration-150 hover:bg-[var(--bg-tertiary)]"
                  >
                    <div className="w-[56px] text-[11px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                      W{String(item.weekNumber).padStart(2, '0')}
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 h-[16px] rounded-sm overflow-hidden" style={{ background: isLight ? 'var(--border-faint)' : 'var(--bg-tertiary)' }}>
                          <div
                            className="h-full rounded-sm"
                            style={{
                              width: `${rateWidth}%`,
                              background: isLight
                                ? `linear-gradient(90deg, rgba(21,128,61,0.80), rgba(21,128,61,0.35))`
                                : `linear-gradient(90deg, rgba(34,197,94,0.65), rgba(34,197,94,0.25))`,
                            }}
                          />
                        </div>
                        <span className="text-[10px] font-mono w-8 text-right" style={{ color: 'var(--text-muted)' }}>
                          {item.submissionRate}%
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 h-[16px] rounded-sm overflow-hidden" style={{ background: isLight ? 'var(--border-faint)' : 'var(--bg-tertiary)' }}>
                          <div
                            className="h-full rounded-sm"
                            style={{
                              width: `${commitWidth}%`,
                              background: isLight
                                ? `linear-gradient(90deg, rgba(204,120,92,0.75), rgba(204,120,92,0.30))`
                                : `linear-gradient(90deg, rgba(59,130,246,0.6), rgba(59,130,246,0.25))`,
                            }}
                          />
                        </div>
                        <span className="text-[10px] font-mono w-8 text-right" style={{ color: 'var(--text-muted)' }}>
                          {item.commitCount}
                        </span>
                      </div>
                    </div>
                    <div className="w-[80px] text-right text-[11px] shrink-0" style={{ color: 'var(--text-secondary)' }}>
                      {item.submittedCount}/{item.memberCount}
                      {item.overdueCount > 0 && (
                        <span style={{ color: 'rgba(239, 68, 68, 0.85)', marginLeft: 4 }}>
                          +{item.overdueCount}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {teamData.length === 0 && (
              <div className="text-center py-8 text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            )}

            {/* Legend */}
            {teamData.length > 0 && (
              <div className="flex items-center gap-5 mt-4 pt-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-2.5 rounded-sm" style={{ background: isLight ? 'rgba(21,128,61,0.75)' : 'rgba(34,197,94,0.5)' }} />
                  <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>提交率</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-2.5 rounded-sm" style={{ background: isLight ? 'rgba(204,120,92,0.75)' : 'rgba(59,130,246,0.5)' }} />
                  <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>代码提交</span>
                </div>
              </div>
            )}
          </GlassCard>
        </>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, color, bg }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  bg: string;
}) {
  const isLight = useDataTheme() === 'light';
  return (
    <div
      className="rounded-xl px-5 py-4 transition-all duration-200 hover:translate-y-[-1px]"
      style={{
        // 浅色:纯白卡 + 仅左侧细色条暗示主题(避免大色块);暗色保留 glass 渐变
        background: isLight ? '#FFFFFF' : `linear-gradient(135deg, ${bg}, var(--surface-glass))`,
        backdropFilter: isLight ? undefined : 'blur(12px)',
        WebkitBackdropFilter: isLight ? undefined : 'blur(12px)',
        border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
        borderLeft: isLight ? `3px solid ${color}` : '1px solid var(--border-primary)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: bg }}
        >
          <div style={{ color }}>{icon}</div>
        </div>
      </div>
      <div className="text-[24px] font-bold leading-none" style={{ color }}>{value}</div>
      <div className="text-[12px] mt-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}
