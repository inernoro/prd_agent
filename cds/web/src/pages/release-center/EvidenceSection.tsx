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
import { CheckCircle2, ChevronRight, Circle, FileText, Loader2, RotateCcw, ScrollText, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { FailureDiagnosis } from './FailureDiagnosis';
import { formatDateTime } from './shared';
import type { CenterRow, ReleaseRun, ReleaseTargetChange } from './types';
import { RELEASE_CHANGE_KIND_LABELS, isReleaseFailed } from './types';

export interface EvidenceSectionProps {
  /** 当前选中的环境。只用于底部的配置变更历史与日志预览的默认选中。 */
  row: CenterRow;
  /**
   * 同项目的全部环境。稿子的证据表**有「环境」这一列**——它只有横跨环境时才有意义；
   * 只列选中环境的话这一列会是 40 行一模一样的值，纯噪音。
   */
  rows: CenterRow[];
  /** 全部环境的发布记录（`center.runs`），按 run.targetId 归属到各自环境。 */
  runs: ReleaseRun[];
  /** 提交说明。缺席时只显示 short sha，不拿别的字段顶替。 */
  commitMeta: Record<string, { subject?: string }>;
  filter: 'all' | 'failed';
  onFilter: (next: 'all' | 'failed') => void;
  /** 失败行的「看失败原因」——展开就地诊断，不必跳页。 */
  onRollback: (run: ReleaseRun) => void;
  onRetry: (run: ReleaseRun) => void;
  retryingRunId: string;
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

export function EvidenceSection({
  row, rows, runs, commitMeta, filter, onFilter, onRollback, onRetry, retryingRunId,
}: EvidenceSectionProps): JSX.Element {
  const rowOf = (targetId: string): CenterRow | undefined => rows.find((item) => item.target.id === targetId);
  const [selectedId, setSelectedId] = useState('');
  const [diagnosedId, setDiagnosedId] = useState('');
  const visible = filter === 'failed' ? runs.filter((run) => isReleaseFailed(run.status)) : runs;
  const selected = runs.find((run) => run.releaseId === selectedId) || visible[0] || runs[0];
  const failedCount = runs.filter((run) => isReleaseFailed(run.status)).length;
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
        <span className="flex-1" />
        <span className="flex items-center gap-1">
          {([['all', `全部 ${runs.length}`], ['failed', `仅失败 ${failedCount}`]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => onFilter(key)}
              className={`h-[26px] rounded-[7px] px-2.5 text-[11.5px] transition-colors duration-150 ${
                filter === key
                  ? 'bg-primary/[0.12] font-semibold text-primary'
                  : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'
              }`}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="px-[18px] py-6 text-xs text-muted-foreground">
          {runs.length === 0 ? '这个项目还没有发布记录。' : '近期没有失败的发布。'}
        </p>
      ) : (
        <>
          <div
            className="grid gap-3 border-b border-[hsl(var(--hairline)/0.6)] bg-[hsl(var(--surface-sunken))] px-[18px] py-2.5 cds-ident text-[11px] uppercase tracking-[0.09em] text-muted-foreground max-xl:hidden"
            style={{ gridTemplateColumns: COLUMNS }}
          >
            <span>时间</span><span>环境</span><span>SHA</span><span>结果</span><span>耗时</span><span>操作人</span><span />
          </div>
          <div>
            {visible.slice(0, 40).map((run) => {
              const failed = isReleaseFailed(run.status);
              const subject = commitMeta[run.commitSha]?.subject;
              const diagnosed = diagnosedId === run.releaseId;
              // 这条 run 属于哪个环境。归档里会有已停用/已归档目标的历史记录，
              // 查不到就写目标 id，不静默显示成当前选中的那个环境（会张冠李戴）。
              const owner = rowOf(run.targetId);
              const ownerName = owner?.target.name || run.targetId;
              return (
                <div key={run.releaseId} className="border-b border-[hsl(var(--hairline)/0.6)]">
                  <div
                    className={`grid items-center gap-3 px-[18px] py-[13px] text-[12.5px] transition-colors duration-150 hover:bg-[hsl(var(--surface-sunken))] max-xl:grid-cols-[92px_minmax(0,1fr)] ${
                      failed ? 'bg-bad-soft' : ''
                    } ${run.releaseId === selected?.releaseId ? 'bg-[hsl(var(--surface-sunken))]' : ''}`}
                    style={{ gridTemplateColumns: COLUMNS }}
                  >
                    <span className="cds-ident text-[11.5px] text-muted-foreground">{formatDateTime(run.startedAt)}</span>
                    <span className="truncate font-semibold" title={ownerName}>{ownerName}</span>
                    <span className="cds-ident">{run.commitSha.slice(0, 7)}</span>
                    <span className="flex items-center gap-1.5">
                      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${failed ? 'bg-bad' : 'bg-ok'}`} />
                      <span className={failed ? 'text-bad' : 'text-ok'}>
                        {failed ? '失败' : '成功'}
                      </span>
                    </span>
                    <span className="cds-ident text-muted-foreground">{durationOf(run)}</span>
                    {/* 稿子这一格只有操作人。提交说明是既有页面上真有的信息，
                        合进同一格（说明在上、操作人在下），不额外加一列破坏列宽标注。 */}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{subject || `提交 ${run.commitSha.slice(0, 12)}`}</span>
                      <span className="truncate text-[11px] text-muted-foreground">{run.operator || '-'}</span>
                    </span>
                    <span className="flex flex-wrap items-center justify-end gap-1.5 [&_button]:h-[29px] [&_button]:px-2.5">
                      {failed ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDiagnosedId(diagnosed ? '' : run.releaseId)}
                          className="border-bad/40 text-bad"
                        >
                          <ChevronRight className={diagnosed ? 'rotate-90 transition-transform' : 'transition-transform'} />
                          {diagnosed ? '收起诊断' : '看失败原因'}
                        </Button>
                      ) : null}
                      <Button variant="outline" size="sm" onClick={() => setSelectedId(run.releaseId)}>
                        <ScrollText />
                        日志
                      </Button>
                      {owner?.canRollback && !failed ? (
                        <Button variant="outline" size="sm" onClick={() => onRollback(run)}>
                          <RotateCcw />
                          回滚到此版本
                        </Button>
                      ) : null}
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
                  {diagnosed ? (
                    <div className="border-t border-[hsl(var(--hairline)/0.6)] bg-[hsl(var(--surface-sunken))] px-[18px] py-3">
                      <FailureDiagnosis
                        run={run}
                        row={owner}
                        retrying={retryingRunId === run.releaseId}
                        canRollback={Boolean(owner?.canRollback)}
                        onRetry={onRetry}
                        onRollback={onRollback}
                      />
                    </div>
                  ) : null}
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
          {step.state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" />
            : step.state === 'failed' ? <XCircle className="h-3.5 w-3.5 shrink-0 text-bad" />
              : step.state === 'running' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-info" />
                : <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="cds-ident shrink-0 text-[10.5px] text-muted-foreground">{index + 1}/{progress.total}</span>
          <span className="min-w-0 truncate">{step.label}</span>
        </div>
      ))}
    </div>
  );
}
