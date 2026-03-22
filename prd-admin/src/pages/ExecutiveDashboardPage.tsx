import { useState, useEffect, useCallback } from 'react';
import {
  Crown, Users, Bot, DollarSign, Link2, TrendingUp,
  MessageSquare, Image, Bug, Zap, Activity,
  BarChart3, RefreshCw, Loader2,
  ArrowUpDown, ChevronUp, ChevronDown, Info,
  Cpu, Sparkles, FileText,
} from 'lucide-react';
import { TabBar } from '@/components/design/TabBar';
import CountUp from '@/components/reactbits/CountUp';
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
import { getRoleMeta } from '@/lib/roleConfig';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { Tooltip } from '@/components/ui/Tooltip';

// ─── Enterprise Dashboard Design Tokens ──────────────────────────────
// Linear / Vercel inspired: flat, controlled, monochrome primary

const D = {
  bgCard:        'var(--bg-card)',
  border:        'var(--border-subtle)',
  primary:       '#5B8CFF',
  success:       '#22C55E',
  warning:       '#F59E0B',
  danger:        '#EF4444',
  text1:         'var(--text-primary)',
  text2:         'var(--text-secondary)',
  text3:         'var(--text-muted)',
  chartGrid:     'rgba(255,255,255,0.05)',
  chartText:     'var(--text-muted)',
  tooltipBg:     'rgba(15,23,42,0.95)',
  tooltipBorder: 'rgba(91,140,255,0.15)',
} as const;

// Icon accent colors (used sparingly for icons / progress bars only)
const AI = {
  indigo:  '#818cf8',
  purple:  '#a78bfa',
  cyan:    '#22d3ee',
  emerald: '#34d399',
  amber:   '#fbbf24',
  rose:    '#fb7185',
  blue:    '#60a5fa',
  slate:   'rgba(148,163,184,0.7)',
} as const;

// Monochrome primary palette for chart segments
const MONO = [
  '#5B8CFF', '#7BA6FF', '#4171E6', '#9ABDFF', '#3058C7', '#809FD4', 'rgba(91,140,255,0.35)',
];

function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Chart Helpers ──────────────────────────────────────────────────

function makeTrendOption(data: ExecutiveTrendItem[], field: 'messages' | 'tokens', unit: string): EChartsOption {
  const values = data.map(d => field === 'messages' ? d.messages : d.tokens);
  const labels = data.map(d => {
    const parts = d.date.split('-');
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  });
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis', backgroundColor: D.tooltipBg,
      borderColor: D.tooltipBorder, borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      formatter: (p: any) => `<span style="color:${D.chartText}">${p[0].name}</span><br/><span style="color:${D.primary};font-weight:600">${p[0].value.toLocaleString()}</span> ${unit}`,
    },
    grid: { left: 0, right: 0, top: 12, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category', data: labels,
      axisLine: { lineStyle: { color: D.chartGrid } },
      axisLabel: { color: D.chartText, fontSize: 10, interval: Math.max(0, Math.floor(labels.length / 8)) },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: D.chartGrid, type: 'dashed' } },
      axisLabel: { color: D.chartText, fontSize: 10, formatter: (v: number) => v >= 10000 ? `${(v / 10000).toFixed(0)}万` : String(v) },
    },
    series: [{
      type: 'line', data: values, smooth: 0.4, symbol: 'none',
      lineStyle: { width: 2, color: D.primary },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: hexAlpha(D.primary, 0.12) },
            { offset: 0.7, color: hexAlpha(D.primary, 0.02) },
            { offset: 1, color: 'transparent' },
          ],
        },
      },
    }],
  };
}

function makeAgentPieOption(agents: ExecutiveAgentStat[]): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: D.tooltipBg, borderColor: D.tooltipBorder, borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
    },
    series: [{
      type: 'pie', radius: ['50%', '72%'], center: ['50%', '50%'], padAngle: 2,
      itemStyle: { borderRadius: 4 },
      label: { show: true, color: D.chartText, fontSize: 11, formatter: '{b}\n{d}%' },
      emphasis: { scaleSize: 4, label: { fontWeight: 'bold', color: D.text1 } },
      data: agents.map((a, i) => ({
        name: a.name, value: a.calls,
        itemStyle: { color: MONO[i % MONO.length] },
      })),
    }],
  };
}

function makeModelBarOption(models: ExecutiveModelStat[]): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: D.tooltipBg, borderColor: D.tooltipBorder, borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      formatter: (p: any) => `${p.name}<br/><span style="color:${D.primary};font-weight:600">${p.value.toLocaleString()}</span> 次调用`,
    },
    grid: { left: 0, right: 0, top: 12, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category', data: models.map(m => m.model),
      axisLine: { lineStyle: { color: D.chartGrid } },
      axisLabel: { color: D.chartText, fontSize: 10, rotate: 20 }, axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: D.chartGrid, type: 'dashed' } },
      axisLabel: { color: D.chartText, fontSize: 10 },
    },
    series: [{
      type: 'bar', data: models.map(m => m.calls), barWidth: 28,
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: D.primary },
            { offset: 1, color: hexAlpha(D.primary, 0.08) },
          ],
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

