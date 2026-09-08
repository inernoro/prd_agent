/*
 * 左栏：目标列表。搜索 + 状态 / 来源筛选 + 按来源分组，每行带迷你可用率条。
 *
 * 每行一眼要回答三件事：它是谁（名 + 来源）、现在怎么样（状态点 + 迷你条）、
 * 值不值得点开（24h 可用率 / 响应）。排序由后端 compareTargetsForDisplay 给定
 * （故障 → 待确认 → 正常 → 暂停），列表不再乱序。
 */
import { Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  SOURCE_META,
  SOURCE_ORDER,
  STATUS_FILTERS,
  formatLatency,
  formatPercent,
  groupTargetsBySource,
  type ProbeSource,
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
        <StatusDot status={target.status} excluded={target.excluded} />
        <span className={cn('min-w-0 flex-1 truncate text-sm', muted ? 'text-muted-foreground' : 'font-medium text-foreground')}>
          {target.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {target.status === 'down' && target.lastSample?.err
            ? <span className="text-destructive">{formatPercent(target.availability24h)}</span>
            : formatPercent(target.availability24h)}
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
        <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
          {formatLatency(target.avgLatencyMs24h)}
        </span>
      </div>
    </button>
  );
}

export function TargetList({
  targets,
  allTargets,
  filter,
  onFilter,
  selectedId,
  onSelect,
}: {
  /** 已按 filter 过滤后的目标 */
  targets: ReadonlyArray<UptimeTargetSummary>;
  /** 全量目标（算筛选计数） */
  allTargets: ReadonlyArray<UptimeTargetSummary>;
  filter: TargetFilter;
  onFilter: (next: TargetFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const groups = groupTargetsBySource(targets);
  const sourceCounts = SOURCE_ORDER.map((source) => ({ source, count: allTargets.filter((t) => t.source === source).length }));
  const statusOptions = STATUS_FILTERS.map((f) => ({
    value: f.value,
    label: f.label,
    count: f.value === 'all'
      ? allTargets.length
      : f.value === 'paused'
        ? allTargets.filter((t) => t.status === 'paused' || t.excluded).length
        : allTargets.filter((t) => t.status === f.value && !t.excluded).length,
  }));
  const sourceOptions: Array<{ value: ProbeSource | 'all'; label: string; count?: number }> = [
    { value: 'all', label: '全部来源' },
    ...sourceCounts.filter((s) => s.count > 0).map((s) => ({ value: s.source, label: SOURCE_META[s.source].short, count: s.count })),
  ];

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
        {groups.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs leading-5 text-muted-foreground">
            {allTargets.length === 0 ? '还没有监控目标。' : '没有匹配的目标，换个筛选条件试试。'}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.source} className="mb-2 last:mb-0">
              <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-[hsl(var(--surface-raised))]/95 px-2.5 py-1.5 backdrop-blur-sm">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h3>
                <span className="font-mono text-[10px] text-muted-foreground/80">{group.targets.length}</span>
                {group.down > 0 ? (
                  <span className="ml-auto rounded-full bg-destructive/15 px-1.5 font-mono text-[10px] text-destructive">{group.down} 故障</span>
                ) : null}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.targets.map((target) => (
                  <TargetRow key={target.id} target={target} selected={target.id === selectedId} onSelect={onSelect} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
