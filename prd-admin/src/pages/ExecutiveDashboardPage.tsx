import { useState, useEffect, useCallback } from 'react';
import {
  Crown, Users, Bot, DollarSign, Link2, TrendingUp,
  MessageSquare, Image, Bug, Zap, Activity,
  BarChart3, RefreshCw, Loader2,
  ArrowUpDown, ChevronUp, ChevronDown,
  Cpu, Sparkles,
} from 'lucide-react';
import { TabBar } from '@/components/design/TabBar';
import { GlassCard } from '@/components/design/GlassCard';
import { KpiCard } from '@/components/design/KpiCard';
import { useBreakpoint } from '@/hooks/useBreakpoint';
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
} from '@/services/contracts/executive';
import type { EChartsOption } from 'echarts';
import { resolveAvatarUrl } from '@/lib/avatar';

// ─── AI-Native Color Palette ─────────────────────────────────────────

const AI = {
  indigo:     '#818cf8',
  purple:     '#a78bfa',
  cyan:       '#22d3ee',
  emerald:    '#34d399',
  amber:      '#fbbf24',
  rose:       '#fb7185',
  blue:       '#60a5fa',
  slate:      'rgba(148,163,184,0.7)',
} as const;

const chartTextColor = 'rgba(226,232,240,0.55)';
const chartGridLine  = 'rgba(148,163,184,0.08)';
const chartTooltipBg = 'rgba(15,23,42,0.96)';
const chartTooltipBorder = 'rgba(99,102,241,0.2)';

// ─── Chart Helpers ──────────────────────────────────────────────────

function makeTrendOption(data: ExecutiveTrendItem[], field: 'messages' | 'tokens', color: string, unit: string): EChartsOption {
  const values = data.map(d => field === 'messages' ? d.messages : d.tokens);
  const labels = data.map(d => {
    const parts = d.date.split('-');
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  });
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis', backgroundColor: chartTooltipBg,
      borderColor: chartTooltipBorder, borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      formatter: (p: any) => `<span style="color:${chartTextColor}">${p[0].name}</span><br/><span style="color:${color};font-weight:600">${p[0].value.toLocaleString()}</span> ${unit}`,
    },
    grid: { left: 0, right: 0, top: 12, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category', data: labels,
      axisLine: { lineStyle: { color: chartGridLine } },
      axisLabel: { color: chartTextColor, fontSize: 10, interval: Math.max(0, Math.floor(labels.length / 8)) },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: chartGridLine, type: 'dashed' } },
      axisLabel: { color: chartTextColor, fontSize: 10, formatter: (v: number) => v >= 10000 ? `${(v / 10000).toFixed(0)}万` : String(v) },
    },
    series: [{
      type: 'line', data: values, smooth: 0.4, symbol: 'none',
      lineStyle: { width: 2.5, color, shadowColor: color.replace(/[\d.]+\)$/, '0.3)'), shadowBlur: 8 },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: color.replace(/[\d.]+\)$/, '0.2)') },
            { offset: 0.6, color: color.replace(/[\d.]+\)$/, '0.06)') },
            { offset: 1, color: 'transparent' },
          ],
        },
      },
    }],
  };
}

function makeAgentPieOption(agents: ExecutiveAgentStat[]): EChartsOption {
  const agentColors: Record<string, string> = {
    'prd-agent': AI.blue, 'defect-agent': AI.rose,
    'visual-agent': AI.purple, 'literary-agent': AI.emerald,
    'ai-toolbox': AI.amber, 'chat': AI.slate,
  };
  return {
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: chartTooltipBg, borderColor: chartTooltipBorder, borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
    },
    series: [{
      type: 'pie', radius: ['48%', '72%'], center: ['50%', '50%'], padAngle: 3,
      itemStyle: { borderRadius: 6 },
      label: {
        show: true, color: chartTextColor, fontSize: 11,
        formatter: '{b}\n{d}%',
      },
      emphasis: {
        scaleSize: 6,
        label: { fontWeight: 'bold', color: '#e2e8f0' },
      },
      data: agents.map(a => ({
        name: a.name, value: a.calls,
        itemStyle: { color: agentColors[a.appKey] ?? AI.slate },
      })),
    }],
  };
}

