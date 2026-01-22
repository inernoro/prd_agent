import type { EChartsOption } from 'echarts';
import { EChart } from '@/components/charts/EChart';
import { Badge } from '@/components/design/Badge';
import { GlassCard } from '@/components/design/GlassCard';
import { KpiCard } from '@/components/design/KpiCard';
import { Select } from '@/components/design/Select';
import { TabBar } from '@/components/design/TabBar';
import { LayoutDashboard } from 'lucide-react';
import { getActiveGroups, getGapStats, getLlmLogs, getMessageTrend, getOverviewStats, getTokenUsage } from '@/services';
import type { ActiveGroup, GapStats, TrendItem, TokenUsage } from '@/services/contracts/adminStats';
import type { LlmRequestLogListItem } from '@/types/admin';
import { useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

type ObsMetrics = {
  sample: number;
  ttfbP50Ms: number | null;
  ttfbP95Ms: number | null;
  cacheHitRate: number | null; // 0-1
  typeCounts: Array<{ type: string; count: number }>;
};

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pos = (xs.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = xs[base]!;
  const b = xs[Math.min(base + 1, xs.length - 1)]!;
  return a + (b - a) * rest;
}

function fmtPct01(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

function fmtMs(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v)}ms`;
}

function normalizeReqType(t: string | null | undefined): string {
  const s = (t ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  return s;
}

function calcObs(logs: LlmRequestLogListItem[]): ObsMetrics {
  const sample = logs.length;
  const ttfb = logs
    .map((x) => {
      const a = toMs(x.startedAt);
      const b = toMs(x.firstByteAt ?? null);
      if (a == null || b == null) return null;
      const d = b - a;
      return d > 0 && d < 120_000 ? d : null; // 防御：异常数据
    })
    .filter((v): v is number => typeof v === 'number');

  const hitCount = logs.filter((x) => (x.cacheReadInputTokens ?? 0) > 0).length;
  const cacheHitRate = sample > 0 ? hitCount / sample : null;

  const map = new Map<string, number>();
  for (const x of logs) {
    const key = normalizeReqType(x.requestType);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  const typeCounts = Array.from(map.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  return {
    sample,
    ttfbP50Ms: percentile(ttfb, 0.5),
    ttfbP95Ms: percentile(ttfb, 0.95),
    cacheHitRate,
    typeCounts,
  };
}

export default function DashboardPage() {
  const permissions = useAuthStore((s) => s.permissions);
  const hasLogsRead = permissions.includes('logs.read');

  const [days, setDays] = useState(14);
  const [overview, setOverview] = useState<{ totalUsers: number; activeUsers: number; totalGroups: number; todayMessages: number } | null>(null);
  const [token, setToken] = useState<TokenUsage | null>(null);
  const [trend, setTrend] = useState<TrendItem[]>([]);
  const [groups, setGroups] = useState<ActiveGroup[]>([]);
  const [gapStats, setGapStats] = useState<GapStats | null>(null);
  const [obs, setObs] = useState<ObsMetrics | null>(null);
  const [loadingBase, setLoadingBase] = useState(true);
  const [loadingSeries, setLoadingSeries] = useState(true);

  useEffect(() => {
    // 只有有 logs.read 权限时才请求统计数据
    if (!hasLogsRead) {
      setLoadingBase(false);
      return;
    }
    (async () => {
      setLoadingBase(true);
      try {
        const [overviewRes, groupsRes, gapRes, logsRes] = await Promise.all([
          getOverviewStats(),
          getActiveGroups(8),
          getGapStats(),
          getLlmLogs({ page: 1, pageSize: 180 }),
        ]);

        if (overviewRes.success) setOverview(overviewRes.data);
        if (groupsRes.success) setGroups(groupsRes.data);
        if (gapRes.success) setGapStats(gapRes.data);
        if (logsRes.success) setObs(calcObs(logsRes.data.items ?? []));
      } finally {
        setLoadingBase(false);
      }
    })();
  }, [hasLogsRead]);

  useEffect(() => {
    // 只有有 logs.read 权限时才请求趋势数据
    if (!hasLogsRead) {
      setLoadingSeries(false);
      return;
    }
    (async () => {
      setLoadingSeries(true);
      try {
        const [tokenRes, trendRes] = await Promise.all([getTokenUsage(days), getMessageTrend(days)]);
        if (tokenRes.success) setToken(tokenRes.data);
        if (trendRes.success) setTrend(trendRes.data);
      } finally {
        setLoadingSeries(false);
      }
    })();
  }, [days, hasLogsRead]);

  const baseOption: Pick<EChartsOption, 'backgroundColor' | 'textStyle'> = useMemo(
    () => ({
      backgroundColor: 'transparent',
      textStyle: {
        color: 'rgba(247,247,251,0.72)',
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      },
    }),
    []
  );

  const trendOption: EChartsOption = useMemo(
    () => ({
      ...baseOption,
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(18,18,22,0.92)',
        borderColor: 'rgba(255,255,255,0.12)',
        textStyle: { color: '#f7f7fb' },
      },
      grid: { left: 10, right: 10, top: 18, bottom: 18, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: trend.map((t) => t.date.slice(5)),
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
        axisLabel: { color: 'rgba(247,247,251,0.55)' },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
        axisLabel: { color: 'rgba(247,247,251,0.55)' },
      },
      series: [
        {
          type: 'line',
          data: trend.map((t) => t.count),
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2, color: 'rgba(214,178,106,0.95)' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(214,178,106,0.22)' },
                { offset: 1, color: 'rgba(214,178,106,0.02)' },
              ],
            },
          },
        },
      ],
    }),
    [baseOption, trend]
  );

  const gapOption: EChartsOption = useMemo(
    () => ({
      ...baseOption,
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(18,18,22,0.92)',
        borderColor: 'rgba(255,255,255,0.12)',
        textStyle: { color: '#f7f7fb' },
      },
      legend: {
        bottom: 0,
        left: 'center',
        textStyle: { color: 'rgba(247,247,251,0.62)' },
      },
      series: [
        {
          type: 'pie',
          radius: ['42%', '68%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          data: gapStats
            ? [
                { value: gapStats.byStatus.pending, name: '待处理', itemStyle: { color: 'rgba(245,158,11,0.95)' } },
                { value: gapStats.byStatus.resolved, name: '已解决', itemStyle: { color: 'rgba(34,197,94,0.95)' } },
                { value: gapStats.byStatus.ignored, name: '已忽略', itemStyle: { color: 'rgba(247,247,251,0.35)' } },
              ]
            : [],
        },
      ],
    }),
    [baseOption, gapStats]
  );

  // 没有 logs.read 权限时显示欢迎页面
  if (!hasLogsRead) {
    return (
      <div className="space-y-6">
        <TabBar title="仪表盘" icon={<LayoutDashboard size={16} />} />
        <GlassCard glow>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <LayoutDashboard size={48} className="mb-4" style={{ color: 'var(--text-muted)' }} />
            <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              欢迎使用米多智能体平台
            </h2>
            <p className="text-sm max-w-md" style={{ color: 'var(--text-secondary)' }}>
              请从左侧菜单选择功能开始使用。如需查看统计数据，请联系管理员获取相应权限。
            </p>
          </div>
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TabBar
        title="仪表盘"
        icon={<LayoutDashboard size={16} />}
        actions={
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="min-w-[120px] font-medium h-[28px]" uiSize="sm">
            <option value={7}>最近7天</option>
            <option value={14}>最近14天</option>
            <option value={30}>最近30天</option>
          </Select>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 grid-rows-[auto]">
        <KpiCard title="总用户数" value={overview?.totalUsers ?? 0} loading={loadingBase} accent="gold" />
        <KpiCard title="活跃用户" value={overview?.activeUsers ?? 0} loading={loadingBase} accent="green" />
        <KpiCard title="群组数" value={overview?.totalGroups ?? 0} loading={loadingBase} accent="blue" />
        <KpiCard title="今日消息" value={overview?.todayMessages ?? 0} loading={loadingBase} accent="purple" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4" style={{ minHeight: 360 }}>
        <GlassCard glow>
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="text-[14px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>LLM 关键指标</div>
            <div className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}>
              近 180 条
            </div>
          </div>
          <div className="grid gap-3">
            <div className="rounded-[12px] p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>TTFB</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[20px] font-bold tabular-nums" style={{ color: 'var(--accent-gold)' }}>{loadingBase ? '—' : fmtMs(obs?.ttfbP50Ms ?? null)}</div>
                  <div className="text-[10px] font-medium mt-0.5" style={{ color: 'var(--text-muted)' }}>P50</div>
                </div>
                <div>
                  <div className="text-[20px] font-bold tabular-nums" style={{ color: 'var(--text-secondary)' }}>{loadingBase ? '—' : fmtMs(obs?.ttfbP95Ms ?? null)}</div>
                  <div className="text-[10px] font-medium mt-0.5" style={{ color: 'var(--text-muted)' }}>P95</div>
                </div>
              </div>
            </div>

            <div className="rounded-[12px] p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Cache Hit</div>
                <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  {obs?.sample ?? 0} samples
                </div>
              </div>
              <div className="text-[24px] font-bold tabular-nums" style={{ color: 'var(--accent-green)' }}>
                {loadingBase ? '—' : fmtPct01(obs?.cacheHitRate ?? null)}
              </div>
              {/* 固定最小高度，避免标签加载后布局跳动 */}
              <div className="mt-3 min-h-[48px] flex flex-wrap gap-1.5 content-start">
                {(obs?.typeCounts ?? []).map((x) => (
                  <span
                    key={x.type}
                    className="inline-flex items-center gap-1.5 rounded-[8px] px-2 h-[22px] text-[10px] font-semibold"
                    style={{ background: 'rgba(214,178,106,0.08)', border: '1px solid rgba(214,178,106,0.15)', color: 'var(--accent-gold)' }}
                    title={x.type}
                  >
                    <span>{x.type}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{x.count}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </GlassCard>

        <GlassCard glow className="lg:col-span-2">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="text-[14px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>消息趋势</div>
            <div className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}>
              近 {days} 天
            </div>
          </div>
          <div className="rounded-[12px] overflow-hidden" style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.05)' }}>
            {loadingSeries ? (
              <div className="h-[280px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  <span className="text-sm">加载中...</span>
                </div>
              </div>
            ) : trend.length === 0 ? (
              <div className="h-[280px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            ) : (
              <div className="p-3">
                <EChart option={trendOption} height={280} />
              </div>
            )}
          </div>
        </GlassCard>

        <GlassCard glow>
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="text-[14px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>Token 用量</div>
            <div className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}>
              近 {days} 天
            </div>
          </div>
          <div className="grid gap-2">
            <div className="rounded-[12px] px-4 py-3" style={{ background: 'rgba(59,130,246,0.04)', border: '1px solid rgba(59,130,246,0.1)' }}>
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Input</div>
                <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(59,130,246,0.8)' }} />
              </div>
              <div className="mt-1 text-[18px] font-bold tabular-nums" style={{ color: 'rgba(59,130,246,0.95)' }}>
                {loadingSeries ? '—' : (token?.totalInput ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="rounded-[12px] px-4 py-3" style={{ background: 'rgba(34,197,94,0.04)', border: '1px solid rgba(34,197,94,0.1)' }}>
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Output</div>
                <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(34,197,94,0.8)' }} />
              </div>
              <div className="mt-1 text-[18px] font-bold tabular-nums" style={{ color: 'rgba(34,197,94,0.95)' }}>
                {loadingSeries ? '—' : (token?.totalOutput ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="rounded-[12px] px-4 py-3" style={{ background: 'rgba(214,178,106,0.04)', border: '1px solid rgba(214,178,106,0.1)' }}>
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Total</div>
                <div className="w-2 h-2 rounded-full" style={{ background: 'var(--accent-gold)' }} />
              </div>
              <div className="mt-1 text-[18px] font-bold tabular-nums" style={{ color: 'var(--accent-gold)' }}>
                {loadingSeries ? '—' : (token?.totalTokens ?? 0).toLocaleString()}
              </div>
            </div>
          </div>
        </GlassCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" style={{ minHeight: 380 }}>
        <GlassCard glow>
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="text-[14px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>内容缺失</div>
            <div className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(245,158,11,0.1)', color: 'rgba(245,158,11,0.9)' }}>
              {gapStats?.total ?? 0} 条
            </div>
          </div>
          <div className="rounded-[12px] overflow-hidden" style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.05)' }}>
            {loadingBase ? (
              <div className="h-[260px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  <span className="text-sm">加载中...</span>
                </div>
              </div>
            ) : !gapStats ? (
              <div className="h-[260px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            ) : (
              <div className="p-3">
                <EChart option={gapOption} height={260} />
              </div>
            )}
          </div>
        </GlassCard>

        <GlassCard glow className="lg:col-span-2">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="text-[14px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>活跃群组</div>
            <Badge variant="subtle" size="sm">TOP 8</Badge>
          </div>
          <div className="overflow-hidden rounded-[12px]" style={{ border: '1px solid rgba(255,255,255,0.05)' }}>
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(255,255,255,0.02)' }}>
                <tr>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>群组</th>
                  <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>成员</th>
                  <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>消息</th>
                  <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>缺失</th>
                </tr>
              </thead>
              <tbody>
                {loadingBase ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                        <span>加载中...</span>
                      </div>
                    </td>
                  </tr>
                ) : groups.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>暂无数据</td>
                  </tr>
                ) : (
                  groups.map((g, idx) => (
                    <tr key={g.groupId} className="transition-colors hover:bg-white/[0.02]" style={{ borderTop: idx === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)' }}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-[13px]" style={{ color: 'var(--text-primary)' }}>{g.groupName}</div>
                        <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>{g.groupId.slice(0, 8)}...</div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium" style={{ color: 'var(--text-secondary)' }}>{g.memberCount}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-green)' }}>{g.messageCount}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium" style={{ color: g.gapCount > 0 ? 'rgba(245,158,11,0.95)' : 'var(--text-muted)' }}>
                        {g.gapCount}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </GlassCard>
      </div>
 
    </div>
  );
}

