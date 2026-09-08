/*
 * 顶部总览：一句结论 + 四个关键数。
 *
 * 结论先于数字：横幅先回答「现在怎么样、谁出了问题、多久了」，KPI 只做支撑，
 * 每个数都能点进去（点故障数 = 列表切到故障筛选）。
 */
import { Activity, AlertTriangle, CheckCircle2, PauseCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  formatClock,
  formatLatency,
  formatPercent,
  overallAvailability24h,
  overallAvgLatency24h,
  type MonitorHeadline,
  type StatusFilter,
  type UptimeIncidentView,
  type UptimeSummary,
} from '@/lib/monitorCenter';

const TONE_CLASS: Record<MonitorHeadline['tone'], string> = {
  ok: 'border-ok/40 bg-ok-soft text-ok',
  warn: 'border-warn/40 bg-warn-soft text-warn',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  neutral: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
};

const TONE_ICON: Record<MonitorHeadline['tone'], typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: Activity,
  danger: AlertTriangle,
  neutral: PauseCircle,
};

function Kpi({ label, value, hint, active, onClick, tone }: {
  label: string;
  value: string;
  hint?: string;
  active?: boolean;
  onClick?: () => void;
  tone?: 'ok' | 'danger' | 'warn' | 'default';
}): JSX.Element {
  const valueTone = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-destructive' : tone === 'warn' ? 'text-warn' : 'text-foreground';
  const body = (
    <>
      <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums leading-tight', valueTone)}>{value}</div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div> : null}
    </>
  );
  const cls = cn(
    'min-w-0 rounded-lg border px-3 py-2 text-left transition-colors',
    active ? 'border-primary/50 bg-primary/10' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]',
    onClick ? 'hover:border-[hsl(var(--hairline-strong))]' : '',
  );
  return onClick
    ? <button type="button" className={cls} onClick={onClick} aria-pressed={active}>{body}</button>
    : <div className={cls}>{body}</div>;
}

export function OverviewStrip({ summary, incidents, headline, statusFilter, onStatusFilter }: {
  summary: UptimeSummary;
  incidents: ReadonlyArray<UptimeIncidentView>;
  headline: MonitorHeadline;
  statusFilter: StatusFilter;
  onStatusFilter: (next: StatusFilter) => void;
}): JSX.Element {
  const Icon = TONE_ICON[headline.tone];
  const { overall } = summary;
  const active = summary.targets.filter((t) => !t.excluded);
  const availability = overallAvailability24h(active);
  const latency = overallAvgLatency24h(active);
  const ongoing = incidents.filter((i) => i.ongoing).length;
  const toggle = (next: StatusFilter): void => onStatusFilter(statusFilter === next ? 'all' : next);

  return (
    <div className="flex flex-col gap-2">
      <div className={cn('flex flex-col gap-1.5 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between', TONE_CLASS[headline.tone])}>
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <div className="text-base font-semibold leading-tight">{headline.title}</div>
            <div className="mt-0.5 text-xs leading-5 opacity-85">{headline.detail}</div>
          </div>
        </div>
        <div className="shrink-0 text-[11px] opacity-75 sm:text-right">
          每 {summary.intervalSeconds} 秒探测 · 连续 {summary.failureThreshold} 次失败判定故障
          <br />
          最近一轮 {summary.lastCycleAt ? formatClock(summary.lastCycleAt) : '尚未开始'}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="正常" value={String(overall.up)} tone="ok" active={statusFilter === 'up'} onClick={() => toggle('up')} hint={`共 ${overall.total} 个目标`} />
        <Kpi label="故障" value={String(overall.down)} tone={overall.down > 0 ? 'danger' : 'default'} active={statusFilter === 'down'} onClick={() => toggle('down')} hint={ongoing > 0 ? `${ongoing} 起故障进行中` : '没有进行中的故障'} />
        <Kpi label="待确认" value={String(overall.unknown)} tone={overall.unknown > 0 ? 'warn' : 'default'} active={statusFilter === 'unknown'} onClick={() => toggle('unknown')} hint="首轮探测或未达阈值" />
        <Kpi label="暂停 / 未纳入" value={String(overall.paused + (overall.excluded ?? 0))} active={statusFilter === 'paused'} onClick={() => toggle('paused')} hint="降温、手动暂停、排除名单" />
        <Kpi label="近 24h 可用率" value={formatPercent(availability)} hint="按采样次数加权" />
        <Kpi label="平均响应" value={formatLatency(latency)} hint="近 24h，只算在探的目标" />
      </div>
    </div>
  );
}