function makeModelBarOption(models: ExecutiveModelStat[]): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: chartTooltipBg, borderColor: chartTooltipBorder, borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      formatter: (p: any) => `${p.name}<br/><span style="color:${AI.indigo};font-weight:600">${p.value.toLocaleString()}</span> 次调用`,
    },
    grid: { left: 0, right: 0, top: 12, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category', data: models.map(m => m.model),
      axisLine: { lineStyle: { color: chartGridLine } },
      axisLabel: { color: chartTextColor, fontSize: 10, rotate: 20 }, axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: chartGridLine, type: 'dashed' } },
      axisLabel: { color: chartTextColor, fontSize: 10 },
    },
    series: [{
      type: 'bar', data: models.map(m => m.calls), barWidth: 28,
      itemStyle: {
        borderRadius: [6, 6, 0, 0],
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: AI.indigo },
            { offset: 1, color: 'rgba(99,102,241,0.15)' },
          ],
        },
      },
      emphasis: {
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: AI.purple },
              { offset: 1, color: 'rgba(139,92,246,0.25)' },
            ],
          },
        },
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

function SectionTitle({ children, accent }: { children: React.ReactNode; accent?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {accent && (
        <div className="w-1 h-4 rounded-full" style={{ background: accent }} />
      )}
      <h3 className="text-[13px] font-semibold tracking-wide" style={{ color: 'var(--text-secondary)' }}>{children}</h3>
    </div>
  );
}

function StatRow({ label, value, sub, icon: Icon, accent }: { label: string; value: string | number; sub?: string; icon?: any; accent?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 group/row" style={{ borderBottom: '1px solid rgba(148,163,184,0.06)' }}>
      <div className="flex items-center gap-2.5">
        {Icon && <Icon size={14} style={{ color: accent || 'var(--text-muted)' }} />}
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div className="text-right">
        <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{typeof value === 'number' ? value.toLocaleString() : value}</span>
        {sub && <span className="text-[11px] ml-1.5" style={{ color: 'var(--text-muted)' }}>{sub}</span>}
      </div>
    </div>
  );
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 rounded-full w-full" style={{ background: 'rgba(148,163,184,0.1)' }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{
          width: `${pct}%`,
          background: `linear-gradient(90deg, ${color}, ${color}88)`,
          boxShadow: `0 0 8px ${color}33`,
        }}
      />
    </div>
  );
}

function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 animate-pulse">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 rounded-lg" style={{ background: 'rgba(148,163,184,0.08)', width: `${70 + Math.random() * 30}%` }} />
      ))}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Sparkles size={20} style={{ color: AI.indigo, opacity: 0.5, marginBottom: 8 }} />
      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{text}</div>
    </div>
  );
}

