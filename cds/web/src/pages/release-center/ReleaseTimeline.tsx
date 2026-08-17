/**
 * 发布时间线：每行是「这一版做了什么」，不是「rel_xxxx 这个 id」。
 *
 * 提交说明来自 center 的 commitMeta（按 sha 索引）。台账里没有这个 sha 时
 * 退化成只显示 short sha —— 绝不拿分支名 / 操作人顶替，那会让人以为看到了提交说明。
 *
 * 失败行显著标出，并且可以就地展开完整诊断：用户看到失败的下一秒就想知道为什么，
 * 不该再跳一次页面。
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatAgo } from '@/lib/releaseRail';
import { FailureDiagnosis } from './FailureDiagnosis';
import { Chip, CodeText, Led, formatDateTime, formatDuration, runTone, statusLabel } from './shared';
import type { CenterRow, ReleaseCommitMeta, ReleaseRun } from './types';
import { isReleaseFailed } from './types';

export type TimelineFilter = 'all' | 'failed';

export interface ReleaseTimelineProps {
  title: string;
  runs: ReleaseRun[];
  row?: CenterRow;
  commitMeta: Record<string, ReleaseCommitMeta>;
  nowMs: number;
  liveReleaseId?: string;
  retryingRunId: string;
  filter?: TimelineFilter;
  onFilter?: (filter: TimelineFilter) => void;
  onOpenLogs: (run: ReleaseRun) => void;
  onRetry: (run: ReleaseRun) => void;
  onRollback: (run: ReleaseRun) => void;
  /** 「查看全部 N 次」链接。缺省即不显示。 */
  onSeeAll?: () => void;
  seeAllLabel?: string;
}

export function ReleaseTimeline({
  title,
  runs,
  row,
  commitMeta,
  nowMs,
  liveReleaseId,
  retryingRunId,
  filter,
  onFilter,
  onOpenLogs,
  onRetry,
  onRollback,
  onSeeAll,
  seeAllLabel,
}: ReleaseTimelineProps): JSX.Element {
  const [expandedId, setExpandedId] = useState('');

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden rounded-lg">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-4 py-2.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {onFilter ? (
            <>
              <FilterChip active={filter !== 'failed'} onClick={() => onFilter('all')}>全部</FilterChip>
              <FilterChip active={filter === 'failed'} onClick={() => onFilter('failed')}>仅失败</FilterChip>
            </>
          ) : null}
          {onSeeAll ? (
            <button type="button" onClick={onSeeAll} className="text-xs text-primary hover:underline">
              {seeAllLabel || '查看全部'}
            </button>
          ) : null}
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          还没有符合条件的发布记录。
        </div>
      ) : (
        <div className="divide-y divide-[hsl(var(--hairline))]">
          {runs.map((run) => {
            const failed = isReleaseFailed(run.status);
            const live = run.releaseId === liveReleaseId;
            const meta = commitMeta[run.commitSha];
            const expanded = expandedId === run.releaseId;
            const duration = formatDuration(run.startedAt, run.finishedAt);
            return (
              <div key={run.releaseId} className={failed ? 'bg-bad-soft' : live ? 'bg-primary/[0.07]' : ''}>
                <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-3 px-4 py-3 md:grid-cols-[16px_minmax(0,1fr)_auto]">
                  <span className="mt-1.5"><Led tone={runTone(run.status)} /></span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium" title={meta?.subject || run.commitSha}>
                      {meta?.subject || `提交 ${run.commitSha.slice(0, 12)}`}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
                      <CodeText>{run.commitSha.slice(0, 7)}</CodeText>
                      {run.artifact?.branchName ? <span className="truncate">{run.artifact.branchName}</span> : null}
                      <span>{run.operator || meta?.authorName || '-'}</span>
                      <span>{formatDateTime(run.startedAt)}</span>
                      {duration ? <span>耗时 {duration}</span> : null}
                      {run.rollbackOf ? <Chip tone="warn">回滚</Chip> : null}
                      {!failed && !live ? <Chip>{statusLabel(run.status)}</Chip> : null}
                      {failed ? <Chip tone="bad">{statusLabel(run.status)}</Chip> : null}
                      {live ? <Chip tone="live">线上</Chip> : null}
                    </div>
                  </div>
                  <div className="col-start-2 flex flex-wrap gap-2 md:col-start-3">
                    {failed ? (
                      <Button
                        size="sm"
                        variant={expanded ? 'outline' : 'default'}
                        onClick={() => setExpandedId(expanded ? '' : run.releaseId)}
                      >
                        {expanded ? <ChevronDown /> : <ChevronRight />}
                        {expanded ? '收起诊断' : '看失败原因'}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" onClick={() => onOpenLogs(run)}>
                      <FileText />
                      日志
                    </Button>
                    {!failed && !live ? (
                      <Button size="sm" variant="outline" onClick={() => onRollback(run)}>
                        <RotateCcw />
                        回滚到此版本
                      </Button>
                    ) : null}
                  </div>
                </div>
                {expanded ? (
                  <div className="border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 px-4 py-4">
                    <FailureDiagnosis
                      run={run}
                      row={row}
                      retrying={retryingRunId === run.releaseId}
                      canRollback={Boolean(row?.canRollback)}
                      onRetry={onRetry}
                      onRollback={onRollback}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {runs.length > 0 && runs[0] ? (
        <div className="border-t border-[hsl(var(--hairline))] px-4 py-2 text-[11px] text-muted-foreground">
          最近一次记录于 {formatAgo(runs[0].startedAt, nowMs) || '-'}
        </div>
      ) : null}
    </section>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs ${
        active
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}
