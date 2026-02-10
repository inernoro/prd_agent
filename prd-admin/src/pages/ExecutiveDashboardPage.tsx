import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Crown, Users, Bot, DollarSign, Link2, TrendingUp,
  MessageSquare, Image, Bug, Zap, Activity,
  BarChart3, RefreshCw, Loader2, ToggleLeft, ToggleRight,
  ArrowUpDown, ChevronUp, ChevronDown,
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

// ─── Tab: Team Panoramic Power Panel (全景战力面板) ───────────────────

const DIMENSION_META: Record<string, { icon: typeof Bot; color: string; barColor: string; short: string }> = {
  'prd-agent':        { icon: MessageSquare, color: 'rgba(59,130,246,0.95)',  barColor: 'rgba(59,130,246,0.7)',  short: 'PRD' },
  'visual-agent':     { icon: Image,         color: 'rgba(168,85,247,0.95)', barColor: 'rgba(168,85,247,0.7)',  short: '视觉' },
  'literary-agent':   { icon: MessageSquare, color: 'rgba(34,197,94,0.95)',  barColor: 'rgba(34,197,94,0.65)',  short: '文学' },
  'defect-agent':     { icon: Bug,           color: 'rgba(239,68,68,0.85)',  barColor: 'rgba(239,68,68,0.6)',   short: '缺陷' },
  'ai-toolbox':       { icon: Zap,           color: 'rgba(214,178,106,0.95)', barColor: 'rgba(214,178,106,0.6)', short: '工具箱' },
  'chat':             { icon: MessageSquare, color: 'rgba(100,116,139,0.8)', barColor: 'rgba(100,116,139,0.55)', short: '对话' },
  'open-platform':    { icon: Link2,         color: 'rgba(251,146,60,0.9)',  barColor: 'rgba(251,146,60,0.6)',  short: '开放' },
  'messages':         { icon: MessageSquare, color: 'rgba(59,130,246,0.85)', barColor: 'rgba(59,130,246,0.6)',  short: '消息' },
  'sessions':         { icon: Activity,      color: 'rgba(34,197,94,0.85)',  barColor: 'rgba(34,197,94,0.55)',  short: '会话' },
  'defects-created':  { icon: Bug,           color: 'rgba(239,68,68,0.7)',   barColor: 'rgba(239,68,68,0.5)',   short: '提缺陷' },
  'defects-resolved': { icon: Bug,           color: 'rgba(34,197,94,0.8)',   barColor: 'rgba(34,197,94,0.55)',  short: '解缺陷' },
  'images':           { icon: Image,         color: 'rgba(168,85,247,0.85)', barColor: 'rgba(168,85,247,0.6)',  short: '图片' },
  'groups':           { icon: Users,         color: 'rgba(100,116,139,0.8)', barColor: 'rgba(100,116,139,0.5)', short: '群组' },
};

const USER_COLORS = [
  'rgba(59,130,246,0.85)', 'rgba(239,68,68,0.8)', 'rgba(34,197,94,0.85)',
  'rgba(168,85,247,0.85)', 'rgba(214,178,106,0.9)', 'rgba(251,146,60,0.85)',
  'rgba(236,72,153,0.8)', 'rgba(20,184,166,0.85)', 'rgba(99,102,241,0.85)',
  'rgba(245,158,11,0.85)',
];

type ScoredUser = {
  userId: string; displayName: string; role: string; avatarFileName: string | null;
  totalScore: number; dimScores: Record<string, number>; normalizedScores: Record<string, number>;
};