const ROLE_COLORS: Record<string, string> = {
  PM: AI.blue, DEV: AI.emerald, QA: AI.rose, ADMIN: AI.amber,
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
    <div className="space-y-5">
      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="总用户数" value={overview.totalUsers} accent="indigo" icon={<Users size={13} />} animated />
        <KpiCard title="活跃用户" value={overview.activeUsers} accent="indigo" icon={<Activity size={13} />} trend={activeTrend.direction} trendLabel={`${activeTrend.label} vs 上期`} animated />
        <KpiCard title="对话消息" value={overview.periodMessages} accent="indigo" icon={<MessageSquare size={13} />} trend={msgTrend.direction} trendLabel={`${msgTrend.label} vs 上期`} animated />
        <KpiCard title="Token 消耗" value={formatTokens(overview.periodTokens)} accent="purple" icon={<Zap size={13} />} trend={tokenTrend.direction} trendLabel={`${tokenTrend.label} vs 上期`} animated />
        <KpiCard title="LLM 调用" value={overview.llmCalls} accent="default" icon={<Cpu size={13} />} animated />
        <KpiCard title="缺陷解决率" value={`${overview.defectResolutionRate}%`} accent="default" icon={<Bug size={13} />} animated />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <GlassCard glow animated className="lg:col-span-2" accentHue={234}>
          <SectionTitle accent={AI.indigo}>消息趋势</SectionTitle>
          {trends.length > 0 ? (
            <EChart option={makeTrendOption(trends, 'messages', AI.indigo, '条消息')} height={260} />
          ) : <EmptyHint text="暂无趋势数据" />}
        </GlassCard>
        <GlassCard glow animated accentHue={270}>
          <SectionTitle accent={AI.purple}>Agent 调用分布</SectionTitle>
          {agents.length > 0 ? (
            <EChart option={makeAgentPieOption(agents)} height={260} />
          ) : <EmptyHint text="暂无 Agent 数据" />}
        </GlassCard>
      </div>

      {/* Token Trend + Overview Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard glow animated accentHue={270}>
          <SectionTitle accent={AI.purple}>Token 消耗趋势</SectionTitle>
          {trends.length > 0 ? (
            <EChart option={makeTrendOption(trends, 'tokens', AI.purple, 'tokens')} height={260} />
          ) : <EmptyHint text="暂无趋势数据" />}
        </GlassCard>
        <GlassCard glow animated accentHue={188}>
          <SectionTitle accent={AI.cyan}>业务统计</SectionTitle>
          <div className="space-y-0.5">
            <StatRow icon={Users} label="总用户数" value={overview.totalUsers} accent={AI.blue} />
            <StatRow icon={Users} label="活跃用户" value={overview.activeUsers} accent={AI.emerald} />
            <StatRow icon={MessageSquare} label="对话消息数" value={overview.periodMessages} accent={AI.indigo} />
            <StatRow icon={Bug} label="缺陷总数" value={overview.totalDefects} accent={AI.rose} />
            <StatRow icon={Bug} label="已解决缺陷" value={overview.resolvedDefects} accent={AI.emerald} />
            <StatRow icon={Image} label="图片生成" value={overview.periodImages} sub="张" accent={AI.purple} />
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab: Team Panoramic Power Panel (全景战力面板) ───────────────────

const DIMENSION_META: Record<string, { icon: typeof Bot; color: string; barColor: string; short: string }> = {
  'prd-agent':        { icon: MessageSquare, color: AI.blue,    barColor: 'rgba(96,165,250,0.55)',   short: 'PRD' },
  'visual-agent':     { icon: Image,         color: AI.purple,  barColor: 'rgba(167,139,250,0.55)',  short: '视觉' },
  'literary-agent':   { icon: MessageSquare, color: AI.emerald, barColor: 'rgba(52,211,153,0.5)',    short: '文学' },
  'defect-agent':     { icon: Bug,           color: AI.rose,    barColor: 'rgba(251,113,133,0.5)',   short: '缺陷' },
  'ai-toolbox':       { icon: Zap,           color: AI.amber,   barColor: 'rgba(251,191,36,0.5)',    short: '工具箱' },
  'chat':             { icon: MessageSquare, color: AI.slate,   barColor: 'rgba(148,163,184,0.4)',   short: '对话' },
  'open-platform':    { icon: Link2,         color: '#fb923c',  barColor: 'rgba(251,146,60,0.5)',    short: '开放' },
  'messages':         { icon: MessageSquare, color: AI.blue,    barColor: 'rgba(96,165,250,0.5)',    short: '消息' },
  'sessions':         { icon: Activity,      color: AI.emerald, barColor: 'rgba(52,211,153,0.45)',   short: '会话' },
  'defects-created':  { icon: Bug,           color: AI.rose,    barColor: 'rgba(251,113,133,0.4)',   short: '提缺陷' },
  'defects-resolved': { icon: Bug,           color: AI.emerald, barColor: 'rgba(52,211,153,0.45)',   short: '解缺陷' },
  'images':           { icon: Image,         color: AI.purple,  barColor: 'rgba(167,139,250,0.5)',   short: '图片' },
  'groups':           { icon: Users,         color: AI.slate,   barColor: 'rgba(148,163,184,0.35)',  short: '群组' },
};


type ScoredUser = {
  userId: string; displayName: string; role: string; avatarFileName: string | null;
  totalScore: number; dimScores: Record<string, number>; normalizedScores: Record<string, number>;
};

function computeScores(data: ExecutiveLeaderboard): ScoredUser[] {
  const { users, dimensions } = data;
  const activeDims = dimensions.filter(d => Object.values(d.values).some(v => v > 0));

  const dimMax: Record<string, number> = {};
  for (const dim of activeDims) {
    dimMax[dim.key] = Math.max(1, ...Object.values(dim.values));
  }

  return users.map(u => {
    const dimScores: Record<string, number> = {};
    const normalizedScores: Record<string, number> = {};
    let totalScore = 0;

    for (const dim of activeDims) {
      const raw = dim.values[u.userId] ?? 0;
      dimScores[dim.key] = raw;
      const normalized = (raw / dimMax[dim.key]) * 100;
      normalizedScores[dim.key] = normalized;
      totalScore += normalized;
    }

    return {
      userId: u.userId, displayName: u.displayName, role: u.role,
      avatarFileName: u.avatarFileName, totalScore, dimScores, normalizedScores,
    };
  }).sort((a, b) => b.totalScore - a.totalScore);
}


const MEDAL_STYLES = [
  { color: AI.amber, bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.15)', medal: '🥇' },
  { color: 'rgba(203,213,225,0.9)', bg: 'rgba(203,213,225,0.06)', border: 'rgba(203,213,225,0.12)', medal: '🥈' },
  { color: 'rgba(180,152,108,0.85)', bg: 'rgba(180,152,108,0.06)', border: 'rgba(180,152,108,0.12)', medal: '🥉' },
];

function TeamInsightsTab({ leaderboard, loading }: { leaderboard: ExecutiveLeaderboard | null; loading: boolean }) {
  const [sortKey, setSortKey] = useState<string>('total');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  if (loading && !leaderboard) return <LoadingSkeleton rows={8} />;

  const data = leaderboard;
  if (!data || data.users.length === 0) return <EmptyHint text="暂无团队成员数据" />;

  const { dimensions } = data;
  const activeDims = dimensions.filter(d => Object.values(d.values).some(v => v > 0));
  const scored = computeScores(data);

  const tableSorted = [...scored].sort((a, b) => {
    let va: number, vb: number;
    if (sortKey === 'total') {
      va = a.totalScore; vb = b.totalScore;
    } else {
      va = a.dimScores[sortKey] ?? 0; vb = b.dimScores[sortKey] ?? 0;
    }
    return sortDir === 'desc' ? vb - va : va - vb;
  });

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortKey !== col) return <ArrowUpDown size={10} style={{ opacity: 0.3 }} />;
    return sortDir === 'desc' ? <ChevronDown size={10} /> : <ChevronUp size={10} />;
  };

  const maxScore = scored[0]?.totalScore ?? 1;

  return (
    <div className="space-y-4">
      {/* Top 3 podium */}
      <GlassCard glow animated accentHue={234} className="!py-3 !px-4">
        <div className="flex items-center gap-3">
          {scored.slice(0, Math.min(3, scored.length)).map((u, i) => {
            const mc = MEDAL_STYLES[i];
            const roleColor = ROLE_COLORS[u.role] ?? AI.slate;
            return (
              <div
                key={u.userId}
                className="flex items-center gap-2.5 flex-1 min-w-0 px-3 py-2 rounded-xl transition-colors"
                style={{ background: mc.bg, border: `1px solid ${mc.border}` }}
              >
                <span className="text-[15px] flex-shrink-0">{mc.medal}</span>
                {u.avatarFileName ? (
                  <img src={resolveAvatarUrl({ avatarFileName: u.avatarFileName })} className="w-7 h-7 rounded-full object-cover flex-shrink-0 ring-1 ring-white/10" alt="" />
                ) : (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                    style={{ background: `${roleColor}22`, color: roleColor }}>{u.displayName[0]}</div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>{u.displayName}</div>
                  <div className="text-[9px] font-medium" style={{ color: roleColor }}>{u.role}</div>
                </div>
                <span className="text-[15px] font-black tabular-nums flex-shrink-0" style={{ color: mc.color }}>{Math.round(u.totalScore)}</span>
              </div>
            );
          })}
        </div>
      </GlassCard>

      {/* Full Ranking Table */}
      <GlassCard glow animated accentHue={234}>
        <SectionTitle accent={AI.indigo}>综合排行榜</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: `1px solid rgba(99,102,241,0.12)` }}>
                <th className="text-left py-2.5 pr-2 font-medium w-8" style={{ color: 'var(--text-muted)' }}>#</th>
                <th className="text-left py-2.5 pr-4 font-medium" style={{ color: 'var(--text-muted)' }}>成员</th>
                <th
                  className="text-right py-2.5 px-2 font-medium cursor-pointer select-none whitespace-nowrap"
                  style={{ color: sortKey === 'total' ? AI.indigo : 'var(--text-muted)' }}
                  onClick={() => toggleSort('total')}
                >
                  <span className="inline-flex items-center gap-1">综合分 <SortIcon col="total" /></span>
                </th>
                {activeDims.map(dim => {
                  const meta = DIMENSION_META[dim.key];
                  return (
                    <th
                      key={dim.key}
                      className="text-right py-2.5 px-2 font-medium cursor-pointer select-none whitespace-nowrap"
                      style={{ color: sortKey === dim.key ? (meta?.color ?? 'var(--text-primary)') : 'var(--text-muted)' }}
                      onClick={() => toggleSort(dim.key)}
                    >
                      <span className="inline-flex items-center gap-1">{meta?.short ?? dim.name} <SortIcon col={dim.key} /></span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {tableSorted.map((user, idx) => {
                const roleColor = ROLE_COLORS[user.role] ?? AI.slate;
                const isTop3 = idx < 3 && sortKey === 'total' && sortDir === 'desc';
                const medals = ['🥇', '🥈', '🥉'];

                return (
                  <tr
                    key={user.userId}
                    className="surface-row"
                    style={{
                      borderBottom: '1px solid rgba(148,163,184,0.06)',
                      background: isTop3 ? 'rgba(99,102,241,0.04)' : undefined,
                    }}
                  >
                    <td className="py-2.5 pr-2">
                      {isTop3 ? (
                        <span className="text-[14px]">{medals[idx]}</span>
                      ) : (
                        <span className="text-[11px] font-bold tabular-nums" style={{ color: 'var(--text-muted)' }}>{idx + 1}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-2">
                        {user.avatarFileName ? (
                          <img src={resolveAvatarUrl({ avatarFileName: user.avatarFileName })} className="w-6 h-6 rounded-full object-cover ring-1 ring-white/5" alt="" />
                        ) : (
                          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                            style={{ background: `${roleColor}22`, color: roleColor }}>
                            {user.displayName[0]}
                          </div>
                        )}
                        <div>
                          <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{user.displayName}</div>
                          <div className="text-[9px] font-medium" style={{ color: roleColor }}>{user.role}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(148,163,184,0.08)' }}>
                          <div className="h-full rounded-full" style={{
                            width: `${(user.totalScore / maxScore) * 100}%`,
                            background: `linear-gradient(90deg, rgba(99,102,241,0.5), ${AI.indigo})`,
                            boxShadow: '0 0 6px rgba(99,102,241,0.3)',
                          }} />
                        </div>
                        <span className="tabular-nums font-bold text-[12px] w-10 text-right" style={{ color: isTop3 ? AI.indigo : 'var(--text-primary)' }}>
                          {Math.round(user.totalScore)}
                        </span>
                      </div>
                    </td>
                    {activeDims.map(dim => {
                      const raw = user.dimScores[dim.key] ?? 0;
                      const meta = DIMENSION_META[dim.key];
                      const dimMax = Math.max(1, ...Object.values(dim.values));
                      const pct = (raw / dimMax) * 100;

                      return (
                        <td key={dim.key} className="py-2.5 px-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="w-10 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(148,163,184,0.08)' }}>
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: meta?.barColor ?? 'rgba(148,163,184,0.4)' }} />
                            </div>
                            <span className="tabular-nums text-[11px] w-8 text-right" style={{ color: raw > 0 ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                              {raw > 0 ? raw.toLocaleString() : '-'}
                            </span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </GlassCard>

      {/* Per-dimension Leaderboard Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {activeDims.map(dim => {
          const meta = DIMENSION_META[dim.key] ?? { icon: Bot, color: AI.slate, barColor: 'rgba(148,163,184,0.35)', short: dim.name };
          const DimIcon = meta.icon;
          const sortedEntries = scored
            .map(u => ({ ...u, val: u.dimScores[dim.key] ?? 0 }))
            .filter(u => u.val > 0)
            .sort((a, b) => b.val - a.val);
          const total = sortedEntries.reduce((s, e) => s + e.val, 0);
          const maxVal = sortedEntries[0]?.val ?? 1;

          return (
            <GlassCard key={dim.key} glow animated className="!p-3">
              <div className="flex items-center gap-2 mb-2.5">
                <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: `${meta.color}18` }}>
                  <DimIcon size={13} style={{ color: meta.color }} />
                </div>
                <span className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{dim.name}</span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                  {sortedEntries.length} 人参与 · 总计 {total.toLocaleString()}
                </span>
              </div>
              <div className="space-y-1">
                {sortedEntries.map((u, idx) => {
                  const mc = idx < 3 ? MEDAL_STYLES[idx] : null;
                  const roleColor = ROLE_COLORS[u.role] ?? AI.slate;
                  const pct = (u.val / maxVal) * 100;
                  return (
                    <div key={u.userId} className="flex items-center gap-2 py-0.5">
                      <span className="w-5 text-center flex-shrink-0">
                        {mc ? <span className="text-[12px]">{mc.medal}</span> : <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{idx + 1}</span>}
                      </span>
                      {u.avatarFileName ? (
                        <img src={resolveAvatarUrl({ avatarFileName: u.avatarFileName })} className="w-5 h-5 rounded-full object-cover flex-shrink-0" alt="" />
                      ) : (
                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold flex-shrink-0"
                          style={{ background: `${roleColor}22`, color: roleColor }}>{u.displayName[0]}</div>
                      )}
                      <div className="w-12 flex-shrink-0">
                        <div className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{u.displayName}</div>
                        <div className="text-[8px] font-medium" style={{ color: roleColor }}>{u.role}</div>
                      </div>
                      <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'rgba(148,163,184,0.08)' }}>
                        <div className="h-full rounded-full transition-all" style={{
                          width: `${pct}%`,
                          background: meta.barColor,
                          boxShadow: `0 0 6px ${meta.barColor}`,
                        }} />
                      </div>
                      <span className="text-[11px] font-bold tabular-nums w-10 text-right flex-shrink-0" style={{ color: meta.color }}>
                        {u.val.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </GlassCard>
          );
        })}
      </div>
    </div>
  );
}

// ─── Tab: Agent Usage ───────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  'prd-agent': AI.blue, 'defect-agent': AI.rose,
  'visual-agent': AI.purple, 'literary-agent': AI.emerald,
  'ai-toolbox': AI.amber, 'chat': AI.slate, 'open-platform': '#fb923c',
};

function AgentUsageTab({ agents, team, loading }: { agents: ExecutiveAgentStat[]; team: ExecutiveTeamMember[]; loading: boolean }) {
  if (loading && agents.length === 0) return <LoadingSkeleton rows={4} />;
  if (agents.length === 0) return <EmptyHint text="暂无 Agent 使用数据" />;

  const totalUsers = team.filter(m => m.isActive).length || 1;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {agents.map(agent => {
          const color = AGENT_COLORS[agent.appKey] ?? AI.slate;
          return (
            <GlassCard key={agent.appKey} glow animated>
              {/* Subtle gradient overlay per agent */}
              <div
                className="absolute inset-0 rounded-[16px] pointer-events-none"
                style={{ background: `linear-gradient(135deg, ${color}12 0%, transparent 60%)` }}
              />
              <div className="relative">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${color}18` }}>
                    <Bot size={16} style={{ color }} />
                  </div>
                  <div>
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{agent.appKey}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-[11px]">
                    <span style={{ color: 'var(--text-muted)' }}>使用人数</span>
                    <span className="font-semibold" style={{ color }}>{agent.users}/{totalUsers} 人</span>
                  </div>
                  <ProgressBar value={agent.users} max={totalUsers} color={color} />
                  <StatRow label="调用次数" value={agent.calls} accent={color} />
                  <StatRow label="Token 消耗" value={formatTokens(agent.tokens)} accent={color} />
                  <StatRow label="平均响应" value={`${(agent.avgDurationMs / 1000).toFixed(1)}s`} accent={color} />
                </div>
              </div>
            </GlassCard>
          );
        })}
      </div>

      <GlassCard glow animated accentHue={234}>
        <SectionTitle accent={AI.indigo}>Agent 调用排名</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(99,102,241,0.12)' }}>
                <th className="text-left py-2 pr-4 font-medium" style={{ color: 'var(--text-muted)' }}>Agent</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>调用次数</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>用户数</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>Token</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>平均响应</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => {
                const color = AGENT_COLORS[a.appKey] ?? AI.slate;
                return (
                  <tr key={a.appKey} className="surface-row" style={{ borderBottom: '1px solid rgba(148,163,184,0.06)' }}>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                        <span className="text-sm font-medium" style={{ color }}>{a.name}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums font-medium" style={{ color: 'var(--text-primary)' }}>{a.calls.toLocaleString()}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{a.users}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatTokens(a.tokens)}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: AI.cyan }}>{(a.avgDurationMs / 1000).toFixed(1)}s</td>
                  </tr>
                );
              })}
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
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="总调用次数" value={totalCalls} accent="indigo" icon={<Cpu size={13} />} animated />
        <KpiCard title="总 Token" value={formatTokens(totalTokens)} accent="indigo" icon={<Zap size={13} />} animated />
        <KpiCard title="模型种类" value={models.length} accent="default" icon={<Bot size={13} />} animated />
        <KpiCard title="平均响应" value={models.length > 0 ? `${(models.reduce((s, m) => s + m.avgDurationMs, 0) / models.length / 1000).toFixed(1)}s` : '-'} accent="default" icon={<Activity size={13} />} animated />
      </div>

      <GlassCard glow animated accentHue={234}>
        <SectionTitle accent={AI.indigo}>按模型调用量</SectionTitle>
        <EChart option={makeModelBarOption(models.slice(0, 15))} height={300} />
      </GlassCard>

      <GlassCard glow animated accentHue={270}>
        <SectionTitle accent={AI.purple}>模型使用明细</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(99,102,241,0.12)' }}>
                <th className="text-left py-2 font-medium" style={{ color: 'var(--text-muted)' }}>模型</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>调用</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>输入 Token</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>输出 Token</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>平均响应</th>
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.model} className="surface-row" style={{ borderBottom: '1px solid rgba(148,163,184,0.06)' }}>
                  <td className="py-2.5 font-medium" style={{ color: 'var(--text-primary)' }}>
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: AI.indigo }} />
                      {m.model}
                    </div>
                  </td>
                  <td className="py-2.5 text-right tabular-nums font-medium" style={{ color: 'var(--text-primary)' }}>{m.calls.toLocaleString()}</td>
                  <td className="py-2.5 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatTokens(m.inputTokens)}</td>
                  <td className="py-2.5 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatTokens(m.outputTokens)}</td>
                  <td className="py-2.5 text-right tabular-nums font-medium" style={{ color: AI.cyan }}>{(m.avgDurationMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Tab: Integrations (placeholder) ────────────────────────────────

function IntegrationsTab() {
  const integrations = [
    { source: 'Claude Code', icon: Zap, color: AI.indigo, desc: '代码变更、Commit 统计自动汇入周报' },
    { source: 'Jira', icon: BarChart3, color: AI.blue, desc: '任务进度、Sprint 数据自动同步' },
    { source: 'GitLab', icon: Activity, color: AI.purple, desc: 'MR 数量、代码审查、CI/CD 状态' },
    { source: '飞书', icon: MessageSquare, color: AI.emerald, desc: '周报自动推送、审批流程对接' },
  ];

  const roadmap = [
    { phase: 'Phase 1', label: '数据采集层', items: ['Webhook 回调接口', '活动数据标准化', '来源身份验证'] },
    { phase: 'Phase 2', label: '集成适配器', items: ['Claude Code 适配器', 'GitLab 适配器', 'Jira 适配器'] },
    { phase: 'Phase 3', label: '数据融合展示', items: ['个人画像跨源合并', '周报自动汇总', '团队协作热力图'] },
  ];

  const phaseColors = [AI.indigo, AI.purple, AI.cyan];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {integrations.map(int => (
          <GlassCard key={int.source} glow animated>
            <div
              className="absolute inset-0 rounded-[16px] pointer-events-none"
              style={{ background: `linear-gradient(135deg, ${int.color}10 0%, transparent 60%)` }}
            />
            <div className="relative">
              <div className="flex items-center gap-2.5 mb-2.5">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${int.color}15` }}>
                  <int.icon size={17} style={{ color: int.color }} />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{int.source}</div>
                  <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>规划中</div>
                </div>
                <div className="relative">
                  <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(148,163,184,0.3)' }} />
                </div>
              </div>
              <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{int.desc}</div>
            </div>
          </GlassCard>
        ))}
      </div>

      <GlassCard glow animated accentHue={234}>
        <SectionTitle accent={AI.indigo}>集成路线图</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
          {roadmap.map((phase, idx) => (
            <div key={phase.phase} className="relative">
              {idx < roadmap.length - 1 && (
                <div className="hidden md:block absolute top-5 -right-2 w-4 h-0.5" style={{ background: `linear-gradient(90deg, ${phaseColors[idx]}44, transparent)` }} />
              )}
              <div className="p-4 rounded-xl" style={{
                background: `linear-gradient(135deg, ${phaseColors[idx]}08 0%, transparent 100%)`,
                border: `1px solid ${phaseColors[idx]}18`,
              }}>
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold"
                    style={{ background: `${phaseColors[idx]}18`, color: phaseColors[idx] }}>
                    {idx + 1}
                  </div>
                  <div>
                    <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{phase.label}</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{phase.phase}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {phase.items.map(item => (
                    <div key={item} className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: `${phaseColors[idx]}66` }} />
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

const TABS = [
  { key: 'overview', label: '全局概览', mobileLabel: '全局', icon: <TrendingUp size={14} /> },
  { key: 'team', label: '团队洞察', mobileLabel: '团队', icon: <Users size={14} /> },
  { key: 'agents', label: 'Agent 使用', mobileLabel: 'Agent', icon: <Bot size={14} /> },
  { key: 'cost', label: '成本中心', mobileLabel: '成本', icon: <DollarSign size={14} /> },
  { key: 'integrations', label: '外部协作', mobileLabel: '协作', icon: <Link2 size={14} /> },
];

const DAYS_OPTIONS = [
  { value: 7, label: '最近 7 天' },
  { value: 14, label: '最近 14 天' },
  { value: 30, label: '最近 30 天' },
];

export default function ExecutiveDashboardPage() {
  const { isMobile } = useBreakpoint();
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
    <div className="space-y-5">
      <TabBar
        items={isMobile ? TABS.map(t => ({ ...t, label: t.mobileLabel })) : TABS}
        activeKey={activeTab}
        onChange={setActiveTab}
        icon={<Crown size={16} />}
        variant="default"
        actions={isMobile ? undefined : (
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={e => setDays(Number(e.target.value))}
              className="text-xs px-2.5 py-1 rounded-lg border-0 outline-none cursor-pointer transition-colors"
              style={{ background: 'rgba(99,102,241,0.1)', color: AI.indigo, fontWeight: 500 }}
            >
              {DAYS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              onClick={() => fetchAll(days, true)}
              disabled={refreshing}
              className="p-1.5 rounded-lg transition-all hover:bg-white/5"
              style={{ color: refreshing ? AI.indigo : 'var(--text-muted)' }}
              title="刷新数据"
            >
              {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
        )}
      />

      {activeTab === 'overview' && <OverviewTab overview={overview} trends={trends} agents={agents} loading={loading} />}
      {activeTab === 'team' && <TeamInsightsTab leaderboard={leaderboard} loading={loading} />}
      {activeTab === 'agents' && <AgentUsageTab agents={agents} team={team} loading={loading} />}
      {activeTab === 'cost' && <CostCenterTab models={models} loading={loading} />}
      {activeTab === 'integrations' && <IntegrationsTab />}
    </div>
  );
}
