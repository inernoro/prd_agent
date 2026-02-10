import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Crown, Users, Bot, DollarSign, Link2, TrendingUp,
  MessageSquare, Image, Bug, Zap, Activity,
  BarChart3, RefreshCw, Loader2,
} from 'lucide-react';
import { TabBar } from '@/components/design/TabBar';
import { GlassCard } from '@/components/design/GlassCard';
import { KpiCard } from '@/components/design/KpiCard';
import { EChart } from '@/components/charts/EChart';
import {
  getExecutiveOverview,
  getExecutiveTrends,
  getExecutiveTeam,
  getExecutiveAgents,
  getExecutiveModels,
  getExecutiveLeaderboard,
} from '@/services';
import type {
  ExecutiveOverview,
  ExecutiveTrendItem,
  ExecutiveTeamMember,
  ExecutiveAgentStat,
  ExecutiveModelStat,
  ExecutiveLeaderboard,
  LeaderboardDimension,
} from '@/services/contracts/executive';
import type { EChartsOption } from 'echarts';
import { resolveAvatarUrl } from '@/lib/avatar';

// ─── Chart Helpers ──────────────────────────────────────────────────

const chartTextColor = 'rgba(247,247,251,0.55)';
const chartAxisLine = 'rgba(255,255,255,0.06)';
const chartTooltipBg = 'rgba(18,18,22,0.95)';

function makeTrendOption(data: ExecutiveTrendItem[], field: 'messages' | 'tokens', color: string, unit: string): EChartsOption {
  const values = data.map(d => field === 'messages' ? d.messages : d.tokens);
  const labels = data.map(d => {
    const parts = d.date.split('-');
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  });
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis', backgroundColor: chartTooltipBg, borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#f7f7fb', fontSize: 12 },
      formatter: (p: any) => `${p[0].name}<br/>${p[0].value.toLocaleString()} ${unit}`,
    },
    grid: { left: 0, right: 0, top: 8, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category', data: labels,
      axisLine: { lineStyle: { color: chartAxisLine } },
      axisLabel: { color: chartTextColor, fontSize: 10, interval: Math.max(0, Math.floor(labels.length / 8)) },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: chartAxisLine } },
      axisLabel: { color: chartTextColor, fontSize: 10, formatter: (v: number) => v >= 10000 ? `${(v / 10000).toFixed(0)}万` : String(v) },
    },
    series: [{
      type: 'line', data: values, smooth: true, symbol: 'none',
      lineStyle: { width: 2, color },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: color.replace(/[\d.]+\)$/, '0.25)') }, { offset: 1, color: 'transparent' }],
        },
      },
    }],
  };
}

function makeAgentPieOption(agents: ExecutiveAgentStat[]): EChartsOption {
  const agentColors: Record<string, string> = {
    'prd-agent': 'rgba(59,130,246,0.95)', 'defect-agent': 'rgba(239,68,68,0.85)',
    'visual-agent': 'rgba(168,85,247,0.95)', 'literary-agent': 'rgba(34,197,94,0.95)',
    'ai-toolbox': 'rgba(214,178,106,0.95)', 'chat': 'rgba(100,116,139,0.8)',
  };
  return {
    backgroundColor: 'transparent',
    tooltip: { backgroundColor: chartTooltipBg, borderColor: 'rgba(255,255,255,0.08)', textStyle: { color: '#f7f7fb', fontSize: 12 } },
    series: [{
      type: 'pie', radius: ['50%', '75%'], center: ['50%', '50%'], padAngle: 3,
      itemStyle: { borderRadius: 6 },
      label: { show: true, color: chartTextColor, fontSize: 11, formatter: '{b}\n{d}%' },
      data: agents.map(a => ({
        name: a.name, value: a.calls,
        itemStyle: { color: agentColors[a.appKey] ?? 'rgba(148,163,184,0.7)' },
      })),
    }],
  };
}

function makeModelBarOption(models: ExecutiveModelStat[]): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: chartTooltipBg, borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#f7f7fb', fontSize: 12 },
      formatter: (p: any) => `${p.name}<br/>${p.value.toLocaleString()} 次调用`,
    },
    grid: { left: 0, right: 0, top: 8, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category', data: models.map(m => m.model),
      axisLine: { lineStyle: { color: chartAxisLine } },
      axisLabel: { color: chartTextColor, fontSize: 10, rotate: 20 }, axisTick: { show: false },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: chartAxisLine } }, axisLabel: { color: chartTextColor, fontSize: 10 } },
    series: [{
      type: 'bar', data: models.map(m => m.calls), barWidth: 28,
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(214,178,106,0.8)' }, { offset: 1, color: 'rgba(214,178,106,0.2)' }] },
      },
    }],
  };
}

