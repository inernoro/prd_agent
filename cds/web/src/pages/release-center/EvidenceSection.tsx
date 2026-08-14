/**
 * 分区五「证据归档」——设计稿 design_handoff_release_center §6。
 *
 * 元素照稿子：分区头写保留策略；每行 时间 150 / 环境 130 / sha 92 / 结果 104 /
 * 耗时 88 / 操作人 1fr / 「日志」「验收报告」两个 29px 按钮（没有报告时置灰 +
 * not-allowed）；底部一块日志预览代码块。
 *
 * 「验收报告」这一列按真实情况置灰：CDS 的验收报告挂在 `/reports`，一次发布有没有
 * 对应报告这边判不出来——所以按钮常态置灰并在 title 里说明去哪看，而不是给一个
 * 点了 404 的链接。稿子里那句「无报告/已过期时置灰」这里就是这么落的。
 *
 * 稿子之外多两块，因为它们是既有页面上真有、且后端仍在记录的证据，删掉等于
 * 让一条已经建好的链路静默失去消费方：
 * - 日志预览上方的**步骤条**（resolveReleaseSteps）：这次发布跑到了哪一步；
 * - 底部**配置变更历史**（`/api/releases/targets/:id/changes`）：谁在什么时候
 *   把哪个字段从什么改成了什么。逐条列 before → after，只写「配置更新」四个字
 *   等于把这一栏的价值全丢了。
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, FileText, Loader2, ScrollText, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { formatDateTime } from './shared';
import type { CenterRow, ReleaseRun, ReleaseTargetChange } from './types';
import { RELEASE_CHANGE_KIND_LABELS, isReleaseFailed } from './types';

export interface EvidenceSectionProps {
  row: CenterRow;
  runs: ReleaseRun[];
}

function durationOf(run: ReleaseRun): string {
  if (!run.startedAt || !run.finishedAt) return '-';
  const sec = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

const COLUMNS = '150px 130px 92px 104px 88px minmax(0,1fr) auto';

export function EvidenceSection({ row, runs }: EvidenceSectionProps): JSX.Element {
  const [selectedId, setSelectedId] = useState('');
  const selected = runs.find((run) => run.releaseId === selectedId) || runs[0];
  const [changes, setChanges] = useState<ReleaseTargetChange[]>([]);
  const [changesError, setChangesError] = useState('');
  const [changesLoading, setChangesLoading] = useState(false);

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
    <section className="cds-surface-raised cds-hairline overflow-hidden rounded-[14px] border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-4">
        <h2 className="text-sm font-bold">证据归档</h2>
        <span className="text-[11.5px] text-muted-foreground">日志与验收报告保留 90 天，生产永久</span>
      </div>

      {runs.length === 0 ? (
        <p className="px-[18px] py-6 text-xs text-muted-foreground">{row.target.name} 还没有发布记录。</p>
      ) : (
        <>
          <div
            className="grid gap-3 border-b border-[hsl(var(--hairline)/0.6)] bg-[hsl(var(--surface-sunken))] px-[18px] py-2.5 cds-ident text-[11px] uppercase tracking-[0.09em] text-muted-foreground max-xl:hidden"
            style={{ gridTemplateColumns: COLUMNS }}
          >
            <span>时间</span><span>环境</span><span>SHA</span><span>结果</span><span>耗时</span><span>操作人</span><span />
          </div>
          <div>
            {runs.slice(0, 40).map((run) => {
              const failed = isReleaseFailed(run.status);
              return (
                <div
                  key={run.releaseId}
                  className={`grid items-center gap-3 border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-[13px] text-[12.5px] transition-colors duration-150 hover:bg-[hsl(var(--surface-sunken))] max-xl:grid-cols-[92px_minmax(0,1fr)] ${
                    run.releaseId === selected?.releaseId ? 'bg-[hsl(var(--surface-sunken))]' : ''
                  }`}
                  style={{ gridTemplateColumns: COLUMNS }}
                >
                  <span className="cds-ident text-[11.5px] text-muted-foreground">{formatDateTime(run.startedAt)}</span>
                  <span className="truncate font-semibold">{row.target.name}</span>
                  <span className="cds-ident">{run.commitSha.slice(0, 7)}</span>
                  <span className="flex items-center gap-1.5">
                    <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${failed ? 'bg-red-500' : 'bg-emerald-500'}`} />
                    <span className={failed ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
                      {failed ? '失败' : '成功'}
                    </span>
                  </span>
                  <span className="cds-ident text-muted-foreground">{durationOf(run)}</span>
                  <span className="truncate text-muted-foreground">{run.operator || '-'}</span>
                  <span className="flex items-center justify-end gap-1.5 [&_button]:h-[29px] [&_button]:px-2.5">
                    <Button variant="outline" size="sm" onClick={() => setSelectedId(run.releaseId)}>
                      <ScrollText />
                      日志
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      title="验收报告归在 CDS 验收中心（/reports），这条发布没有关联报告"
                      className="cursor-not-allowed opacity-40"
                    >
                      <FileText />
                      验收报告
                    </Button>
                  </span>
                </div>
              );
            })}
          </div>

          {selected ? (
            <div className="px-[18px] py-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[11.5px] text-muted-foreground">
                  日志预览 · {selected.commitSha.slice(0, 7)} · {formatDateTime(selected.startedAt)}
                </span>
                <span className="cds-ident text-[11px] text-muted-foreground">{selected.logs?.length || 0} 行</span>
              </div>
              <RunSteps run={selected} />
              <pre className="m-0 mt-2.5 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[9px] bg-[hsl(var(--surface-base))] px-3 py-2.5 cds-ident text-xs leading-[1.75]">
                {selected.logs && selected.logs.length > 0
                  ? selected.logs.map((log) => `${new Date(log.at).toLocaleTimeString()} ${log.message}`).join('\n')
                  : '这条发布没有留下日志。'}
              </pre>
            </div>
          ) : null}
        </>
      )}
    </section>

    <section className="cds-surface-raised cds-hairline overflow-hidden rounded-[14px] border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-4">
        <h2 className="text-sm font-bold">配置变更历史</h2>
        <span className="text-[11.5px] text-muted-foreground">谁在什么时候把哪个字段改成了什么</span>
      </div>
      {changesLoading ? (
        <div className="flex items-center gap-2 px-[18px] py-6 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在读取变更历史
        </div>
      ) : changesError ? (
        <p className="px-[18px] py-6 text-xs text-muted-foreground">变更历史暂时读不到：{changesError}</p>
      ) : changes.length === 0 ? (
        <p className="px-[18px] py-6 text-xs text-muted-foreground">{row.target.name} 还没有配置变更记录。</p>
      ) : (
        <div>
          {changes.map((change, index) => (
            <div
              key={change.id || `${change.at}-${index}`}
              className="grid gap-x-3 gap-y-1 border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-[13px] text-[12.5px] md:grid-cols-[150px_minmax(0,1fr)]"
            >
              <span className="cds-ident text-[11.5px] text-muted-foreground">{formatDateTime(change.at)}</span>
              <div className="min-w-0">
                <div className="font-semibold">
                  {RELEASE_CHANGE_KIND_LABELS[change.kind] || change.kind}
                  {change.reason ? <span className="font-normal text-muted-foreground"> · {change.reason}</span> : null}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{change.actor || '-'}</div>
                {/* 明细逐条列 before → after：只写「配置更新」四个字等于把这一栏的价值全丢了。 */}
                {(change.changes || []).length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {change.changes.map((field) => (
                      <li key={field.path} className="text-[11.5px] text-muted-foreground">
                        <span className="text-foreground">{field.label}</span>
                        <span className="cds-ident">{`：${field.before || '空'} → ${field.after || '空'}`}</span>
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

/** 这次发布跑到了哪一步。稿子的 §6 只有日志，但步骤是既有页面上真有的证据。 */
function RunSteps({ run }: { run: ReleaseRun }): JSX.Element {
  const progress = resolveReleaseSteps(run);
  return (
    <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
      {progress.steps.map((step, index) => (
        <div
          key={step.id}
          className="flex items-center gap-2 rounded-[9px] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 py-1.5 text-[12px]"
        >
          {step.state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            : step.state === 'failed' ? <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
              : step.state === 'running' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-500" />
                : <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="cds-ident shrink-0 text-[10.5px] text-muted-foreground">{index + 1}/{progress.total}</span>
          <span className="min-w-0 truncate">{step.label}</span>
        </div>
      ))}
    </div>
  );
}