// ─── Local Components ───────────────────────────────────────────────

/** Flat enterprise card — no glow, no blur, no gradient */
function DashCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl p-4 relative ${className ?? ''}`}
      style={{ background: D.bgCard, border: `1px solid ${D.border}` }}
    >
      {children}
    </div>
  );
}

/** Flat KPI card — same bg for all, only numbers highlighted */
function DashKpi({ title, value, icon, trend, trendLabel, info, animated }: {
  title: string; value: number | string; icon?: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral'; trendLabel?: string; info?: string; animated?: boolean;
}) {
  const display = typeof value === 'number' ? value.toLocaleString() : value;
  return (
    <DashCard className="min-h-[88px]">
      <div className="flex items-center gap-1.5 mb-3">
        {icon && <span style={{ color: D.text3 }}>{icon}</span>}
        <span className="text-[11px] font-medium tracking-wide" style={{ color: D.text3 }}>{title}</span>
        {info && <InfoTip tip={info} />}
      </div>
      <div className="text-[26px] font-semibold tracking-[-0.02em] tabular-nums leading-none" style={{ color: D.text1 }}>
        {animated && typeof value === 'number' ? <CountUp to={value} duration={2} separator="," /> : display}
      </div>
      {(trend || trendLabel) && (
        <div className="mt-2 flex items-center gap-1 text-[11px] font-medium">
          {trend === 'up' && <ChevronUp size={12} style={{ color: D.success }} />}
          {trend === 'down' && <ChevronDown size={12} style={{ color: D.danger }} />}
          <span style={{ color: trend === 'up' ? D.success : trend === 'down' ? D.danger : D.text3 }}>
            {trendLabel}
          </span>
        </div>
      )}
    </DashCard>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="w-1 h-4 rounded-full" style={{ background: D.primary, opacity: 0.5 }} />
      <h3 className="text-[13px] font-semibold tracking-wide" style={{ color: D.text2 }}>{children}</h3>
    </div>
  );
}

function StatRow({ label, value, sub, icon: Icon, accent, info }: { label: string; value: string | number; sub?: string; icon?: any; accent?: string; info?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 group/row" style={{ borderBottom: `1px solid ${D.border}` }}>
      <div className="flex items-center gap-2.5">
        {Icon && <Icon size={14} style={{ color: accent || D.text3 }} />}
        <span className="text-sm" style={{ color: D.text2 }}>{label}</span>
        {info && <InfoTip tip={info} />}
      </div>
      <div className="text-right">
        <span className="text-sm font-semibold tabular-nums" style={{ color: D.text1 }}>{typeof value === 'number' ? value.toLocaleString() : value}</span>
        {sub && <span className="text-[11px] ml-1.5" style={{ color: D.text3 }}>{sub}</span>}
      </div>
    </div>
  );
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 rounded-full w-full" style={{ background: 'rgba(255,255,255,0.04)' }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, background: color, opacity: 0.7 }}
      />
    </div>
  );
}

function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 animate-pulse">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)', width: `${70 + Math.random() * 30}%` }} />
      ))}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Sparkles size={20} style={{ color: D.primary, opacity: 0.3, marginBottom: 8 }} />
      <div className="text-sm" style={{ color: D.text3 }}>{text}</div>
    </div>
  );
}

function InfoTip({ tip }: { tip: string }) {
  return (
    <Tooltip content={tip} side="top">
      <Info size={12} style={{ color: D.text3, opacity: 0.6, flexShrink: 0 }} />
    </Tooltip>
  );
}

/** 从 ROLE_META 提取主色调，供排行榜使用 */
const ROLE_COLORS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_, key: string) => getRoleMeta(key).color,
});

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
      {/* KPI Row — same flat bg, only numbers + trends use color */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <DashKpi title="总用户数" value={overview.totalUsers} icon={<Users size={13} />} animated info="系统注册的全部用户数（含非活跃）" />
        <DashKpi title="活跃用户" value={overview.activeUsers} icon={<Activity size={13} />} trend={activeTrend.direction} trendLabel={`${activeTrend.label} vs 上期`} animated info="所选时间范围内有登录记录的用户数（基于 LastActiveAt）" />
        <DashKpi title="对话消息" value={overview.periodMessages} icon={<MessageSquare size={13} />} trend={msgTrend.direction} trendLabel={`${msgTrend.label} vs 上期`} animated info="PRD 对话 + 缺陷消息 + 视觉创作消息三个来源合计" />
        <DashKpi title="Token 消耗" value={formatTokens(overview.periodTokens)} icon={<Zap size={13} />} trend={tokenTrend.direction} trendLabel={`${tokenTrend.label} vs 上期`} animated info="PRD 对话中 Assistant 回复的 Input + Output Token 总和" />
        <DashKpi title="LLM 调用" value={overview.llmCalls} icon={<Cpu size={13} />} animated info="所有 Agent 通过 LLM Gateway 发起的大模型请求总次数" />
        <DashKpi title="缺陷解决率" value={`${overview.defectResolutionRate}%`} icon={<Bug size={13} />} animated info="已解决或已关闭的缺陷数 ÷ 缺陷总数（全时间段）" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <DashCard className="lg:col-span-2">
          <SectionTitle>消息趋势</SectionTitle>
          {trends.length > 0 ? (
            <EChart option={makeTrendOption(trends, 'messages', '条消息')} height={260} />
          ) : <EmptyHint text="暂无趋势数据" />}
        </DashCard>
        <DashCard>
          <SectionTitle>Agent 调用分布</SectionTitle>
          {agents.length > 0 ? (
            <EChart option={makeAgentPieOption(agents)} height={260} />
          ) : <EmptyHint text="暂无 Agent 数据" />}
        </DashCard>
      </div>

      {/* Token Trend + Overview Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DashCard>
          <SectionTitle>Token 消耗趋势</SectionTitle>
          {trends.length > 0 ? (
            <EChart option={makeTrendOption(trends, 'tokens', 'tokens')} height={260} />
          ) : <EmptyHint text="暂无趋势数据" />}
        </DashCard>
        <DashCard>
          <SectionTitle>业务统计</SectionTitle>
          <div className="space-y-0.5">
            <StatRow icon={Users} label="总用户数" value={overview.totalUsers} accent={D.primary} info="系统注册的全部用户数（含非活跃）" />
            <StatRow icon={Users} label="活跃用户" value={overview.activeUsers} accent={D.primary} info="所选时间范围内有登录活动的用户数" />
            <StatRow icon={MessageSquare} label="对话消息数" value={overview.periodMessages} accent={D.primary} info="PRD 对话 + 缺陷消息 + 视觉创作消息三个来源合计" />
            <StatRow icon={Bug} label="缺陷总数" value={overview.totalDefects} accent={D.danger} info="全部时间段内提交的缺陷报告总数" />
            <StatRow icon={Bug} label="已解决缺陷" value={overview.resolvedDefects} accent={D.success} info="状态为「已解决」或「已关闭」的缺陷数" />
            <StatRow icon={Image} label="图片生成" value={overview.periodImages} sub="张" accent={D.primary} info="所选时间范围内的图片生成任务数" />
          </div>
        </DashCard>
      </div>
    </div>
  );
}

// ─── Tab: Team Panoramic Power Panel (全景战力面板) ───────────────────

const DIMENSION_META: Record<string, { icon: typeof Bot; color: string; barColor: string; short: string }> = {
  'prd-agent':        { icon: MessageSquare, color: D.primary,  barColor: hexAlpha(D.primary, 0.5),   short: 'PRD' },
  'visual-agent':     { icon: Image,         color: D.primary,  barColor: hexAlpha(D.primary, 0.45),  short: '视觉' },
  'literary-agent':   { icon: MessageSquare, color: D.primary,  barColor: hexAlpha(D.primary, 0.4),   short: '文学' },
  'defect-agent':     { icon: Bug,           color: D.primary,  barColor: hexAlpha(D.primary, 0.5),   short: '缺陷' },
  'ai-toolbox':       { icon: Zap,           color: D.primary,  barColor: hexAlpha(D.primary, 0.4),   short: '工具箱' },
  'report-agent':     { icon: FileText,      color: D.primary,  barColor: hexAlpha(D.primary, 0.4),   short: '周报' },
  'video-agent':      { icon: Activity,      color: D.primary,  barColor: hexAlpha(D.primary, 0.4),   short: '视频' },
  'defects-created':  { icon: Bug,           color: D.danger,   barColor: hexAlpha(D.danger, 0.35),   short: '提缺陷' },
  'defects-resolved': { icon: Bug,           color: D.success,  barColor: hexAlpha(D.success, 0.35),  short: '解缺陷' },
  'images':           { icon: Image,         color: D.primary,  barColor: hexAlpha(D.primary, 0.4),   short: '图片' },
  'workflows':        { icon: Zap,           color: D.primary,  barColor: hexAlpha(D.primary, 0.35),  short: '工作流' },
  'arena':            { icon: Users,         color: D.primary,  barColor: hexAlpha(D.primary, 0.35),  short: '竞技场' },
};


type ScoredUser = {
  userId: string; displayName: string; role: string; avatarFileName: string | null;
  totalScore: number; dimScores: Record<string, number>; normalizedScores: Record<string, number>;
};

/**
 * 计算分数：每个维度以 "每天至少1次" 为满分（100%），超过也算100%
 * totalDays: 统计区间天数，用于计算比例
 */
function computeScores(data: ExecutiveLeaderboard): ScoredUser[] {
  const { users, dimensions, totalDays } = data;
  const capPerDim = Math.max(1, Math.min(totalDays, 30)); // 每天1次 = 满分，上限30天
  return users.map(u => {
    const dimScores: Record<string, number> = {};
    const normalizedScores: Record<string, number> = {};
    let totalScore = 0;
    for (const dim of dimensions) {
      const raw = dim.values[u.userId] ?? 0;
      dimScores[dim.key] = raw;
      // 以 totalDays 为分母，封顶100
      const normalized = Math.min((raw / capPerDim) * 100, 100);
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
  { color: AI.amber, bg: 'rgba(251,191,36,0.06)', border: 'rgba(251,191,36,0.12)', medal: '🥇' },
  { color: 'rgba(203,213,225,0.8)', bg: 'rgba(203,213,225,0.04)', border: 'rgba(203,213,225,0.10)', medal: '🥈' },
  { color: 'rgba(180,152,108,0.75)', bg: 'rgba(180,152,108,0.04)', border: 'rgba(180,152,108,0.10)', medal: '🥉' },
];

function TeamInsightsTab({ leaderboard, loading }: { leaderboard: ExecutiveLeaderboard | null; loading: boolean }) {
  const [sortKey, setSortKey] = useState<string>('total');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  if (loading && !leaderboard) return <LoadingSkeleton rows={8} />;

  const data = leaderboard;
  if (!data || data.users.length === 0) return <EmptyHint text="暂无团队成员数据" />;

  const { dimensions: allDims } = data;
  const scored = computeScores(data);
  const weightPct = allDims.length > 0 ? (100 / allDims.length).toFixed(1) : '0';

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
      <DashCard className="!py-3 !px-4">
        <div className="flex items-center gap-3">
          {scored.slice(0, Math.min(3, scored.length)).map((u, i) => {
            const mc = MEDAL_STYLES[i];
            const roleColor = ROLE_COLORS[u.role] ?? D.text3;
            return (
              <div
                key={u.userId}
                className="flex items-center gap-2.5 flex-1 min-w-0 px-3 py-2 rounded-xl transition-colors"
                style={{ background: mc.bg, border: `1px solid ${mc.border}` }}
              >
                <span className="text-[15px] flex-shrink-0">{mc.medal}</span>
                {u.avatarFileName ? (
                  <UserAvatar src={resolveAvatarUrl({ avatarFileName: u.avatarFileName })} className="w-7 h-7 rounded-full object-cover flex-shrink-0 ring-1 ring-white/5" />
                ) : (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                    style={{ background: `${roleColor}22`, color: roleColor }}>{u.displayName[0]}</div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-bold truncate" style={{ color: D.text1 }}>{u.displayName}</div>
                  <div className="text-[9px] font-medium" style={{ color: roleColor }}>{getRoleMeta(u.role).label}</div>
                </div>
                <span className="text-[15px] font-black tabular-nums flex-shrink-0" style={{ color: mc.color }}>{Math.round(u.totalScore)}</span>
              </div>
            );
          })}
        </div>
      </DashCard>

      {/* Full Ranking Table */}
      <DashCard>
        <SectionTitle>综合排行榜</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                <th className="text-left py-2.5 pr-2 font-medium w-8" style={{ color: D.text3, verticalAlign: 'middle' }}>#</th>
                <th className="text-left py-2.5 pr-4 font-medium" style={{ color: D.text3, verticalAlign: 'middle' }}>成员</th>
                <th
                  className="text-center py-2.5 px-2 font-medium cursor-pointer select-none whitespace-nowrap"
                  style={{ color: sortKey === 'total' ? D.primary : D.text3, verticalAlign: 'middle' }}
                  onClick={() => toggleSort('total')}
                >
                  <span className="inline-flex items-center justify-center gap-1 w-full">综合分 <SortIcon col="total" /></span>
                </th>
                {allDims.map(dim => {
                  const meta = DIMENSION_META[dim.key];
                  return (
                    <th
                      key={dim.key}
                      className="text-center py-2.5 px-2 font-medium cursor-pointer select-none whitespace-nowrap"
                      style={{ color: sortKey === dim.key ? D.primary : D.text3, verticalAlign: 'middle' }}
                      onClick={() => toggleSort(dim.key)}
                    >
                      <span className="inline-flex items-center justify-center gap-1 w-full">{meta?.short ?? dim.name} <SortIcon col={dim.key} /></span>
                      <div className="text-[9px] font-normal" style={{ color: D.text3, opacity: 0.7 }}>权重 {weightPct}%</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {tableSorted.map((user, idx) => {
                const roleColor = ROLE_COLORS[user.role] ?? D.text3;
                const isTop3 = idx < 3 && sortKey === 'total' && sortDir === 'desc';
                const medals = ['🥇', '🥈', '🥉'];

                return (
                  <tr
                    key={user.userId}
                    style={{
                      borderBottom: `1px solid ${D.border}`,
                      background: isTop3 ? 'rgba(91,140,255,0.03)' : undefined,
                    }}
                  >
                    <td className="py-2.5 pr-2" style={{ verticalAlign: 'middle', borderRadius: isTop3 ? '8px 0 0 8px' : undefined }}>
                      {isTop3 ? (
                        <span className="text-[14px]">{medals[idx]}</span>
                      ) : (
                        <span className="text-[11px] font-bold tabular-nums" style={{ color: D.text3 }}>{idx + 1}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4" style={{ verticalAlign: 'middle' }}>
                      <div className="flex items-center gap-2">
                        {user.avatarFileName ? (
                          <UserAvatar src={resolveAvatarUrl({ avatarFileName: user.avatarFileName })} className="w-6 h-6 rounded-full object-cover ring-1 ring-white/5" />
                        ) : (
                          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                            style={{ background: `${roleColor}22`, color: roleColor }}>
                            {user.displayName[0]}
                          </div>
                        )}
                        <div>
                          <div className="text-[12px] font-medium" style={{ color: D.text1 }}>{user.displayName}</div>
                          <div className="text-[9px] font-medium" style={{ color: roleColor }}>{getRoleMeta(user.role).label}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-2" style={{ verticalAlign: 'middle' }}>
                      <div className="flex flex-col items-center gap-0.5" style={{ minWidth: 48 }}>
                        <span className="tabular-nums font-bold text-[12px]" style={{ color: isTop3 ? D.primary : D.text1 }}>
                          {Math.round(user.totalScore)}
                        </span>
                        <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                          <div className="h-full rounded-full" style={{
                            width: `${Math.min((user.totalScore / maxScore) * 100, 100)}%`,
                            background: D.primary,
                            opacity: 0.6,
                          }} />
                        </div>
                      </div>
                    </td>
                    {allDims.map((dim, dimIdx) => {
                      const raw = user.dimScores[dim.key] ?? 0;
                      const meta = DIMENSION_META[dim.key];
                      const totalDays = Math.min(data?.totalDays ?? 1, 30);
                      const pct = Math.min((raw / Math.max(1, totalDays)) * 100, 100);
                      const isLastCol = dimIdx === allDims.length - 1;

                      return (
                        <td key={dim.key} className="py-2.5 px-2" style={{ verticalAlign: 'middle', borderRadius: isTop3 && isLastCol ? '0 8px 8px 0' : undefined }}>
                          <div className="flex flex-col items-center gap-0.5" style={{ minWidth: 40 }}>
                            <span className="tabular-nums font-bold text-[11px]" style={{ color: raw > 0 ? D.text2 : D.text3 }}>
                              {raw.toLocaleString()}
                            </span>
                            <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: meta?.barColor ?? 'rgba(255,255,255,0.12)' }} />
                            </div>
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
      </DashCard>

      {/* Per-dimension Leaderboard Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {[...allDims]
          .map(dim => ({
            dim,
            participantCount: scored.filter(u => (u.dimScores[dim.key] ?? 0) > 0).length,
          }))
          .sort((a, b) => b.participantCount - a.participantCount)
          .map(({ dim }) => {
          const meta = DIMENSION_META[dim.key] ?? { icon: Bot, color: D.text3, barColor: 'rgba(255,255,255,0.1)', short: dim.name };
          const DimIcon = meta.icon;
          const sortedEntries = scored
            .map(u => ({ ...u, val: u.dimScores[dim.key] ?? 0 }))
            .filter(u => u.val > 0)
            .sort((a, b) => b.val - a.val);
          const total = sortedEntries.reduce((s, e) => s + e.val, 0);
          const maxVal = sortedEntries.length > 0 ? sortedEntries[0].val : 1;

          return (
            <DashCard key={dim.key} className="!p-3">
              <div className="flex items-center gap-2 mb-2.5">
                <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: hexAlpha(D.primary, 0.1) }}>
                  <DimIcon size={13} style={{ color: meta.color }} />
                </div>
                <span className="text-[13px] font-bold" style={{ color: D.text1 }}>{dim.name}</span>
                <span className="text-[10px] ml-auto" style={{ color: D.text3 }}>
                  {sortedEntries.length} 人参与 · 总计 {total.toLocaleString()}
                </span>
              </div>
              {sortedEntries.length === 0 ? (
                <div className="flex items-center justify-center py-6 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)' }}>
                  <span className="text-[12px]" style={{ color: D.text3 }}>本周期暂无数据</span>
                </div>
              ) : (
                <div className="space-y-1">
                  {sortedEntries.map((u, idx) => {
                    const mc = idx < 3 ? MEDAL_STYLES[idx] : null;
                    const roleColor = ROLE_COLORS[u.role] ?? D.text3;
                    const pct = (u.val / Math.max(1, maxVal)) * 100;
                    return (
                      <div key={u.userId} className="flex items-center gap-2 py-0.5">
                        <span className="w-5 text-center flex-shrink-0">
                          {mc ? <span className="text-[12px]">{mc.medal}</span> : <span className="text-[10px] tabular-nums" style={{ color: D.text3 }}>{idx + 1}</span>}
                        </span>
                        {u.avatarFileName ? (
                          <UserAvatar src={resolveAvatarUrl({ avatarFileName: u.avatarFileName })} className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold flex-shrink-0"
                            style={{ background: `${roleColor}22`, color: roleColor }}>{u.displayName[0]}</div>
                        )}
                        <div className="w-12 flex-shrink-0">
                          <div className="text-[11px] font-medium truncate" style={{ color: D.text1 }}>{u.displayName}</div>
                          <div className="text-[8px] font-medium" style={{ color: roleColor }}>{getRoleMeta(u.role).label}</div>
                        </div>
                        <div className="flex-1 flex flex-col items-center gap-0.5">
                          <span className="text-[11px] font-bold tabular-nums" style={{ color: D.text1 }}>
                            {u.val.toLocaleString()}
                          </span>
                          <div className="w-full h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                            <div className="h-full rounded-full transition-all" style={{
                              width: `${pct}%`,
                              background: meta.barColor,
                            }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </DashCard>
          );
        })}
      </div>
    </div>
  );
}

// ─── Tab: Agent Usage ───────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  'prd-agent': D.primary, 'defect-agent': D.danger,
  'visual-agent': D.primary, 'literary-agent': D.primary,
  'ai-toolbox': D.warning, 'chat': D.text3, 'open-platform': D.primary,
};

function AgentUsageTab({ agents, team, loading }: { agents: ExecutiveAgentStat[]; team: ExecutiveTeamMember[]; loading: boolean }) {
  if (loading && agents.length === 0) return <LoadingSkeleton rows={4} />;
  if (agents.length === 0) return <EmptyHint text="暂无 Agent 使用数据" />;

  const totalUsers = team.filter(m => m.isActive).length || 1;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {agents.map(agent => {
          const color = AGENT_COLORS[agent.appKey] ?? D.text3;
          return (
            <DashCard key={agent.appKey}>
              <div className="flex items-center gap-2.5 mb-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: hexAlpha(D.primary, 0.08) }}>
                  <Bot size={16} style={{ color: D.primary }} />
                </div>
                <div>
                  <span className="text-sm font-semibold" style={{ color: D.text1 }}>{agent.name}</span>
                  <div className="text-[10px]" style={{ color: D.text3 }}>{agent.appKey}</div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-[11px]">
                  <span className="flex items-center gap-1" style={{ color: D.text3 }}>
                    使用人数
                    <InfoTip tip="在所选时间范围内使用过该 Agent 的独立用户数（综合 API 调用与 LLM 调用）" />
                  </span>
                  <span className="font-semibold" style={{ color: D.text1 }}>{agent.users}/{totalUsers} 人</span>
                </div>
                <ProgressBar value={agent.users} max={totalUsers} color={color} />
                <StatRow label="业务操作" value={agent.apiCalls ?? 0} accent={D.primary} info="该 Agent 在所选时间范围内的写操作次数（POST/PUT/DELETE），反映实际业务使用量" />
                <StatRow label="LLM 调用" value={agent.llmCalls ?? 0} accent={D.primary} info="该 Agent 触发的大模型请求次数（基于 llm_request_logs）" />
                <StatRow label="Token 消耗" value={formatTokens(agent.tokens)} accent={D.primary} info="该 Agent 所有 LLM 请求的输入 + 输出 Token 总和" />
                <StatRow label="平均响应" value={`${(agent.avgDurationMs / 1000).toFixed(1)}s`} accent={D.primary} info="该 Agent 所有已完成 LLM 请求的平均耗时（不含未完成请求）" />
              </div>
            </DashCard>
          );
        })}
      </div>

      <DashCard>
        <SectionTitle>Agent 调用排名</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                <th className="text-left py-2 pr-4 font-medium" style={{ color: D.text3 }}>Agent</th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">总调用 <InfoTip tip="业务操作 + LLM 调用合计" /></span>
                </th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">业务操作 <InfoTip tip="POST/PUT/DELETE 请求数" /></span>
                </th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">LLM <InfoTip tip="大模型调用次数" /></span>
                </th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">用户数 <InfoTip tip="去重后的独立用户数" /></span>
                </th>
                <th className="text-right py-2 px-3 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">Token <InfoTip tip="输入 + 输出 Token 总和" /></span>
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.appKey} style={{ borderBottom: `1px solid ${D.border}` }}>
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: D.primary }} />
                      <span className="text-sm font-medium" style={{ color: D.text1 }}>{a.name}</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums font-medium" style={{ color: D.text1 }}>{a.calls.toLocaleString()}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: D.text2 }}>{(a.apiCalls ?? 0).toLocaleString()}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: D.text2 }}>{(a.llmCalls ?? 0).toLocaleString()}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: D.text1 }}>{a.users}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: D.text1 }}>{formatTokens(a.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DashCard>
    </div>
  );
}

// ─── Tab: Cost Center (Models) ──────────────────────────────────────

function formatCost(v: number): string {
  if (v === 0) return '-';
  if (v >= 10000) return `¥${(v / 10000).toFixed(1)}万`;
  if (v >= 1) return `¥${v.toFixed(2)}`;
  if (v >= 0.01) return `¥${v.toFixed(2)}`;
  return `¥${v.toFixed(4)}`;
}

function CostCenterTab({ models, loading }: { models: ExecutiveModelStat[]; loading: boolean }) {
  if (loading && models.length === 0) return <LoadingSkeleton rows={4} />;
  if (models.length === 0) return <EmptyHint text="暂无模型使用数据" />;

  const totalCalls = models.reduce((s, m) => s + m.calls, 0);
  const totalTokens = models.reduce((s, m) => s + m.totalTokens, 0);
  const totalImages = models.reduce((s, m) => s + m.imageCount, 0);
  const totalTokenCost = models.reduce((s, m) => s + m.tokenCost, 0);
  const totalCallCost = models.reduce((s, m) => s + m.callCost, 0);
  const totalCost = models.reduce((s, m) => s + m.totalCost, 0);
  const pricedModels = models.filter(m => m.hasPricing).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <DashKpi title="预估总成本" value={formatCost(totalCost)} icon={<DollarSign size={13} />} animated info={`Token 成本 ${formatCost(totalTokenCost)} + 调用成本 ${formatCost(totalCallCost)}（${pricedModels}/${models.length} 个模型已配置定价）`} />
        <DashKpi title="总调用次数" value={totalCalls} icon={<Cpu size={13} />} animated info="所有模型的 LLM Gateway 请求总次数" />
        <DashKpi title="总 Token" value={formatTokens(totalTokens)} icon={<Zap size={13} />} animated info="所有模型的 Input + Output Token 合计" />
        <DashKpi title="生成图片" value={totalImages > 0 ? totalImages : models.length} icon={totalImages > 0 ? <Image size={13} /> : <Bot size={13} />} animated info={totalImages > 0 ? '所有模型成功生成的图片总数' : '在所选时间范围内被调用过的不同模型数'} />
      </div>

      {/* 成本构成 */}
      {totalCost > 0 && (
        <DashCard>
          <SectionTitle>成本构成</SectionTitle>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-sm" style={{ background: D.primary }} />
              <div>
                <div className="text-xs" style={{ color: D.text3 }}>Token 成本</div>
                <div className="text-sm font-semibold tabular-nums" style={{ color: D.text1 }}>{formatCost(totalTokenCost)}</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-sm" style={{ background: hexAlpha(D.primary, 0.5) }} />
              <div>
                <div className="text-xs" style={{ color: D.text3 }}>调用成本（图片等）</div>
                <div className="text-sm font-semibold tabular-nums" style={{ color: D.text1 }}>{formatCost(totalCallCost)}</div>
              </div>
            </div>
          </div>
        </DashCard>
      )}

      <DashCard>
        <SectionTitle>按模型调用量</SectionTitle>
        <EChart option={makeModelBarOption(models.slice(0, 15))} height={300} />
      </DashCard>

      <DashCard>
        <SectionTitle>模型使用明细</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                <th className="text-left py-2 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1">模型 <InfoTip tip="LLM Gateway 中实际使用的模型名称" /></span>
                </th>
                <th className="text-right py-2 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">调用 <InfoTip tip="该模型在所选时间范围内被调用的总次数" /></span>
                </th>
                <th className="text-right py-2 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">输入 Token <InfoTip tip="发送给该模型的 Prompt Token 总量" /></span>
                </th>
                <th className="text-right py-2 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">输出 Token <InfoTip tip="该模型生成的 Completion Token 总量" /></span>
                </th>
                <th className="text-right py-2 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">图片 <InfoTip tip="该模型成功生成的图片数量" /></span>
                </th>
                <th className="text-right py-2 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">预估成本 <InfoTip tip="Token 成本 + 按次调用成本（需在模型池中配置定价）" /></span>
                </th>
                <th className="text-right py-2 font-medium" style={{ color: D.text3 }}>
                  <span className="inline-flex items-center gap-1 justify-end">平均响应 <InfoTip tip="该模型所有已完成请求的平均耗时（排除未完成请求）" /></span>
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.model} style={{ borderBottom: `1px solid ${D.border}` }}>
                  <td className="py-2.5 font-medium" style={{ color: D.text1 }}>
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: D.primary }} />
                      {m.model}
                    </div>
                  </td>
                  <td className="py-2.5 text-right tabular-nums font-medium" style={{ color: D.text1 }}>{m.calls.toLocaleString()}</td>
                  <td className="py-2.5 text-right tabular-nums" style={{ color: D.text2 }}>{formatTokens(m.inputTokens)}</td>
                  <td className="py-2.5 text-right tabular-nums" style={{ color: D.text2 }}>{formatTokens(m.outputTokens)}</td>
                  <td className="py-2.5 text-right tabular-nums" style={{ color: D.text2 }}>{m.imageCount > 0 ? m.imageCount.toLocaleString() : '-'}</td>
                  <td className="py-2.5 text-right tabular-nums font-medium" style={{ color: m.hasPricing ? D.primary : D.text3 }}>
                    {m.hasPricing ? formatCost(m.totalCost) : <span className="text-[10px] opacity-60">未配置</span>}
                  </td>
                  <td className="py-2.5 text-right tabular-nums font-medium" style={{ color: D.primary }}>{(m.avgDurationMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DashCard>
    </div>
  );
}

// ─── Tab: Integrations (placeholder) ────────────────────────────────

function IntegrationsTab() {
  const integrations = [
    { source: 'Claude Code', icon: Zap, desc: '代码变更、Commit 统计自动汇入周报' },
    { source: 'Jira', icon: BarChart3, desc: '任务进度、Sprint 数据自动同步' },
    { source: 'GitLab', icon: Activity, desc: 'MR 数量、代码审查、CI/CD 状态' },
    { source: '飞书', icon: MessageSquare, desc: '周报自动推送、审批流程对接' },
  ];

  const roadmap = [
    { phase: 'Phase 1', label: '数据采集层', items: ['Webhook 回调接口', '活动数据标准化', '来源身份验证'] },
    { phase: 'Phase 2', label: '集成适配器', items: ['Claude Code 适配器', 'GitLab 适配器', 'Jira 适配器'] },
    { phase: 'Phase 3', label: '数据融合展示', items: ['个人画像跨源合并', '周报自动汇总', '团队协作热力图'] },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {integrations.map(int => (
          <DashCard key={int.source}>
            <div className="flex items-center gap-2.5 mb-2.5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: hexAlpha(D.primary, 0.08) }}>
                <int.icon size={17} style={{ color: D.primary }} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold" style={{ color: D.text1 }}>{int.source}</div>
                <div className="text-[10px] font-medium" style={{ color: D.text3 }}>规划中</div>
              </div>
              <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.12)' }} />
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: D.text2 }}>{int.desc}</div>
          </DashCard>
        ))}
      </div>

      <DashCard>
        <SectionTitle>集成路线图</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
          {roadmap.map((phase, idx) => (
            <div key={phase.phase} className="relative">
              {idx < roadmap.length - 1 && (
                <div className="hidden md:block absolute top-5 -right-2 w-4 h-0.5" style={{ background: `${hexAlpha(D.primary, 0.2)}` }} />
              )}
              <div className="p-4 rounded-xl" style={{
                background: hexAlpha(D.primary, 0.04),
                border: `1px solid ${hexAlpha(D.primary, 0.08)}`,
              }}>
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold"
                    style={{ background: hexAlpha(D.primary, 0.1), color: D.primary }}>
                    {idx + 1}
                  </div>
                  <div>
                    <div className="text-[12px] font-semibold" style={{ color: D.text1 }}>{phase.label}</div>
                    <div className="text-[10px]" style={{ color: D.text3 }}>{phase.phase}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {phase.items.map(item => (
                    <div key={item} className="flex items-center gap-2 text-[11px]" style={{ color: D.text2 }}>
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: hexAlpha(D.primary, 0.4) }} />
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </DashCard>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

const TABS = [
  { key: 'team', label: '团队洞察', mobileLabel: '团队', icon: <Users size={14} /> },
  { key: 'overview', label: '全局概览', mobileLabel: '全局', icon: <TrendingUp size={14} /> },
  { key: 'agents', label: 'Agent 使用', mobileLabel: 'Agent', icon: <Bot size={14} /> },
  { key: 'cost', label: '成本中心', mobileLabel: '成本', icon: <DollarSign size={14} /> },
  { key: 'integrations', label: '外部协作', mobileLabel: '协作', icon: <Link2 size={14} /> },
];

const DAYS_OPTIONS = [
  { value: 0, label: '全部时间' },
  { value: 7, label: '最近 7 天' },
  { value: 14, label: '最近 14 天' },
  { value: 30, label: '最近 30 天' },
];

export default function ExecutiveDashboardPage() {
  const { isMobile } = useBreakpoint();
  const [activeTab, setActiveTab] = useState('team');
  const [days, setDays] = useState(0);
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
    <div className="space-y-5 relative">
      {/* Subtle ambient light — top-left radial, 6% max opacity */}
      <div
        className="fixed top-0 left-0 w-[700px] h-[700px] pointer-events-none"
        style={{ background: `radial-gradient(circle at 20% 20%, ${hexAlpha(D.primary, 0.06)}, transparent 70%)` }}
      />

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
              style={{ background: hexAlpha(D.primary, 0.1), color: D.primary, fontWeight: 500 }}
            >
              {DAYS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              onClick={() => fetchAll(days, true)}
              disabled={refreshing}
              className="p-1.5 rounded-lg transition-all hover:bg-white/5"
              style={{ color: refreshing ? D.primary : D.text3 }}
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
