/*
 * 故障时间线（全实例）。右栏的第二个页签：按时间倒序，进行中的置顶且带来源标，
 * 点一条就跳到那个目标的详情。
 */
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  formatClock,
  formatDuration,
  type UptimeIncidentView,
} from '@/lib/monitorCenter';
import { SegmentedControl, SourceBadge } from './primitives';

export type IncidentFilter = 'all' | 'ongoing' | 'release';

export function IncidentTimeline({ incidents, filter, onFilter, onOpenTarget }: {
  incidents: ReadonlyArray<UptimeIncidentView>;
  filter: IncidentFilter;
  onFilter: (next: IncidentFilter) => void;
  onOpenTarget: (targetId: string) => void;
}): JSX.Element {
  const ongoing = incidents.filter((i) => i.ongoing).length;
  const release = incidents.filter((i) => i.source === 'release').length;
  const shown = incidents.filter((i) => (filter === 'ongoing' ? i.ongoing : filter === 'release' ? i.source === 'release' : true));
  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] p-4">
        <div>
          <h2 className="text-base font-semibold">故障时间线</h2>
          <p className="text-xs text-muted-foreground">连续失败达到阈值自动合成一条；恢复后记录持续时长。最近 {incidents.length} 条。</p>
        </div>
        <SegmentedControl<IncidentFilter>
          value={filter}
          options={[
            { value: 'all', label: '全部', count: incidents.length },
            { value: 'ongoing', label: '进行中', count: ongoing },
            { value: 'release', label: '生产', count: release },
          ]}
          onChange={onFilter}
          ariaLabel="筛选故障"
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3" style={{ overscrollBehavior: 'contain' }}>
        {shown.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[hsl(var(--hairline-strong))] px-4 py-10 text-center text-sm text-muted-foreground">
            {incidents.length === 0 ? '暂未记录到故障事件。' : '这个筛选下没有故障事件。'}
          </div>
        ) : (
          <ol className="relative flex flex-col gap-2 pl-4 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-[hsl(var(--hairline))]">
            {shown.map((incident) => (
              <li key={incident.id} className="relative">
                <span
                  className={cn(
                    'absolute -left-4 top-3 inline-flex h-2.5 w-2.5 rounded-full border-2 border-[hsl(var(--surface-raised))]',
                    incident.ongoing ? 'bg-destructive' : 'bg-ok',
                  )}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => onOpenTarget(incident.targetId)}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-left text-xs transition-colors hover:border-[hsl(var(--hairline-strong))]',
                    incident.ongoing ? 'border-destructive/40 bg-destructive/5' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40',
                  )}
                >
                  <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-medium', incident.ongoing ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-[hsl(var(--hairline-strong))] text-muted-foreground')}>
                    {incident.ongoing ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                    {incident.ongoing ? '进行中' : '已恢复'}
                  </span>
                  <SourceBadge source={incident.source} />
                  <span className="min-w-0 truncate font-medium text-foreground">{incident.targetName}</span>
                  <span className="font-mono text-muted-foreground">{formatClock(incident.startedAt)}</span>
                  <span className="text-muted-foreground">持续 {formatDuration(incident.durationMs)}</span>
                  <span className="min-w-0 basis-full truncate text-muted-foreground sm:basis-auto sm:flex-1" title={incident.cause}>{incident.cause}</span>
                  {incident.releaseId ? (
                    // 归因只是「时间上最近的那次发布」，不是因果证明，所以文案用「疑似」。
                    <span className="shrink-0 rounded-full border border-[hsl(var(--hairline-strong))] px-2 py-0.5 font-mono text-[11px] text-muted-foreground" title={`故障判定发生在发布 ${incident.releaseId} 完成之后 ${formatDuration(incident.releaseAgeMs ?? 0)}`}>
                      疑似 {incident.releaseId}
                      {typeof incident.releaseAgeMs === 'number' ? ` 后 ${formatDuration(incident.releaseAgeMs)}` : ''}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
