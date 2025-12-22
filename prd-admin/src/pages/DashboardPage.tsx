import type { EChartsOption } from 'echarts';
import { EChart } from '@/components/charts/EChart';
import { Badge } from '@/components/design/Badge';
import { Card } from '@/components/design/Card';
import { KpiCard } from '@/components/design/KpiCard';
import { Select } from '@/components/design/Select';
import { getActiveGroups, getGapStats, getLlmLogs, getMessageTrend, getOverviewStats, getTokenUsage } from '@/services';
import type { ActiveGroup, GapStats, TrendItem, TokenUsage } from '@/services/contracts/adminStats';
import type { LlmRequestLogListItem } from '@/types/admin';
import { useEffect, useMemo, useState } from 'react';

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
  }, []);

  useEffect(() => {
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
  }, [days]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[26px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>仪表盘</div>
          <div className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            LLM 可观测性 · Token · TTFB · 缓存 · 趋势
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="min-w-[120px] font-medium">
            <option value={7}>最近7天</option>
            <option value={14}>最近14天</option>
            <option value={30}>最近30天</option>
          </Select>
          <Badge variant="new">LLM</Badge>
          <Badge variant="featured">Observability</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="总用户数" value={overview?.totalUsers ?? 0} loading={loadingBase} />
        <KpiCard title="活跃用户" value={overview?.activeUsers ?? 0} loading={loadingBase} accent="green" />
        <KpiCard title="群组数" value={overview?.totalGroups ?? 0} loading={loadingBase} />
        <KpiCard title="今日消息" value={overview?.todayMessages ?? 0} loading={loadingBase} accent="green" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card>
          <div className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>LLM 关键指标（近 180 条采样）</div>
          <div className="mt-3 grid gap-3">
            <div className="rounded-[14px] p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>TTFB 分位数</div>
              <div className="mt-1 flex items-end justify-between gap-2">
                <div className="text-[22px] font-semibold" style={{ color: 'var(--text-primary)' }}>{loadingBase ? '—' : fmtMs(obs?.ttfbP50Ms ?? null)}</div>
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>P50</div>
              </div>
              <div className="mt-1 flex items-end justify-between gap-2">
                <div className="text-[16px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{loadingBase ? '—' : fmtMs(obs?.ttfbP95Ms ?? null)}</div>
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>P95</div>
              </div>
            </div>

            <div className="rounded-[14px] p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>Prompt Cache 命中率</div>
              <div className="mt-1 flex items-end justify-between gap-2">
                <div className="text-[22px] font-semibold" style={{ color: 'var(--accent-green)' }}>
                  {loadingBase ? '—' : fmtPct01(obs?.cacheHitRate ?? null)}
                </div>
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                  sample {obs?.sample ?? 0}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(obs?.typeCounts ?? []).map((x) => (
                  <span
                    key={x.type}
                    className="inline-flex items-center gap-2 rounded-full px-2.5 h-6 text-[11px] font-semibold"
                    style={{ border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)' }}
                    title={x.type}
                  >
                    <span style={{ color: '#E7CE97' }}>{x.type}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{x.count}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>消息趋势（近 {days} 天）</div>
          </div>
          <div className="mt-3 rounded-[14px] overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
            {loadingSeries ? (
              <div className="h-[280px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            ) : trend.length === 0 ? (
              <div className="h-[280px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            ) : (
              <div className="p-3">
                <EChart option={trendOption} height={280} />
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>Token（近 {days} 天总量）</div>
          <div className="mt-3 grid gap-2">
            <div className="rounded-[14px] px-4 py-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>Input</div>
              <div className="mt-1 text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>{loadingSeries ? '—' : (token?.totalInput ?? 0)}</div>
            </div>
            <div className="rounded-[14px] px-4 py-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>Output</div>
              <div className="mt-1 text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>{loadingSeries ? '—' : (token?.totalOutput ?? 0)}</div>
            </div>
            <div className="rounded-[14px] px-4 py-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>Total</div>
              <div className="mt-1 text-[20px] font-semibold" style={{ color: '#E7CE97' }}>{loadingSeries ? '—' : (token?.totalTokens ?? 0)}</div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            内容缺失统计（共{gapStats?.total ?? 0}条）
          </div>
          <div className="mt-3 rounded-[14px] overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
            {loadingBase ? (
              <div className="h-[260px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            ) : !gapStats ? (
              <div className="h-[260px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            ) : (
              <div className="p-3">
                <EChart option={gapOption} height={260} />
              </div>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>活跃群组 TOP 8</div>
            <Badge variant="subtle" size="sm">按消息/缺失综合</Badge>
          </div>
          <div className="mt-3 overflow-hidden rounded-[14px]" style={{ border: '1px solid var(--border-subtle)' }}>
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
                <tr>
                  <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>群组</th>
                  <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>成员</th>
                  <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>消息</th>
                  <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>缺失</th>
                </tr>
              </thead>
              <tbody>
                {loadingBase ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</td>
                  </tr>
                ) : groups.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>暂无数据</td>
                  </tr>
                ) : (
                  groups.map((g) => (
                    <tr key={g.groupId} className="hover:bg-white/2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td className="px-4 py-3">
                        <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{g.groupName}</div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{g.groupId}</div>
                      </td>
                      <td className="px-4 py-3 text-right" style={{ color: 'var(--text-secondary)' }}>{g.memberCount}</td>
                      <td className="px-4 py-3 text-right" style={{ color: 'var(--accent-green)' }}>{g.messageCount}</td>
                      <td
                        className="px-4 py-3 text-right"
                        style={{ color: g.gapCount > 0 ? 'rgba(245,158,11,0.95)' : 'rgba(247,247,251,0.45)' }}
                      >
                        {g.gapCount}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
 
    </div>
  );
}

