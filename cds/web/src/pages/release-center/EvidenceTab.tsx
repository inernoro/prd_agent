/**
 * 日志与证据页签：选一次发布看它的步骤与完整日志，外加这个目标的配置变更历史。
 *
 * 「证据」这个词在这里是字面意思：这一屏摆的全是可回溯的事实
 * （谁在什么时候改了什么、哪一次发布跑了哪些步骤、原始日志一行不删），
 * 不做任何加工结论——结论在概览页和失败诊断里。
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { ApiError, apiRequest } from '@/lib/api';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { CodeText, StatusPill, formatClock, formatDateTime, formatDuration } from './shared';
import { RELEASE_CHANGE_KIND_LABELS, type CenterRow, type ReleaseRun, type ReleaseTargetChange } from './types';

export interface EvidenceTabProps {
  row: CenterRow;
  runs: ReleaseRun[];
}

export function EvidenceTab({ row, runs }: EvidenceTabProps): JSX.Element {
  const [selectedId, setSelectedId] = useState('');
  const [changes, setChanges] = useState<ReleaseTargetChange[]>([]);
  const [changesError, setChangesError] = useState('');
  const [changesLoading, setChangesLoading] = useState(false);

  const selected = runs.find((run) => run.releaseId === selectedId) || runs[0];

  useEffect(() => {
    let cancelled = false;
    setChangesLoading(true);
    setChangesError('');
    apiRequest<{ changes: ReleaseTargetChange[] }>(
      `/api/releases/targets/${encodeURIComponent(row.target.id)}/changes?limit=20`,
    )
      .then((res) => { if (!cancelled) setChanges(res.changes || []); })
      .catch((err) => {
        if (cancelled) return;
        setChanges([]);
        setChangesError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setChangesLoading(false); });
    return () => { cancelled = true; };
  }, [row.target.id]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="cds-surface-raised cds-hairline overflow-hidden rounded-lg">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-4 py-2.5">
          <h3 className="text-sm font-semibold">发布日志</h3>
          {runs.length > 0 ? (
            <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              选择发布
              <select
                value={selected?.releaseId || ''}
                onChange={(event) => setSelectedId(event.target.value)}
                className="h-8 max-w-[320px] rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 text-xs outline-none focus:border-primary/60"
              >
                {runs.slice(0, 20).map((run) => (
                  <option key={run.releaseId} value={run.releaseId}>
                    {run.commitSha.slice(0, 7)} · {formatDateTime(run.startedAt)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {!selected ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">这个环境还没有发布记录。</div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <StatusPill status={selected.status} />
              <CodeText>{selected.releaseId}</CodeText>
              <span>{formatDateTime(selected.startedAt)}</span>
              {formatDuration(selected.startedAt, selected.finishedAt)
                ? <span>耗时 {formatDuration(selected.startedAt, selected.finishedAt)}</span>
                : null}
              <span>{selected.operator || '-'}</span>
            </div>

            <RunSteps run={selected} />

            <pre
              className="max-h-[44vh] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6"
            >
              {(selected.logs || [])
                .map((log) => `[${formatClock(log.at)}] ${log.level.toUpperCase()} ${log.phase ? `${log.phase}: ` : ''}${log.message}`)
                .join('\n') || '这次发布没有留下日志。'}
            </pre>
          </div>
        )}
      </section>

      <section className="cds-surface-raised cds-hairline overflow-hidden rounded-lg">
        <div className="border-b border-[hsl(var(--hairline))] px-4 py-2.5 text-sm font-semibold">配置变更历史</div>
        {changesLoading ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取变更历史
          </div>
        ) : changesError ? (
          <div className="px-4 py-8 text-sm text-muted-foreground">变更历史暂时读不到：{changesError}</div>
        ) : changes.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">这个目标还没有配置变更记录。</div>
        ) : (
          <div className="divide-y divide-[hsl(var(--hairline))]">
            {changes.map((change, index) => (
              <div key={change.id || `${change.at}-${index}`} className="grid gap-1 px-4 py-3 text-[12.5px] md:grid-cols-[180px_minmax(0,1fr)]">
                <div className="text-muted-foreground">{formatDateTime(change.at)}</div>
                <div className="min-w-0">
                  <div>
                    {RELEASE_CHANGE_KIND_LABELS[change.kind] || change.kind}
                    {change.reason ? ` · ${change.reason}` : ''}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">{change.actor || '-'}</div>
                  {/* 明细必须逐条列 before → after：只写「修改配置」等于把这一栏的价值全丢了。 */}
                  {(change.changes || []).length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {change.changes.map((field) => (
                        <li key={field.path} className="text-[11.5px] text-muted-foreground">
                          <span className="text-foreground">{field.label}</span>
                          <span className="font-mono">
                            {`：${field.before || '空'} → ${field.after || '空'}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RunSteps({ run }: { run: ReleaseRun }): JSX.Element {
  const progress = resolveReleaseSteps(run);
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {progress.steps.map((step, index) => (
        <div
          key={step.id}
          className="flex items-center gap-2.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-[13px]"
        >
          {step.state === 'done' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            : step.state === 'failed' ? <XCircle className="h-4 w-4 shrink-0 text-red-500" />
              : step.state === 'running' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-500" />
                : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{index + 1}/{progress.total}</span>
          <span className="min-w-0 truncate">{step.label}</span>
        </div>
      ))}
    </div>
  );
}