// ─── Utility ────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)}万`;
  return n.toLocaleString();
}

function trendPct(current: number, previous: number): { label: string; direction: 'up' | 'down' | 'neutral' } {
  if (previous === 0) return { label: current > 0 ? '新增' : '-', direction: 'neutral' };
  const pct = ((current - previous) / previous * 100);
  if (Math.abs(pct) < 1) return { label: '持平', direction: 'neutral' };
  return {
    label: `${pct > 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(0)}%`,
    direction: pct > 0 ? 'up' : 'down',
  };
}

// ─── Sub-components ─────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[13px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>{children}</h3>;
}

function StatRow({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub?: string; icon?: any }) {
  return (
    <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div className="flex items-center gap-2">
        {Icon && <Icon size={14} style={{ color: 'var(--text-muted)' }} />}
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div className="text-right">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{typeof value === 'number' ? value.toLocaleString() : value}</span>
        {sub && <span className="text-[11px] ml-1.5" style={{ color: 'var(--text-muted)' }}>{sub}</span>}
      </div>
    </div>
  );
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 rounded-full w-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 animate-pulse">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 rounded" style={{ background: 'rgba(255,255,255,0.06)', width: `${70 + Math.random() * 30}%` }} />
      ))}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{text}</div>
    </div>
  );
}

const ROLE_COLORS: Record<string, string> = {
  PM: 'rgba(59,130,246,0.95)', DEV: 'rgba(34,197,94,0.95)', QA: 'rgba(239,68,68,0.85)', ADMIN: 'rgba(214,178,106,0.95)',
};

// ─── Tab: Overview ──────────────────────────────────────────────────