/** Normalize each dimension to 0-100 and compute weighted composite score */
function computeScores(data: ExecutiveLeaderboard): ScoredUser[] {
  const { users, dimensions } = data;
  const activeDims = dimensions.filter(d => Object.values(d.values).some(v => v > 0));

  // Find max per dimension for normalization
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

/** Make radar chart option — filter by category or explicit key list */
function makeRadarOption(
  scoredUsers: ScoredUser[],
  dims: LeaderboardDimension[],
  filter?: 'agent' | 'activity' | string[],
): EChartsOption {
  const activeDims = dims
    .filter(d => Object.values(d.values).some(v => v > 0))
    .filter(d => !filter ? true : Array.isArray(filter) ? filter.includes(d.key) : d.category === filter);

  return {
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: chartTooltipBg, borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#f7f7fb', fontSize: 11 },
    },
    legend: { show: false },
    radar: {
      indicator: activeDims.map(d => ({
        name: DIMENSION_META[d.key]?.short ?? d.name,
        max: 100,
      })),
      shape: 'polygon' as any,
      radius: '78%',
      center: ['50%', '55%'],
      axisName: { color: chartTextColor, fontSize: 9 },
      splitArea: { areaStyle: { color: ['rgba(255,255,255,0.02)', 'rgba(255,255,255,0.04)'] } },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
    },
    series: [{
      type: 'radar',
      data: scoredUsers.slice(0, 8).map((u, i) => {
        const isHighlighted = i < 3;
        return {
          name: u.displayName,
          value: activeDims.map(d => Math.round(u.normalizedScores[d.key] ?? 0)),
          symbol: isHighlighted ? 'circle' : 'none',
          symbolSize: 4,
          lineStyle: { width: isHighlighted ? 2.5 : 1, opacity: isHighlighted ? 0.9 : 0.3 },
          areaStyle: { opacity: isHighlighted ? 0.15 : 0.02 },
          itemStyle: { color: USER_COLORS[i % USER_COLORS.length] },
        };
      }),
    }],
  };
}

const MEDAL_COLORS = [
  { color: 'rgba(214,178,106,0.95)', bg: 'rgba(214,178,106,0.08)', medal: '🥇' },
  { color: 'rgba(192,192,192,0.9)', bg: 'rgba(192,192,192,0.06)', medal: '🥈' },
  { color: 'rgba(176,141,87,0.85)', bg: 'rgba(176,141,87,0.05)', medal: '🥉' },
];

function generateMockLeaderboard(): ExecutiveLeaderboard {
  const mockUsers: ExecutiveLeaderboard['users'] = [
    { userId: 'mock-1', username: 'zhang.wei', displayName: '张伟', role: 'PM', avatarFileName: null, lastActiveAt: '2026-02-10T09:30:00Z', isActive: true },
    { userId: 'mock-2', username: 'li.na', displayName: '李娜', role: 'DEV', avatarFileName: null, lastActiveAt: '2026-02-10T10:15:00Z', isActive: true },
    { userId: 'mock-3', username: 'wang.fang', displayName: '王芳', role: 'DEV', avatarFileName: null, lastActiveAt: '2026-02-09T18:00:00Z', isActive: true },
    { userId: 'mock-4', username: 'liu.yang', displayName: '刘洋', role: 'QA', avatarFileName: null, lastActiveAt: '2026-02-10T08:45:00Z', isActive: true },
    { userId: 'mock-5', username: 'chen.jie', displayName: '陈杰', role: 'DEV', avatarFileName: null, lastActiveAt: '2026-02-08T16:30:00Z', isActive: true },
    { userId: 'mock-6', username: 'zhao.min', displayName: '赵敏', role: 'PM', avatarFileName: null, lastActiveAt: '2026-02-10T11:00:00Z', isActive: true },
    { userId: 'mock-7', username: 'huang.lei', displayName: '黄磊', role: 'DEV', avatarFileName: null, lastActiveAt: '2026-02-07T14:20:00Z', isActive: false },
    { userId: 'mock-8', username: 'sun.li', displayName: '孙丽', role: 'QA', avatarFileName: null, lastActiveAt: '2026-02-10T09:00:00Z', isActive: true },
  ];

  const uids = mockUsers.map(u => u.userId);

  const mkValues = (ranges: number[][]) => {
    const values: Record<string, number> = {};
    uids.forEach((uid, i) => {
      const [min, max] = ranges[i] ?? [0, 0];
      values[uid] = min + Math.floor(Math.random() * (max - min + 1));
    });
    return values;
  };

  const mockDimensions: LeaderboardDimension[] = [
    { key: 'prd-agent',      name: 'PRD Agent',        category: 'agent', values: mkValues([[120,180],[85,130],[200,280],[40,70],[150,220],[95,140],[10,30],[60,90]]) },
    { key: 'visual-agent',   name: '视觉创作 Agent',   category: 'agent', values: mkValues([[30,60],[180,260],[5,15],[10,25],[90,150],[45,80],[120,200],[20,40]]) },
    { key: 'literary-agent', name: '文学创作 Agent',    category: 'agent', values: mkValues([[80,140],[20,45],[60,110],[5,15],[30,60],[160,240],[15,35],[40,75]]) },
    { key: 'defect-agent',   name: '缺陷管理 Agent',   category: 'agent', values: mkValues([[50,90],[30,55],[25,45],[180,260],[40,70],[20,40],[15,30],[120,180]]) },
    { key: 'messages',         name: '消息数',         category: 'activity', values: mkValues([[300,500],[250,400],[420,600],[150,250],[350,520],[280,420],[60,120],[200,340]]) },
    { key: 'sessions',         name: '会话数',         category: 'activity', values: mkValues([[25,45],[18,35],[40,60],[12,22],[30,50],[22,38],[5,12],[15,28]]) },
    { key: 'defects-created',  name: '提交缺陷',       category: 'activity', values: mkValues([[8,15],[3,8],[5,12],[20,35],[6,10],[4,9],[2,5],[15,25]]) },
    { key: 'defects-resolved', name: '解决缺陷',       category: 'activity', values: mkValues([[6,12],[5,10],[8,16],[18,30],[4,8],[3,7],[1,4],[12,22]]) },
    { key: 'images',           name: '图片生成',       category: 'activity', values: mkValues([[15,30],[60,100],[3,8],[5,12],[40,70],[20,40],[50,85],[10,20]]) },
  ];

  return { users: mockUsers, dimensions: mockDimensions };
}

