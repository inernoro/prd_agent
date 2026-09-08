/*
 * 左栏：目标列表。默认只展示主站（自定义监控 + 生产发布目标）；分支按项目折成一条
 * 汇总行（运行中几条、几正常几故障几降温、「展开」），点开模态窗看全部分支。
 *
 * 每行一眼要回答三件事：它是谁（名 + 来源）、现在怎么样（状态点 + 迷你条）、
 * 值不值得点开（24h 可用率 / 响应）。排序由后端 compareTargetsForDisplay 给定
 * （故障 → 待确认 → 正常 → 暂停），列表不再乱序。
 */
import { ChevronRight, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  SOURCE_META,
  STATUS_FILTERS,
  formatLatency,
  formatPercent,
  groupTargetsBySource,
  type ProbeSource,
  type ProjectBranchGroup,
  type StatusFilter,
  type TargetFilter,
  type UptimeTargetSummary,
} from '@/lib/monitorCenter';
import { AvailabilityBar, SegmentedControl, StatusDot } from './primitives';

const MINI_SEGMENTS = 30;

function TargetRow({ target, selected, onSelect }: {
  target: UptimeTargetSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const muted = target.excluded || target.status === 'paused';
  return (
    <button
      type="button"
      onClick={() => onSelect(target.id)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group flex w-full flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors',
        selected
          ? 'border-primary/50 bg-primary/10'
          : 'border-transparent hover:border-[hsl(var(--hairline))] hover:bg-[hsl(var(--surface-sunken))]/70',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={target.status} excluded={target.excluded} measured={target.measured} />
        <span className={cn('min-w-0 flex-1 truncate text-sm', muted ? 'text-muted-foreground' : 'font-medium text-foreground')}>
          {target.name}
        </span>
        <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
          {target.status === 'down'
            ? <span className="text-destructive">{formatPercent(target.availability24h)}</span>
            : target.measured === false ? '未实测' : formatPercent(target.availability24h)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <AvailabilityBar
          buckets={target.buckets}
          segments={MINI_SEGMENTS}
          compact
          className="min-w-0 flex-1 opacity-90"
          label={`${target.name} 最近 24 小时可用率分布`}
        />
        <span className="w-14 shrink-0 text-right font-mono text-[0.625rem] tabular-nums text-muted-foreground">
          {formatLatency(target.avgLatencyMs24h)}
        </span>
      </div>
    </button>
  );
}

const DOT_TONE = { ok: 'bg-ok', bad: 'bg-destructive', warn: 'bg-warn', muted: 'bg-[hsl(var(--hairline-strong))]' } as const;

/** 项目分支汇总行：主列表只汇总，明细进模态窗。 */
function BranchSummaryRow({ group, onOpen }: { group: ProjectBranchGroup; onOpen: (group: ProjectBranchGroup) => void }): JSX.Element {
  const dots = [
    ...Array.from({ length: group.ok }, () => 'ok' as const),
    ...Array.from({ length: group.bad }, () => 'bad' as const),
    ...Array.from({ length: group.unmeasured }, () => 'warn' as const),
    ...Array.from({ length: Math.min(group.idle, 6) }, () => 'muted' as const),
  ];
  return (
    <button
      type="button"
      onClick={() => onOpen(group)}
      className="flex w-full flex-col gap-1.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-2.5 py-2 text-left transition-colors hover:border-[hsl(var(--hairline-strong))]"
      aria-label={`展开 ${group.projectName} 的全部分支`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
          {group.bad > 0 ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" /> : null}
          <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', group.bad > 0 ? 'bg-destructive' : group.running > 0 ? 'bg-ok' : 'bg-[hsl(var(--hairline-strong))]')} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.projectName} · 分支</span>
        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">运行中 {group.running} / 共 {group.total}</span>
        <span className="inline-flex shrink-0 items-center text-xs font-medium text-primary">展开<ChevronRight className="h-3.5 w-3.5" /></span>
      </div>
      <div className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
        <span className="inline-flex gap-[3px]">
          {dots.map((tone, i) => <span key={i} className={cn('inline-block h-2 w-2 rounded-full', DOT_TONE[tone])} />)}
        </span>
        <span>
          {group.ok} 正常 · <span className={group.bad > 0 ? 'text-destructive' : ''}>{group.bad} 故障</span>
          {group.unmeasured > 0 ? ` · ${group.unmeasured} 未实测` : ''} · {group.idle} 已降温（不计故障）
        </span>
      </div>
    </button>
  );
}

export function TargetList({
  targets,
  allTargets,
  branchGroups,
  filter,
  onFilter,
  selectedId,
  onSelect,
  onOpenBranches,
}: {
  /** 已按 filter 过滤后的主站目标（自定义 + 生产） */
  targets: ReadonlyArray<UptimeTargetSummary>;
  /** 全量目标（算筛选计数） */
  allTargets: ReadonlyArray<UptimeTargetSummary>;
  branchGroups: ReadonlyArray<ProjectBranchGroup>;
  filter: TargetFilter;
  onFilter: (next: TargetFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenBranches: (group: ProjectBranchGroup) => void;
}): JSX.Element {
  const groups = groupTargetsBySource(targets).filter((g) => g.source !== 'branch');
  const branchCount = allTargets.filter((t) => t.source === 'branch').length;
  const statusOptions = STATUS_FILTERS.map((f) => ({
    value: f.value,
    label: f.label,
    count: f.value === 'all'
      ? allTargets.length
      : f.value === 'paused'
        ? allTargets.filter((t) => t.status === 'paused' || t.excluded).length
        : allTargets.filter((t) => t.status === f.value && !t.excluded && (f.value !== 'up' || t.measured !== false)).length,
  }));
  const sourceOptions: Array<{ value: ProbeSource | 'all'; label: string; count?: number }> = [
    { value: 'all', label: '全部来源' },
    ...(['custom', 'release', 'branch'] as const)
      .map((source) => ({ value: source, label: SOURCE_META[source].short, count: allTargets.filter((t) => t.source === source).length }))
      .filter((s) => s.count > 0),
  ];
  const showBranches = filter.source === 'all' || filter.source === 'branch';
  const showMain = filter.source !== 'branch';
  const empty = (showMain ? groups.length === 0 : true) && (!showBranches || branchGroups.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
      <div className="flex shrink-0 flex-col gap-2 border-b border-[hsl(var(--hairline))] p-2.5">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={filter.query}
            onChange={(event) => onFilter({ ...filter, query: event.target.value })}
            placeholder="搜索名称、地址、分支或标签"
            aria-label="搜索监控目标"
            className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] pl-8 pr-8 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-primary/60"
          />
          {filter.query ? (
            <button
              type="button"
              onClick={() => onFilter({ ...filter, query: '' })}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="清空搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <SegmentedControl<StatusFilter>
            value={filter.status}
            options={statusOptions}
            onChange={(status) => onFilter({ ...filter, status })}
            ariaLabel="按状态筛选"
          />
          {sourceOptions.length > 2 ? (
            <SegmentedControl<ProbeSource | 'all'>
              value={filter.source}
              options={sourceOptions}
              onChange={(source) => onFilter({ ...filter, source })}
              ariaLabel="按来源筛选"
            />
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" style={{ overscrollBehavior: 'contain' }}>
        {empty ? (
          <div className="px-3 py-10 text-center text-xs leading-5 text-muted-foreground">
            {allTargets.length === 0 ? '还没有监控目标。' : '没有匹配的目标，换个筛选条件试试。'}
          </div>
        ) : null}
        {showMain ? groups.map((group) => (
          <section key={group.source} className="mb-2 last:mb-0">
            <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-[hsl(var(--surface-raised))]/95 px-2.5 py-1.5 backdrop-blur-sm">
              <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h3>
              <span className="font-mono text-[0.625rem] text-muted-foreground/80">{group.targets.length}</span>
              {group.down > 0 ? (
                <span className="ml-auto rounded-full bg-destructive/15 px-1.5 font-mono text-[0.625rem] text-destructive">{group.down} 故障</span>
              ) : null}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.targets.map((target) => (
                <TargetRow key={target.id} target={target} selected={target.id === selectedId} onSelect={onSelect} />
              ))}
            </div>
          </section>
        )) : null}
        {showBranches && branchGroups.length > 0 ? (
          <section className="mb-2 last:mb-0">
            <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-[hsl(var(--surface-raised))]/95 px-2.5 py-1.5 backdrop-blur-sm">
              <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">分支预览（点开看全部，存活的排前面）</h3>
              <span className="font-mono text-[0.625rem] text-muted-foreground/80">{branchCount}</span>
            </div>
            <div className="flex flex-col gap-1">
              {branchGroups.map((group) => <BranchSummaryRow key={group.projectId} group={group} onOpen={onOpenBranches} />)}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
