import { lazy, Suspense } from 'react';
import type { EChartsOption } from 'echarts';
import { useDataTheme } from '@/hooks/useDataTheme';
import type { McpCallTrendDto } from '@/services/contracts/mcpConsole';
const EChart = lazy(() => import('@/components/charts/EChart').then(module => ({ default: module.EChart })));

export function McpCallTrendChart({ trend }: { trend?: McpCallTrendDto }) {
  useDataTheme();
  const tokens = getComputedStyle(document.documentElement);
    const color = (name: string) => tokens.getPropertyValue(name).trim();
  const option: EChartsOption = {
      animation: false,
      grid: { left: 32, right: 12, top: 14, bottom: 24 },
      tooltip: { trigger: 'axis', confine: true },
      xAxis: { type: 'category', boundaryGap: false,
        data: trend?.points.map(point => new Date(point.hourUtc).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })) ?? [],
        axisLabel: { color: color('--text-muted'), fontSize: 10, hideOverlap: true },
        axisLine: { lineStyle: { color: color('--border-subtle') } }, axisTick: { show: false } },
      yAxis: { type: 'value', min: 0, minInterval: 1, axisLabel: { color: color('--text-muted'), fontSize: 10 },
        splitLine: { lineStyle: { color: color('--border-subtle') } } },
      series: [{ name: '工具调用次数', type: 'line', smooth: false, symbolSize: 4, showSymbol: false,
        data: trend?.points.map(point => point.calls) ?? [], lineStyle: { width: 2 }, itemStyle: { color: color('--accent-primary') } }],
  };
  const total = trend?.points.reduce((sum, point) => sum + point.calls, 0);
  return <section className="mcp-call-trend" aria-label="调用频率">
    <header><b>调用频率</b><span>近 24 个小时 · 次/小时 · 当前小时未结束</span>{trend && <span>合计 {total} 次</span>}</header>
    {trend ? <><Suspense fallback={<p>正在加载趋势图…</p>}><EChart option={option} height={104} /></Suspense>
      <span className="sr-only">{trend.points.map(point => `${point.hourUtc}：${point.calls} 次`).join('；')}</span></> : <p>趋势数据暂不可用，请刷新重试。</p>}
  </section>;
}