function TeamInsightsTab({ leaderboard, loading }: { leaderboard: ExecutiveLeaderboard | null; loading: boolean }) {
  const [useMock, setUseMock] = useState(false);
  const [mockData] = useState<ExecutiveLeaderboard>(() => generateMockLeaderboard());
  const [sortKey, setSortKey] = useState<string>('total');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  if (loading && !leaderboard) return <LoadingSkeleton rows={8} />;

  const data = useMock ? mockData : leaderboard;
  if (!data || data.users.length === 0) return <EmptyHint text="暂无团队成员数据" />;

  const { dimensions } = data;
  const activeDims = dimensions.filter(d => Object.values(d.values).some(v => v > 0));
  const scored = computeScores(data);

  // Sorted for table
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
      {/* Mock toggle */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => setUseMock(!useMock)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all"
          style={{
            background: useMock ? 'rgba(214,178,106,0.15)' : 'rgba(255,255,255,0.04)',
            color: useMock ? 'rgba(214,178,106,0.95)' : 'var(--text-muted)',
            border: `1px solid ${useMock ? 'rgba(214,178,106,0.3)' : 'rgba(255,255,255,0.08)'}`,
          }}
        >
          {useMock ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
          {useMock ? '演示数据' : '真实数据'}
        </button>
      </div>

      {/* ── Top 3 inline badges ── */}
      <GlassCard glow className="!py-3 !px-4">
        <div className="flex items-center gap-4">
          {scored.slice(0, Math.min(3, scored.length)).map((u, i) => {
            const mc = MEDAL_COLORS[i];
            const roleColor = ROLE_COLORS[u.role] ?? 'rgba(148,163,184,0.8)';
            return (
              <div key={u.userId} className="flex items-center gap-2 flex-1 min-w-0 px-2.5 py-1.5 rounded-lg" style={{ background: mc.bg }}>
                <span className="text-[15px] flex-shrink-0">{mc.medal}</span>
                {u.avatarFileName ? (
                  <img src={resolveAvatarUrl(u.avatarFileName)} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                ) : (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                    style={{ background: `${roleColor}22`, color: roleColor }}>{u.displayName[0]}</div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>{u.displayName}</div>
                  <div className="text-[9px]" style={{ color: roleColor }}>{u.role}</div>
                </div>
                <span className="text-[15px] font-black tabular-nums flex-shrink-0" style={{ color: mc.color }}>{Math.round(u.totalScore)}</span>
              </div>
            );
          })}
        </div>
      </GlassCard>

      {/* ── Left: 2 Radars stacked | Right: Dimension Overview ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="grid grid-cols-2 gap-2">
          <GlassCard glow className="!p-2">
            <div className="text-[11px] font-bold uppercase tracking-wider px-1" style={{ color: 'var(--text-secondary)' }}>Agent 使用</div>
            <EChart option={makeRadarOption(scored, dimensions, 'agent')} height={240} />
          </GlassCard>
          <GlassCard glow className="!p-2">
            <div className="text-[11px] font-bold uppercase tracking-wider px-1" style={{ color: 'var(--text-secondary)' }}>活动产出</div>
            <EChart option={makeRadarOption(scored, dimensions, 'activity')} height={240} />
          </GlassCard>
        </div>

        <GlassCard glow className="!p-3">
          <SectionTitle>维度分布</SectionTitle>
          <div className="space-y-1.5">
            {activeDims.map(dim => {
              const meta = DIMENSION_META[dim.key] ?? { icon: Bot, color: 'rgba(148,163,184,0.7)', barColor: 'rgba(148,163,184,0.4)', short: dim.name };
              const DimIcon = meta.icon;
              const total = Object.values(dim.values).reduce((s, v) => s + v, 0);
              const maxVal = Math.max(1, ...Object.values(dim.values));
              const topUser = scored.find(u => (u.dimScores[dim.key] ?? 0) === maxVal);

              return (
                <div key={dim.key} className="flex items-center gap-2 py-0.5">
                  <DimIcon size={11} style={{ color: meta.color }} className="flex-shrink-0" />
                  <div className="w-12 flex-shrink-0">
                    <div className="text-[10px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{meta.short}</div>
                  </div>
                  <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="h-full flex">
                      {scored.map((u, idx) => {
                        const val = u.dimScores[dim.key] ?? 0;
                        const pct = total > 0 ? (val / total) * 100 : 0;
                        return pct > 0 ? (
                          <div key={u.userId} className="h-full" style={{ width: `${pct}%`, background: USER_COLORS[idx % USER_COLORS.length], opacity: 0.8 }} title={`${u.displayName}: ${val}`} />
                        ) : null;
                      })}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <span className="text-[10px] font-bold tabular-nums" style={{ color: meta.color }}>{total.toLocaleString()}</span>
                    {topUser && <span className="text-[9px] ml-0.5" style={{ color: 'var(--text-muted)' }}>({topUser.displayName})</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2 mt-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            {scored.slice(0, 8).map((u, idx) => (
              <div key={u.userId} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: USER_COLORS[idx % USER_COLORS.length] }} />
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{u.displayName}</span>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      {/* ── Per-dimension Leaderboard Cards ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {activeDims.map(dim => {
          const meta = DIMENSION_META[dim.key] ?? { icon: Bot, color: 'rgba(148,163,184,0.7)', barColor: 'rgba(148,163,184,0.4)', short: dim.name };
          const DimIcon = meta.icon;
          const sortedEntries = scored
            .map(u => ({ ...u, val: u.dimScores[dim.key] ?? 0 }))
            .filter(u => u.val > 0)
            .sort((a, b) => b.val - a.val);
          const total = sortedEntries.reduce((s, e) => s + e.val, 0);
          const maxVal = sortedEntries[0]?.val ?? 1;

          return (
            <GlassCard key={dim.key} glow className="!p-3">
              <div className="flex items-center gap-2 mb-2">
                <DimIcon size={14} style={{ color: meta.color }} />
                <span className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{dim.name}</span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                  {sortedEntries.length} 人参与 · 总计 {total.toLocaleString()}
                </span>
              </div>
              <div className="space-y-1">
                {sortedEntries.map((u, idx) => {
                  const mc = idx < 3 ? MEDAL_COLORS[idx] : null;
                  const roleColor = ROLE_COLORS[u.role] ?? 'rgba(148,163,184,0.8)';
                  const pct = (u.val / maxVal) * 100;
                  return (
                    <div key={u.userId} className="flex items-center gap-2 py-0.5">
                      <span className="w-5 text-center flex-shrink-0">
                        {mc ? <span className="text-[12px]">{mc.medal}</span> : <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{idx + 1}</span>}
                      </span>
                      {u.avatarFileName ? (
                        <img src={resolveAvatarUrl(u.avatarFileName)} className="w-5 h-5 rounded-full object-cover flex-shrink-0" alt="" />
                      ) : (
                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold flex-shrink-0"
                          style={{ background: `${roleColor}22`, color: roleColor }}>{u.displayName[0]}</div>
                      )}
                      <div className="w-12 flex-shrink-0">
                        <div className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{u.displayName}</div>
                        <div className="text-[8px]" style={{ color: roleColor }}>{u.role}</div>
                      </div>
                      <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: meta.barColor }} />
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

      {/* ── Zone 3: Full Ranking Table ── */}
      <GlassCard glow>
        <SectionTitle>综合排行榜</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <th className="text-left py-2.5 pr-2 font-medium w-8" style={{ color: 'var(--text-muted)' }}>#</th>
                <th className="text-left py-2.5 pr-4 font-medium" style={{ color: 'var(--text-muted)' }}>成员</th>
                <th
                  className="text-right py-2.5 px-2 font-medium cursor-pointer select-none whitespace-nowrap"
                  style={{ color: sortKey === 'total' ? 'rgba(214,178,106,0.95)' : 'var(--text-muted)' }}
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
                const roleColor = ROLE_COLORS[user.role] ?? 'rgba(148,163,184,0.8)';
                const isTop3 = idx < 3 && sortKey === 'total' && sortDir === 'desc';
                const medals = ['🥇', '🥈', '🥉'];

                return (
                  <tr
                    key={user.userId}
                    className="transition-colors hover:bg-white/[0.02]"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: isTop3 ? 'rgba(214,178,106,0.04)' : undefined }}
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
                          <img src={resolveAvatarUrl(user.avatarFileName)} className="w-6 h-6 rounded-full object-cover" alt="" />
                        ) : (
                          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                            style={{ background: `${roleColor}22`, color: roleColor }}>
                            {user.displayName[0]}
                          </div>
                        )}
                        <div>
                          <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{user.displayName}</div>
                          <div className="text-[9px]" style={{ color: roleColor }}>{user.role}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                          <div className="h-full rounded-full" style={{ width: `${(user.totalScore / maxScore) * 100}%`, background: 'linear-gradient(90deg, rgba(214,178,106,0.6), rgba(214,178,106,0.9))' }} />
                        </div>
                        <span className="tabular-nums font-bold text-[12px] w-10 text-right" style={{ color: isTop3 ? 'rgba(214,178,106,0.95)' : 'var(--text-primary)' }}>
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
                            <div className="w-10 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: meta?.barColor ?? 'rgba(148,163,184,0.5)' }} />
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

      <GlassCard glow>
        <SectionTitle>按模型调用量</SectionTitle>
        <EChart option={makeModelBarOption(models.slice(0, 15))} height={300} />
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
  );
}

