/**
 * 左栏：**环境列表**，不是目标列表。
 *
 * 每行回答两件事：这个环境此刻健不健康、它跑着哪一版、落后主干多少。
 * 停用与归档目标沉到底部折叠区——它们点得到，但不该和在跑的环境抢注意力。
 */

import { ChevronDown, Plus } from 'lucide-react';
import { describeCommitPosition, formatAgo } from '@/lib/releaseRail';
import type { EnvironmentSection } from '@/lib/releaseEnvironments';
import { Button } from '@/components/ui/button';
import { Chip, Led, SectionLabel, formatDateTime, healthLabel, healthTone } from './shared';
import type { CenterRow, ReleaseTarget } from './types';

export interface EnvironmentSidebarProps {
  sections: Array<EnvironmentSection<CenterRow>>;
  selectedTargetId: string;
  branch: string;
  archivedTargets: ReleaseTarget[];
  nowMs: number;
  onSelect: (targetId: string) => void;
  onAdd: () => void;
}

export function EnvironmentSidebar({
  sections,
  selectedTargetId,
  branch,
  archivedTargets,
  nowMs,
  onSelect,
  onAdd,
}: EnvironmentSidebarProps): JSX.Element {
  const activeCount = sections.reduce((sum, section) => sum + section.entries.length, 0);
  const disabledCount = sections.reduce((sum, section) => sum + section.disabledEntries.length, 0);

  return (
    // 移动端：限高 + 自身滚动（自然流）；lg 起才切回填满整列高度。
    <aside className="cds-surface-raised cds-hairline flex max-h-[46vh] min-h-0 flex-col overflow-hidden rounded-lg lg:h-full lg:max-h-none">
      <div className="flex shrink-0 items-center justify-between border-b border-[hsl(var(--hairline))] px-3.5 py-2.5">
        <SectionLabel>环境</SectionLabel>
        <span className="text-xs text-muted-foreground">{activeCount}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.map((section) => (
          <div key={`${section.environment}-${section.label}`}>
            {section.entries.map((entry) => (
              <EnvironmentRow
                key={entry.targetId}
                row={entry.row}
                label={section.degraded ? entry.row.target.name : section.label}
                subLabel={section.degraded ? '' : entry.row.target.name}
                isCanonical={entry.isCanonical}
                selected={entry.targetId === selectedTargetId}
                branch={branch}
                nowMs={nowMs}
                onSelect={() => onSelect(entry.targetId)}
              />
            ))}
          </div>
        ))}

        {disabledCount > 0 ? (
          <details className="border-t border-[hsl(var(--hairline))]">
            <summary className="flex cursor-pointer items-center gap-1.5 px-3.5 py-2.5 text-xs text-muted-foreground">
              <ChevronDown className="h-3.5 w-3.5" />
              已停用 {disabledCount}
            </summary>
            {sections.flatMap((section) => section.disabledEntries.map((entry) => (
              <EnvironmentRow
                key={entry.targetId}
                row={entry.row}
                label={section.degraded ? entry.row.target.name : section.label}
                subLabel={entry.row.target.name}
                isCanonical={false}
                selected={entry.targetId === selectedTargetId}
                branch={branch}
                nowMs={nowMs}
                onSelect={() => onSelect(entry.targetId)}
              />
            )))}
          </details>
        ) : null}

        {archivedTargets.length > 0 ? (
          <details className="border-t border-[hsl(var(--hairline))]">
            <summary className="flex cursor-pointer items-center gap-1.5 px-3.5 py-2.5 text-xs text-muted-foreground">
              <ChevronDown className="h-3.5 w-3.5" />
              已归档发布目标 {archivedTargets.length}
            </summary>
            <div className="divide-y divide-[hsl(var(--hairline))] border-t border-[hsl(var(--hairline))]">
              {archivedTargets.map((target) => (
                <div key={target.id} className="px-3.5 py-2.5">
                  <div className="truncate text-[13px] text-muted-foreground">{target.name}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {target.archiveReason || '未记录归档原因'}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {formatDateTime(target.archivedAt)} · {target.archivedBy || '-'}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-[hsl(var(--hairline))] p-3">
        <Button variant="outline" className="w-full justify-center" onClick={onAdd}>
          <Plus />
          添加环境
        </Button>
      </div>
    </aside>
  );
}

function EnvironmentRow({
  row,
  label,
  subLabel,
  isCanonical,
  selected,
  branch,
  nowMs,
  onSelect,
}: {
  row: CenterRow;
  label: string;
  subLabel: string;
  isCanonical: boolean;
  selected: boolean;
  branch: string;
  nowMs: number;
  onSelect: () => void;
}): JSX.Element {
  const tone = healthTone(row.healthStatus);
  const position = describeCommitPosition(row.commitPosition, branch);
  const releasedAgo = formatAgo(row.lastReleasedAt, nowMs);
  const latestFailed = row.latestRun && (row.latestRun.status === 'failed' || row.latestRun.status === 'rollback_failed');

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[10px_minmax(0,1fr)] items-start gap-2.5 border-b border-[hsl(var(--hairline))] px-3.5 py-3 text-left transition-colors ${
        selected ? 'bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]' : 'hover:bg-[hsl(var(--surface-sunken))]/60'
      }`}
    >
      <span className="mt-1.5"><Led tone={tone} /></span>
      <span className="min-w-0">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-semibold">{label}</span>
          <Chip tone={tone}>{healthLabel(row.healthStatus)}</Chip>
        </span>
        {subLabel ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{subLabel}</span> : null}
        <span className="mt-1 block truncate font-mono text-[11px] tabular-nums text-muted-foreground">
          {row.currentCommit ? row.currentCommit.slice(0, 7) : '未发布'}
          {releasedAgo ? ` · ${releasedAgo}` : ''}
          {isCanonical ? ' · 主目标' : ''}
        </span>
        <span className={`mt-1 block truncate text-[11px] ${position.tone === 'warn' ? 'text-warn' : 'text-muted-foreground'}`}>
          {position.text}
        </span>
        {latestFailed && row.latestRun ? (
          <span className="mt-1 block truncate text-[11px] text-bad">
            最近一次尝试 {row.latestRun.commitSha.slice(0, 7)} 失败
          </span>
        ) : null}
      </span>
    </button>
  );
}
