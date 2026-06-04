/**
 * 产品管理智能体 — 报表/统计（版本进度 + 迭代速度 + 总体进度，P2）。
 *
 * 数据源：当前需求状态(按工作流分类) + 活动时间线的流转记录(近 8 周进入终态吞吐)。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { EChart } from '@/components/charts/EChart';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getProductAnalytics, type ProductAnalytics } from '@/services/real/productAgent';

const C = { done: '#22c55e', doing: '#f59e0b', todo: '#64748b', req: '#38bdf8', feat: '#a78bfa' };

export function ReportsTab({ productId }: { productId: string }) {
  const [data, setData] = useState<ProductAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getProductAnalytics(productId);
    if (res.success) setData(res.data);
    setLoading(false);
  }, [productId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const overallPie = useMemo<EChartsOption | null>(() => {
    if (!data) return null;
    const o = data.overall;
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 } },
      series: [{
        type: 'pie', radius: ['45%', '70%'], center: ['50%', '44%'],
        data: [
          { name: '已完成', value: o.done, itemStyle: { color: C.done } },
          { name: '进行中', value: o.doing, itemStyle: { color: C.doing } },
          { name: '待办', value: o.todo, itemStyle: { color: C.todo } },
        ],
        label: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
        itemStyle: { borderColor: '#0f1014', borderWidth: 2 },
      }],
    };
  }, [data]);

  const releaseBar = useMemo<EChartsOption | null>(() => {
    if (!data) return null;
    const rows = data.releaseProgress;
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 } },
      grid: { left: 8, right: 16, top: 16, bottom: 36, containLabel: true },
      xAxis: { type: 'category', data: rows.map((r) => r.versionName), axisLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: 'rgba(255,255,255,0.4)' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
      series: [
        { name: '已完成', type: 'bar', stack: 'x', data: rows.map((r) => r.done), itemStyle: { color: C.done } },
        { name: '进行中', type: 'bar', stack: 'x', data: rows.map((r) => r.doing), itemStyle: { color: C.doing } },
        { name: '待办', type: 'bar', stack: 'x', data: rows.map((r) => r.todo), itemStyle: { color: C.todo } },
      ],
    };
  }, [data]);

  const velocityChart = useMemo<EChartsOption | null>(() => {
    if (!data) return null;
    const w = data.velocity;
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 } },
      grid: { left: 8, right: 16, top: 16, bottom: 36, containLabel: true },
      xAxis: { type: 'category', data: w.map((x) => x.week), axisLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: 'rgba(255,255,255,0.4)' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
      series: [
        { name: '需求完成', type: 'bar', stack: 'v', data: w.map((x) => x.requirements), itemStyle: { color: C.req, borderRadius: [0, 0, 0, 0] }, barMaxWidth: 28 },
        { name: '功能完成', type: 'bar', stack: 'v', data: w.map((x) => x.features), itemStyle: { color: C.feat }, barMaxWidth: 28 },
      ],
    };
  }, [data]);

  if (loading) return <MapSectionLoader text="正在生成报表…" />;
  if (!data) return <div className="text-sm text-white/40 py-10 text-center">加载失败</div>;

  const o = data.overall;
  const pct = o.total > 0 ? Math.round((o.done / o.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 总体 KPI */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="需求总数" value={o.total} />
        <Kpi label="已完成" value={o.done} color={C.done} />
        <Kpi label="进行中" value={o.doing} color={C.doing} />
        <Kpi label="完成率" value={`${pct}%`} color={C.done} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="总体进度">{overallPie && <EChart option={overallPie} height={260} />}</ChartCard>
        <ChartCard title="迭代速度（近 8 周完成吞吐）">{velocityChart && <EChart option={velocityChart} height={260} />}</ChartCard>
      </div>
      <ChartCard title="版本进度（按需求状态）">
        {data.releaseProgress.length === 0 ? (
          <div className="text-[12px] text-white/30 py-10 text-center">还没有版本。去「版本」新建后，这里按版本展示需求完成进度。</div>
        ) : (
          releaseBar && <EChart option={releaseBar} height={300} />
        )}
      </ChartCard>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
      <div className="text-2xl font-semibold leading-none" style={{ color: color ?? 'rgba(255,255,255,0.92)' }}>{value}</div>
      <div className="text-[11px] text-white/45 mt-1.5">{label}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="text-xs font-semibold text-white/60 mb-3">{title}</div>
      {children}
    </div>
  );
}