// ─── Tab: Integrations (placeholder) ────────────────────────────────

function IntegrationsTab() {
  const integrations = [
    { source: 'Claude Code', icon: Zap, color: 'rgba(214,178,106,0.95)', desc: '代码变更、Commit 统计自动汇入周报' },
    { source: 'Jira', icon: BarChart3, color: 'rgba(59,130,246,0.95)', desc: '任务进度、Sprint 数据自动同步' },
    { source: 'GitLab', icon: Activity, color: 'rgba(168,85,247,0.95)', desc: 'MR 数量、代码审查、CI/CD 状态' },
    { source: '飞书', icon: MessageSquare, color: 'rgba(34,197,94,0.95)', desc: '周报自动推送、审批流程对接' },
  ];

  const roadmap = [
    { phase: 'Phase 1', label: '数据采集层', status: 'planned' as const, items: ['Webhook 回调接口', '活动数据标准化', '来源身份验证'] },
    { phase: 'Phase 2', label: '集成适配器', status: 'planned' as const, items: ['Claude Code 适配器', 'GitLab 适配器', 'Jira 适配器'] },
    { phase: 'Phase 3', label: '数据融合展示', status: 'planned' as const, items: ['个人画像跨源合并', '周报自动汇总', '团队协作热力图'] },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {integrations.map(int => (
          <GlassCard key={int.source} glow>
            <div className="flex items-center gap-2.5 mb-2.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${int.color}15` }}>
                <int.icon size={16} style={{ color: int.color }} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{int.source}</div>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>规划中</div>
              </div>
              <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.15)' }} />
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{int.desc}</div>
          </GlassCard>
        ))}
      </div>

      <GlassCard glow>
        <SectionTitle>集成路线图</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
          {roadmap.map((phase, idx) => (
            <div key={phase.phase} className="relative">
              {idx < roadmap.length - 1 && (
                <div className="hidden md:block absolute top-5 -right-2 w-4 h-0.5" style={{ background: 'rgba(255,255,255,0.1)' }} />
              )}
              <div className="p-4 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                    style={{ background: 'rgba(214,178,106,0.15)', color: 'rgba(214,178,106,0.9)' }}>
                    {idx + 1}
                  </div>
                  <div>
                    <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{phase.label}</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{phase.phase}</div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {phase.items.map(item => (
                    <div key={item} className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      <div className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: 'rgba(214,178,106,0.5)' }} />
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
