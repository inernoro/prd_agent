import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { TrendingDown, Wallet, RefreshCw, Gauge } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { EChart } from '@/components/charts/EChart';
import { toast } from '@/lib/toast';
import { getPmBurndown } from '@/services';
import type { PmBurndown } from '@/services/contracts/pmAgent';

interface Props {
  projectId: string;
}

/** 读取主题 token（echarts canvas 无法直接用 CSS 变量，渲染前取计算值） */
function themeColor(name: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 项目级燃尽 + 预算/挣值曲线报表。
 * 燃尽：剩余任务数随时间下降 vs 理想线；预算：计划价值(PV)/挣值(EV)/实际成本(AC)对照。
 * 数据来自 GET /api/pm/projects/{id}/burndown（完成时间由 pm_task_activities 重建）。
 */
export function BurndownPanel({ projectId }: Props) {
  const [data, setData] = useState<PmBurndown | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getPmBurndown(projectId);
    if (res.success) setData(res.data);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const axisColor = themeColor('--text-muted', '#94a3b8');
  const labelColor = themeColor('--text-secondary', '#64748b');
  const splitColor = 'rgba(148,163,184,0.18)';

  const burndownOption = useMemo<EChartsOption | null>(() => {
    if (!data) return null;
    const dates = data.points.map((p) => p.date);
    return {
      grid: { left: 40, right: 16, top: 28, bottom: 28 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['剩余任务', '理想燃尽'], textStyle: { color: labelColor, fontSize: 11 }, top: 0, right: 0 },
      xAxis: { type: 'category', data: dates, axisLabel: { color: axisColor, fontSize: 10 }, axisLine: { lineStyle: { color: splitColor } } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: axisColor, fontSize: 10 }, splitLine: { lineStyle: { color: splitColor } } },
      series: [
        { name: '剩余任务', type: 'line', smooth: true, connectNulls: false, data: data.points.map((p) => p.remaining), itemStyle: { color: '#3B82F6' }, areaStyle: { color: 'rgba(59,130,246,0.10)' }, symbol: 'circle', symbolSize: 4 },
        { name: '理想燃尽', type: 'line', smooth: true, data: data.points.map((p) => p.ideal), itemStyle: { color: '#94a3b8' }, lineStyle: { type: 'dashed' }, symbol: 'none' },
      ],
    };
  }, [data, axisColor, labelColor]);

  const budgetOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.budget == null) return null;
    const dates = data.points.map((p) => p.date);
    const ac = data.actualCost;
    return {
      grid: { left: 52, right: 16, top: 28, bottom: 28 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['计划价值 PV', '挣值 EV'], textStyle: { color: labelColor, fontSize: 11 }, top: 0, right: 0 },
      xAxis: { type: 'category', data: dates, axisLabel: { color: axisColor, fontSize: 10 }, axisLine: { lineStyle: { color: splitColor } } },
      yAxis: { type: 'value', axisLabel: { color: axisColor, fontSize: 10 }, splitLine: { lineStyle: { color: splitColor } } },
      series: [
        { name: '计划价值 PV', type: 'line', smooth: true, data: data.points.map((p) => p.pv), itemStyle: { color: '#F59E0B' }, lineStyle: { type: 'dashed' }, symbol: 'none' },
        {
          name: '挣值 EV', type: 'line', smooth: true, connectNulls: false, data: data.points.map((p) => p.ev), itemStyle: { color: '#10B981' }, areaStyle: { color: 'rgba(16,185,129,0.10)' }, symbol: 'circle', symbolSize: 4,
          markLine: ac != null ? { silent: true, symbol: 'none', data: [{ yAxis: ac, name: '实际成本 AC' }], lineStyle: { color: '#EF4444' }, label: { formatter: `实际成本 ${Math.round(ac)}`, color: '#EF4444', fontSize: 10, position: 'insideEndTop' } } : undefined,
        },
      ],
    };
  }, [data, axisColor, labelColor]);

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在生成报表…" /></div>;
  if (!data) return null;

  if (data.totalScope === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
        <TrendingDown size={30} style={{ color: 'var(--text-muted)' }} />
        <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>还没有任务数据，无法绘制燃尽图</div>
        <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>去「任务」Tab 创建或 AI 拆解任务后，这里会显示燃尽与预算挣值曲线。</div>
      </div>
    );
  }

  const spi = data.spi;
  const spiColor = spi == null ? 'var(--text-muted)' : spi >= 1 ? '#10B981' : spi >= 0.85 ? '#F59E0B' : '#EF4444';
  const spiLabel = spi == null ? '—' : spi >= 1 ? '超前 / 按期' : spi >= 0.85 ? '略落后' : '明显落后';

  const Stat = ({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) => (
    <div className="rounded-lg border px-3 py-2.5 flex flex-col gap-0.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-[17px] font-semibold tabular-nums" style={{ color: color || 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      <div className="flex items-center gap-2 shrink-0">
        <TrendingDown size={15} style={{ color: '#3B82F6' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>燃尽 / 预算挣值报表</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{data.start} ~ {data.plannedEnd}{data.overdue ? ' · 已过计划结束日' : ''}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={load}><RefreshCw size={13} />刷新</Button>
      </div>

      <div className="shrink-0 grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        <Stat label="完成率" value={`${data.completionRate}%`} sub={`${data.doneCount} / ${data.totalScope} 任务`} color="#3B82F6" />
        <Stat label="剩余任务" value={String(data.remaining)} sub={data.overdue ? '已超计划周期' : '按计划推进'} />
        <Stat label="进度绩效 SPI" value={spi == null ? '—' : spi.toFixed(2)} sub={spiLabel} color={spiColor} />
        {data.budget != null && (
          <Stat label="预算 / 实际" value={`${Math.round(data.budget)}`} sub={`实际 ${data.actualCost != null ? Math.round(data.actualCost) : '—'}`} color="#F59E0B" />
        )}
        {data.budget != null && (
          <Stat label="挣值 EV / 计划 PV" value={`${data.earnedValue ?? '—'}`} sub={`计划价值 ${data.plannedValue ?? '—'}`} color="#10B981" />
        )}
      </div>

      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="text-[11.5px] mb-1 flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}><Gauge size={12} />任务燃尽图（剩余 vs 理想）</div>
        {burndownOption && <EChart option={burndownOption} height={240} />}
      </div>

      {budgetOption ? (
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <div className="text-[11.5px] mb-1 flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}><Wallet size={12} />预算挣值曲线（PV 计划 / EV 挣值 / AC 实际）</div>
          <EChart option={budgetOption} height={240} />
          <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-muted)' }}>挣值 EV = 预算 × 完成率；计划价值 PV = 预算 × 时间消耗比；EV 在 PV 之上为提前产出价值，反之为滞后。</div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-4 text-[11.5px]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
          <Wallet size={13} className="inline mr-1" />未设置预算，无法绘制预算挣值曲线。在项目头部「编辑成本」设置预算后可见。
        </div>
      )}
    </div>
  );
}