function OverviewTab({ overview, trends, agents, loading }: {
  overview: ExecutiveOverview | null;
  trends: ExecutiveTrendItem[];
  agents: ExecutiveAgentStat[];
  loading: boolean;
}) {
  if (loading && !overview) return <LoadingSkeleton rows={6} />;
  if (!overview) return <EmptyHint text="暂无数据" />;

  const msgTrend = trendPct(overview.periodMessages, overview.prevMessages);
  const tokenTrend = trendPct(overview.periodTokens, overview.prevTokens);
  const activeTrend = trendPct(overview.activeUsers, overview.prevActiveUsers);

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KpiCard title="总用户数" value={overview.totalUsers} accent="blue" />
        <KpiCard title="活跃用户" value={overview.activeUsers} accent="green" trend={activeTrend.direction} trendLabel={`${activeTrend.label} vs 上期`} />
        <KpiCard title="对话消息" value={overview.periodMessages} accent="gold" trend={msgTrend.direction} trendLabel={`${msgTrend.label} vs 上期`} />
        <KpiCard title="Token 消耗" value={formatTokens(overview.periodTokens)} accent="purple" trend={tokenTrend.direction} trendLabel={`${tokenTrend.label} vs 上期`} />
        <KpiCard title="LLM 调用" value={overview.llmCalls} accent="blue" />
        <KpiCard title="缺陷解决率" value={`${overview.defectResolutionRate}%`} accent="gold" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <GlassCard glow className="lg:col-span-2">
          <SectionTitle>消息趋势</SectionTitle>
          {trends.length > 0 ? (
            <EChart option={makeTrendOption(trends, 'messages', 'rgba(59,130,246,0.95)', '条消息')} height={260} />
          ) : <EmptyHint text="暂无趋势数据" />}
        </GlassCard>
        <GlassCard glow>
          <SectionTitle>Agent 调用分布</SectionTitle>
          {agents.length > 0 ? (
            <EChart option={makeAgentPieOption(agents)} height={260} />
          ) : <EmptyHint text="暂无 Agent 数据" />}
        </GlassCard>
      </div>

      {/* Token Trend + Overview Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard glow>
          <SectionTitle>Token 消耗趋势</SectionTitle>
          {trends.length > 0 ? (
            <EChart option={makeTrendOption(trends, 'tokens', 'rgba(168,85,247,0.95)', 'tokens')} height={260} />
          ) : <EmptyHint text="暂无趋势数据" />}
        </GlassCard>
        <GlassCard glow>
          <SectionTitle>业务统计</SectionTitle>
          <div className="space-y-1">
            <StatRow icon={Users} label="总用户数" value={overview.totalUsers} />
            <StatRow icon={Users} label="活跃用户" value={overview.activeUsers} />
            <StatRow icon={MessageSquare} label="对话消息数" value={overview.periodMessages} />
            <StatRow icon={Bug} label="缺陷总数" value={overview.totalDefects} />
            <StatRow icon={Bug} label="已解决缺陷" value={overview.resolvedDefects} />
            <StatRow icon={Image} label="图片生成" value={overview.periodImages} sub="张" />
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab: Team Leaderboard ───────────────────────────────────────────

const MEDAL = ['🥇', '🥈', '🥉'];
const MEDAL_GRADIENT = [
  'linear-gradient(90deg, rgba(214,178,106,0.35) 0%, rgba(214,178,106,0.08) 100%)',
  'linear-gradient(90deg, rgba(192,192,192,0.28) 0%, rgba(192,192,192,0.06) 100%)',
  'linear-gradient(90deg, rgba(176,141,87,0.22) 0%, rgba(176,141,87,0.05) 100%)',
];

const DIMENSION_META: Record<string, { icon: typeof Bot; color: string; barColor: string }> = {
  'prd-agent':        { icon: MessageSquare, color: 'rgba(59,130,246,0.95)',  barColor: 'rgba(59,130,246,0.7)' },
  'visual-agent':     { icon: Image,         color: 'rgba(168,85,247,0.95)', barColor: 'rgba(168,85,247,0.7)' },
  'literary-agent':   { icon: MessageSquare, color: 'rgba(34,197,94,0.95)',  barColor: 'rgba(34,197,94,0.65)' },
  'defect-agent':     { icon: Bug,           color: 'rgba(239,68,68,0.85)',  barColor: 'rgba(239,68,68,0.6)' },
  'ai-toolbox':       { icon: Zap,           color: 'rgba(214,178,106,0.95)', barColor: 'rgba(214,178,106,0.6)' },
  'chat':             { icon: MessageSquare, color: 'rgba(100,116,139,0.8)', barColor: 'rgba(100,116,139,0.55)' },
  'open-platform':    { icon: Link2,         color: 'rgba(251,146,60,0.9)',  barColor: 'rgba(251,146,60,0.6)' },
  'messages':         { icon: MessageSquare, color: 'rgba(59,130,246,0.85)', barColor: 'rgba(59,130,246,0.6)' },
  'sessions':         { icon: Activity,      color: 'rgba(34,197,94,0.85)',  barColor: 'rgba(34,197,94,0.55)' },
  'defects-created':  { icon: Bug,           color: 'rgba(239,68,68,0.7)',   barColor: 'rgba(239,68,68,0.5)' },
  'defects-resolved': { icon: Bug,           color: 'rgba(34,197,94,0.8)',   barColor: 'rgba(34,197,94,0.55)' },
  'images':           { icon: Image,         color: 'rgba(168,85,247,0.85)', barColor: 'rgba(168,85,247,0.6)' },
  'groups':           { icon: Users,         color: 'rgba(100,116,139,0.8)', barColor: 'rgba(100,116,139,0.5)' },
};

type RankedUser = { userId: string; displayName: string; role: string; avatarFileName: string | null; value: number; rank: number };

function DimensionLeaderboard({ dim, users }: { dim: LeaderboardDimension; users: ExecutiveLeaderboard['users'] }) {
  const meta = DIMENSION_META[dim.key] ?? { icon: Bot, color: 'rgba(148,163,184,0.7)', barColor: 'rgba(148,163,184,0.4)' };
  const DimIcon = meta.icon;

  // Sort users by value desc, keep only those with > 0
  const ranked: RankedUser[] = useMemo(() => {
    const userMap = new Map(users.map(u => [u.userId, u]));
    const entries = Object.entries(dim.values)
      .map(([uid, val]) => ({ uid, val, user: userMap.get(uid) }))
      .filter((e): e is { uid: string; val: number; user: NonNullable<typeof e.user> } => e.val > 0 && !!e.user)
      .sort((a, b) => b.val - a.val);

    let currentRank = 0;
    return entries.map((e, i) => {
      if (i > 0 && e.val < entries[i - 1].val) currentRank = i;
      return {
        userId: e.uid,
        displayName: e.user.displayName,
        role: e.user.role,
        avatarFileName: e.user.avatarFileName,
        value: e.val,
        rank: currentRank,
      };
    });
  }, [dim, users]);

  if (ranked.length === 0) return null;

  const maxVal = ranked[0].value;
  const total = ranked.reduce((s, r) => s + r.value, 0);

  return (
    <GlassCard glow className="!p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${meta.color}15` }}>
            <DimIcon size={16} style={{ color: meta.color }} />
          </div>
          <div>
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{dim.name}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {ranked.length} 人参与 · 总计 {total.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Bar chart leaderboard */}
      <div className="space-y-2">
        {ranked.map((item) => {
          const pct = maxVal > 0 ? (item.value / maxVal) * 100 : 0;
          const isTop3 = item.rank < 3;
          const roleColor = ROLE_COLORS[item.role] ?? 'rgba(148,163,184,0.8)';

          return (
            <div key={item.userId} className="group relative">
              <div
                className="flex items-center gap-3 py-2 px-3 rounded-lg transition-colors"
                style={{ background: isTop3 ? MEDAL_GRADIENT[item.rank] : 'rgba(255,255,255,0.02)' }}
              >
                {/* Rank */}
                <div className="w-6 text-center flex-shrink-0">
                  {isTop3 ? (
                    <span className="text-[16px]">{MEDAL[item.rank]}</span>
                  ) : (
                    <span className="text-[12px] font-bold tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {item.rank + 1}
                    </span>
                  )}
                </div>

                {/* Avatar */}
                <div className="flex-shrink-0">
                  {item.avatarFileName ? (
                    <img src={resolveAvatarUrl(item.avatarFileName)} className="w-7 h-7 rounded-full object-cover" alt="" />
                  ) : (
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold"
                      style={{ background: `${roleColor}22`, color: roleColor }}>
                      {item.displayName[0]}
                    </div>
                  )}
                </div>

                {/* Name + Role */}
                <div className="w-20 flex-shrink-0">
                  <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {item.displayName}
                  </div>
                  <div className="text-[10px]" style={{ color: roleColor }}>{item.role}</div>
                </div>

                {/* Bar + Value */}
                <div className="flex-1 flex items-center gap-3 min-w-0">
                  <div className="flex-1 h-6 rounded-md overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div
                      className="h-full rounded-md transition-all duration-500"
                      style={{
                        width: `${Math.max(pct, 2)}%`,
                        background: isTop3
                          ? `linear-gradient(90deg, ${meta.barColor}, ${meta.color})`
                          : meta.barColor,
                        opacity: isTop3 ? 1 : 0.7,
                      }}
                    />
                  </div>
                  <span
                    className="text-[14px] font-bold tabular-nums flex-shrink-0 w-14 text-right"
                    style={{ color: isTop3 ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                  >
                    {item.value.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
}

function TeamInsightsTab({ leaderboard, loading }: { leaderboard: ExecutiveLeaderboard | null; loading: boolean }) {
  if (loading && !leaderboard) return <LoadingSkeleton rows={8} />;
  if (!leaderboard || leaderboard.users.length === 0) return <EmptyHint text="暂无团队成员数据" />;

  const { users, dimensions } = leaderboard;
  const agentDims = dimensions.filter(d => d.category === 'agent');
  const activityDims = dimensions.filter(d => d.category === 'activity');

  // Filter out dimensions where nobody has any data
  const hasData = (dim: LeaderboardDimension) => Object.values(dim.values).some(v => v > 0);

  return (
    <div className="space-y-6">
      {/* Agent Usage Leaderboards */}
      {agentDims.filter(hasData).length > 0 && (
        <>
          <div className="text-[12px] font-semibold uppercase tracking-wider px-1" style={{ color: 'var(--text-muted)' }}>
            Agent 使用排行
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {agentDims.filter(hasData).map(dim => (
              <DimensionLeaderboard key={dim.key} dim={dim} users={users} />
            ))}
          </div>
        </>
      )}

      {/* Activity Leaderboards */}
      {activityDims.filter(hasData).length > 0 && (
        <>
          <div className="text-[12px] font-semibold uppercase tracking-wider px-1" style={{ color: 'var(--text-muted)' }}>
            工作活动排行
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {activityDims.filter(hasData).map(dim => (
              <DimensionLeaderboard key={dim.key} dim={dim} users={users} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Tab: Agent Usage ───────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  'prd-agent': 'rgba(59,130,246,0.95)', 'defect-agent': 'rgba(239,68,68,0.85)',
  'visual-agent': 'rgba(168,85,247,0.95)', 'literary-agent': 'rgba(34,197,94,0.95)',
  'ai-toolbox': 'rgba(214,178,106,0.95)', 'chat': 'rgba(100,116,139,0.8)', 'open-platform': 'rgba(251,146,60,0.9)',
};

function AgentUsageTab({ agents, team, loading }: { agents: ExecutiveAgentStat[]; team: ExecutiveTeamMember[]; loading: boolean }) {
  if (loading && agents.length === 0) return <LoadingSkeleton rows={4} />;
  if (agents.length === 0) return <EmptyHint text="暂无 Agent 使用数据" />;

  const totalUsers = team.filter(m => m.isActive).length || 1;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {agents.map(agent => {
          const color = AGENT_COLORS[agent.appKey] ?? 'rgba(148,163,184,0.7)';
          return (
            <GlassCard key={agent.appKey} glow>
              <div className="flex items-center gap-2 mb-3">
                <Bot size={16} style={{ color }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-[11px]">
                  <span style={{ color: 'var(--text-muted)' }}>使用人数</span>
                  <span style={{ color }}>{agent.users}/{totalUsers} 人</span>
                </div>
                <ProgressBar value={agent.users} max={totalUsers} color={color} />
                <StatRow label="调用次数" value={agent.calls} />
                <StatRow label="Token 消耗" value={formatTokens(agent.tokens)} />
                <StatRow label="平均响应" value={`${(agent.avgDurationMs / 1000).toFixed(1)}s`} />
              </div>
            </GlassCard>
          );
        })}
      </div>

      <GlassCard glow>
        <SectionTitle>Agent 调用排名</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <th className="text-left py-2 pr-4 font-medium" style={{ color: 'var(--text-muted)' }}>Agent</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>调用次数</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>用户数</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>Token</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>平均响应</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.appKey} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td className="py-2 pr-4">
                    <span className="text-sm font-medium" style={{ color: AGENT_COLORS[a.appKey] ?? 'var(--text-primary)' }}>{a.name}</span>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{a.calls.toLocaleString()}</td>
                  <td className="py-2 px-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{a.users}</td>
                  <td className="py-2 px-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatTokens(a.tokens)}</td>
                  <td className="py-2 px-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{(a.avgDurationMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Tab: Cost Center (Models) ──────────────────────────────────────

function CostCenterTab({ models, loading }: { models: ExecutiveModelStat[]; loading: boolean }) {
  if (loading && models.length === 0) return <LoadingSkeleton rows={4} />;
  if (models.length === 0) return <EmptyHint text="暂无模型使用数据" />;

  const totalCalls = models.reduce((s, m) => s + m.calls, 0);
  const totalTokens = models.reduce((s, m) => s + m.totalTokens, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard title="总调用次数" value={totalCalls} accent="gold" />
        <KpiCard title="总 Token" value={formatTokens(totalTokens)} accent="purple" />
        <KpiCard title="模型种类" value={models.length} accent="blue" />
        <KpiCard title="平均响应" value={models.length > 0 ? `${(models.reduce((s, m) => s + m.avgDurationMs, 0) / models.length / 1000).toFixed(1)}s` : '-'} accent="green" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard glow>
          <SectionTitle>按模型调用量</SectionTitle>
          <EChart option={makeModelBarOption(models.slice(0, 10))} height={280} />
        </GlassCard>
        <GlassCard glow>
          <SectionTitle>模型使用明细</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  <th className="text-left py-2 font-medium" style={{ color: 'var(--text-muted)' }}>模型</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>调用</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>输入 Token</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>输出 Token</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>平均响应</th>
                </tr>
              </thead>
              <tbody>
                {models.map(m => (
                  <tr key={m.model} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td className="py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{m.model}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{m.calls.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatTokens(m.inputTokens)}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatTokens(m.outputTokens)}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: 'var(--accent-gold)' }}>{(m.avgDurationMs / 1000).toFixed(1)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab: Integrations (placeholder) ────────────────────────────────

function IntegrationsTab() {
  const integrations = [
    { source: 'Claude Code', icon: Zap, color: 'rgba(214,178,106,0.95)', active: false },
    { source: 'Jira', icon: BarChart3, color: 'rgba(59,130,246,0.95)', active: false },
    { source: 'GitLab', icon: Activity, color: 'rgba(168,85,247,0.95)', active: false },
    { source: '飞书', icon: MessageSquare, color: 'rgba(34,197,94,0.95)', active: false },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {integrations.map(int => (
          <GlassCard key={int.source} glow>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${int.color}15` }}>
                <int.icon size={16} style={{ color: int.color }} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{int.source}</div>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>即将支持</div>
              </div>
              <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.15)' }} />
            </div>
          </GlassCard>
        ))}
      </div>

      <GlassCard>
        <SectionTitle>集成协议</SectionTitle>
        <p className="text-[12px] mb-3" style={{ color: 'var(--text-secondary)' }}>
          通过标准化 Webhook 协议接入第三方系统。所有外部活动数据统一写入 external_activities 集合，在个人画像和周报中自动展示。
        </p>
        <div className="text-[11px] font-mono p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', color: 'var(--text-muted)' }}>
          POST /api/executive/external-activities<br />
          {'{'} "source": "your-tool", "userId": "...", "activityType": "...", "summary": "..." {'}'}
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

const TABS = [
  { key: 'overview', label: '全局概览', icon: <TrendingUp size={14} /> },
  { key: 'team', label: '团队洞察', icon: <Users size={14} /> },
  { key: 'agents', label: 'Agent 使用', icon: <Bot size={14} /> },
  { key: 'cost', label: '成本中心', icon: <DollarSign size={14} /> },
  { key: 'integrations', label: '外部协作', icon: <Link2 size={14} /> },
];

const DAYS_OPTIONS = [
  { value: 7, label: '最近 7 天' },
  { value: 14, label: '最近 14 天' },
  { value: 30, label: '最近 30 天' },
];

export default function ExecutiveDashboardPage() {
  const [activeTab, setActiveTab] = useState('overview');
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [overview, setOverview] = useState<ExecutiveOverview | null>(null);
  const [trends, setTrends] = useState<ExecutiveTrendItem[]>([]);
  const [team, setTeam] = useState<ExecutiveTeamMember[]>([]);
  const [agents, setAgents] = useState<ExecutiveAgentStat[]>([]);
  const [models, setModels] = useState<ExecutiveModelStat[]>([]);
  const [leaderboard, setLeaderboard] = useState<ExecutiveLeaderboard | null>(null);

  const fetchAll = useCallback(async (d: number, isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [ovRes, trRes, tmRes, agRes, mdRes, lbRes] = await Promise.all([
        getExecutiveOverview(d),
        getExecutiveTrends(Math.max(d, 14)),
        getExecutiveTeam(d),
        getExecutiveAgents(d),
        getExecutiveModels(d),
        getExecutiveLeaderboard(d),
      ]);
      if (ovRes.success) setOverview(ovRes.data);
      if (trRes.success) setTrends(trRes.data);
      if (tmRes.success) setTeam(tmRes.data);
      if (agRes.success) setAgents(agRes.data);
      if (mdRes.success) setModels(mdRes.data);
      if (lbRes.success) setLeaderboard(lbRes.data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchAll(days); }, [days, fetchAll]);

  return (
    <div className="space-y-6">
      <TabBar
        items={TABS}
        activeKey={activeTab}
        onChange={setActiveTab}
        icon={<Crown size={16} />}
        variant="gold"
        actions={
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={e => setDays(Number(e.target.value))}
              className="text-xs px-2 py-1 rounded-md border-0 outline-none cursor-pointer"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)' }}
            >
              {DAYS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              onClick={() => fetchAll(days, true)}
              disabled={refreshing}
              className="p-1.5 rounded-md transition-colors hover:bg-white/5"
              style={{ color: 'var(--text-muted)' }}
              title="刷新数据"
            >
              {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
        }
      />

      {activeTab === 'overview' && <OverviewTab overview={overview} trends={trends} agents={agents} loading={loading} />}
      {activeTab === 'team' && <TeamInsightsTab leaderboard={leaderboard} loading={loading} />}
      {activeTab === 'agents' && <AgentUsageTab agents={agents} team={team} loading={loading} />}
      {activeTab === 'cost' && <CostCenterTab models={models} loading={loading} />}
      {activeTab === 'integrations' && <IntegrationsTab />}
    </div>
  );
}
