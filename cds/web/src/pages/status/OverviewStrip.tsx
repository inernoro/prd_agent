/*
 * 顶部总览：一句结论 + 六个关键数 + 覆盖面条。
 *
 * 结论先于数字：横幅先回答「现在怎么样、谁出了问题、多久了」，右侧一行是探测器自身健康
 * （监测本身没停才谈别的）。六个关键数按「实测正常 / 故障 / 待确认 / 未实测 / 暂停 / 可用率」，
 * 按容器状态判出来的不算正常。覆盖面条回答「还有谁没被盯」，点开看清单与判定手段。
 */
import { Activity, AlertTriangle, CheckCircle2, PauseCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  formatDuration,
  formatPercent,
  formatRelative,
  overallAvailability24h,
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

function proberLine(summary: UptimeSummary, now: number): string {
  const p = summary.prober;
  if (!p) return `每 ${summary.intervalSeconds} 秒探测 · 连续 ${summary.failureThreshold} 次失败判定故障`;
  if (!p.lastCycleAt) return '探测器尚未跑完第一轮';
  const head = p.stalled ? '探测器停了' : '探测器正常';
  const dur = p.lastCycleDurationMs !== null ? `，耗时 ${formatDuration(p.lastCycleDurationMs)}` : '';
  return `${head}：上一轮 ${formatRelative(p.lastCycleAt, now)}${dur}，${p.lastCycleProbed}/${p.lastCycleTargets} 目标完成`;
}

export function OverviewStrip({ summary, incidents, headline, statusFilter, onStatusFilter, onOpenCoverage, now }: {
  summary: UptimeSummary;
  incidents: ReadonlyArray<UptimeIncidentView>;
  headline: MonitorHeadline;
  statusFilter: StatusFilter;
  onStatusFilter: (next: StatusFilter) => void;
  onOpenCoverage: () => void;
  now: number;
}): JSX.Element {
  const Icon = TONE_ICON[headline.tone];
  const { overall } = summary;
  const measured = summary.targets.filter((t) => !t.excluded && t.measured !== false);
  const availability = overallAvailability24h(measured);
  const ongoing = incidents.filter((i) => i.ongoing).length;
  const unmeasured = overall.unmeasured ?? 0;
  const toggle = (next: StatusFilter): void => onStatusFilter(statusFilter === next ? 'all' : next);
  const coverage = summary.coverage;

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
        <div className="shrink-0 text-[11px] leading-4 opacity-75 sm:text-right">
          {proberLine(summary, now)}
          <br />
          每 {summary.intervalSeconds} 秒探测 · 连续 {summary.failureThreshold} 次失败判定故障 · 视角：CDS 主机{summary.prober?.userViewEnabled === false ? '' : ' + 分支用户视角'}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="正常（实测）" value={String(overall.up)} tone="ok" active={statusFilter === 'up'} onClick={() => toggle('up')} hint="真发过请求探到的" />
        <Kpi label="故障" value={String(overall.down)} tone={overall.down > 0 ? 'danger' : 'default'} active={statusFilter === 'down'} onClick={() => toggle('down')} hint={ongoing > 0 ? `${ongoing} 起故障进行中` : '没有进行中的故障'} />
        <Kpi label="待确认" value={String(overall.unknown)} tone={overall.unknown > 0 ? 'warn' : 'default'} active={statusFilter === 'unknown'} onClick={() => toggle('unknown')} hint="首轮探测或未达阈值" />
        <Kpi label="未实测" value={String(unmeasured)} tone={unmeasured > 0 ? 'warn' : 'default'} hint="只按容器状态判定，不算正常" />
        <Kpi label="暂停 / 未纳入" value={String(overall.paused + (overall.excluded ?? 0))} active={statusFilter === 'paused'} onClick={() => toggle('paused')} hint="降温、手动暂停、排除名单" />
        <Kpi label="近 24h 可用率" value={formatPercent(availability)} hint="只算实测目标，暂停不计分母" />
      </div>
      {coverage ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3.5 py-2 text-[13px]">
          <span className="font-semibold">覆盖面</span>
          <span>
            全站可监测对象 <span className="font-mono font-semibold">{coverage.total}</span>，已纳入{' '}
            <span className="font-mono font-semibold text-ok">{coverage.covered}</span>，未纳入{' '}
            <span className={cn('font-mono font-semibold', coverage.uncovered.length > 0 ? 'text-warn' : 'text-muted-foreground')}>{coverage.uncovered.length}</span>
          </span>
          {coverage.byReason.length > 0 ? <span className="text-muted-foreground">·</span> : null}
          {coverage.byReason.map((r) => (
            <span key={r.kind} className="inline-flex items-center gap-1 rounded-full border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] px-2.5 py-0.5 text-xs">
              {r.kind} <span className="font-mono text-muted-foreground">{r.count}</span>
            </span>
          ))}
          <button type="button" onClick={onOpenCoverage} className="ml-auto text-[13px] font-medium text-primary hover:underline">
            查看未纳入清单与判定手段 →
          </button>
        </div>
      ) : null}
    </div>
  );
}
