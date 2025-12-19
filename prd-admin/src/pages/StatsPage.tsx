import type { EChartsOption } from 'echarts';
import { EChart } from '@/components/charts/EChart';
import { Card } from '@/components/design/Card';
import { KpiCard } from '@/components/design/KpiCard';
import { Select } from '@/components/design/Select';
import { getActiveGroups, getGapStats, getMessageTrend, getTokenUsage } from '@/services';
import type { ActiveGroup, GapStats, TrendItem } from '@/services/contracts/adminStats';
import { useEffect, useMemo, useState } from 'react';

type TokenData = {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
};

export default function StatsPage() {
  const [days, setDays] = useState(7);
  const [token, setToken] = useState<TokenData | null>(null);
  const [trend, setTrend] = useState<TrendItem[]>([]);
  const [groups, setGroups] = useState<ActiveGroup[]>([]);
  const [gapStats, setGapStats] = useState<GapStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [tokenRes, trendRes, groupsRes, gapRes] = await Promise.all([
          getTokenUsage(days),
          getMessageTrend(days),
          getActiveGroups(10),
          getGapStats(),
        ]);

        if (tokenRes.success) setToken(tokenRes.data);
        if (trendRes.success) setTrend(trendRes.data);
        if (groupsRes.success) setGroups(groupsRes.data);
        if (gapRes.success) setGapStats(gapRes.data);
      } finally {
        setLoading(false);
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
          <div className="text-[26px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
            Token统计
          </div>
          <div className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            API 使用量与内容缺失分析
          </div>
        </div>
        <Select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="min-w-[130px] font-medium"
        >
          <option value={7}>最近7天</option>
          <option value={14}>最近14天</option>
          <option value={30}>最近30天</option>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="总输入Token" value={token?.totalInput ?? 0} loading={loading} accent="green" suffix="tokens" />
        <KpiCard title="总输出Token" value={token?.totalOutput ?? 0} loading={loading} suffix="tokens" />
        <KpiCard title="总Token消耗" value={token?.totalTokens ?? 0} loading={loading} suffix="tokens" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            消息趋势（近{days}天）
          </div>
          <div
            className="mt-3 rounded-[14px] overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}
          >
            {loading ? (
              <div className="h-[280px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                加载中...
              </div>
            ) : trend.length === 0 ? (
              <div className="h-[280px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                暂无数据
              </div>
            ) : (
              <div className="p-3">
                <EChart option={trendOption} height={280} />
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            内容缺失统计（共{gapStats?.total ?? 0}条）
          </div>
          <div
            className="mt-3 rounded-[14px] overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}
          >
            {loading ? (
              <div className="h-[280px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                加载中...
              </div>
            ) : !gapStats ? (
              <div className="h-[280px] flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                暂无数据
              </div>
            ) : (
              <div className="p-3">
                <EChart option={gapOption} height={280} />
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          活跃群组 TOP 10
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
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    加载中...
                  </td>
                </tr>
              ) : groups.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    暂无数据
                  </td>
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
  );
}
