/**
 * 失败诊断：把结论摆到首屏，原始日志退到折叠区。
 *
 * 旧版这里只给一段 stderr，用户看到一堆 WARN 却看不懂为什么失败——真正的判据
 * （门禁那份 JSON）走 stdout，被错误摘要整段丢掉了。CDS 其实把完整日志一行不落
 * 存下来了，所以这一屏不需要新接口，只需要把结论从日志里捞出来（releaseDiagnosis.ts）。
 *
 * 「未触及生产」这类结论必须由数据推出来，不许拍脑袋：只有当目标当前跑着的
 * commit 与这次失败的 commit 不同时，才敢说生产还停在原来那一版。
 */

import { AlertTriangle, ChevronDown, RotateCcw, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { diagnoseReleaseFailure, type ReleaseGateCheck } from '@/lib/releaseDiagnosis';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { Chip, CodeText, formatClock, formatDateTime, formatDuration } from './shared';
import type { CenterRow, ReleaseRun } from './types';

export interface FailureDiagnosisProps {
  run: ReleaseRun;
  row?: CenterRow;
  retrying: boolean;
  canRollback: boolean;
  onRetry: (run: ReleaseRun) => void;
  onRollback: (run: ReleaseRun) => void;
}

export function FailureDiagnosis({
  run,
  row,
  retrying,
  canRollback,
  onRetry,
  onRollback,
}: FailureDiagnosisProps): JSX.Element {
  const diagnosis = diagnoseReleaseFailure(run.logs || []);
  const progress = resolveReleaseSteps(run);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  // 生产是否被改动：只在「目标当前成功版本 ≠ 本次失败版本」时才敢下结论。
  const productionUntouched = Boolean(row?.currentCommit) && row?.currentCommit !== run.commitSha;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="rounded-lg border border-[hsl(var(--hairline))] border-l-[3px] border-l-red-500 bg-[hsl(var(--surface-raised))] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="bad">发布失败</Chip>
              {row ? <Chip>{row.target.name}</Chip> : null}
              <CodeText className="text-muted-foreground">{run.releaseId}</CodeText>
            </div>
            <h3 className="mt-2.5 text-[17px] font-semibold leading-snug">{diagnosis.headline}</h3>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {formatDateTime(run.startedAt)}
              {run.operator ? ` 由 ${run.operator} 触发` : ''}
              {` · commit ${run.commitSha.slice(0, 7)}`}
              {duration ? ` · 耗时 ${duration}` : ''}
              {productionUntouched && row
                ? ` · 目标仍在 ${row.currentCommit.slice(0, 7)}，未切换到本次版本`
                : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onRetry(run)} disabled={retrying}>
              <RefreshCw />
              修好后重试
            </Button>
            <Button size="sm" variant="outline" onClick={() => onRollback(run)} disabled={!canRollback}>
              <RotateCcw />
              回滚到历史版本
            </Button>
          </div>
        </div>
      </section>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {diagnosis.report ? (
            <section className="cds-surface-raised cds-hairline overflow-hidden rounded-lg">
              <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-4 py-2.5">
                <h4 className="text-sm font-semibold">失败判据 · {diagnosis.report.totalCount} 项检查</h4>
                <Chip tone={diagnosis.report.failCount > 0 ? 'bad' : 'ok'}>
                  {diagnosis.report.failCount > 0 ? `${diagnosis.report.failCount} 项未通过` : '全部通过'}
                </Chip>
              </div>
              <div className="overflow-x-auto" style={{ overscrollBehavior: 'contain' }}>
                <table className="w-full min-w-[520px] border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      <th className="border-b border-[hsl(var(--hairline))] px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">检查项</th>
                      <th className="border-b border-[hsl(var(--hairline))] px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">结果</th>
                      <th className="border-b border-[hsl(var(--hairline))] px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">细节</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderChecks(diagnosis.report.checks).map((check) => (
                      <CheckRow key={check.name} check={check} />
                    ))}
                  </tbody>
                </table>
              </div>
              {diagnosis.humanHint ? (
                <div className="border-t border-[hsl(var(--hairline))] p-4">
                  <h5 className="text-sm font-semibold">人话</h5>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{diagnosis.humanHint}</p>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="cds-surface-raised cds-hairline rounded-lg p-4">
              <h4 className="text-sm font-semibold">失败判据</h4>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                这次发布的日志里没有结构化的门禁报告，只能给出 error 级日志原文。
                如果远端脚本本身会打 JSON 结论，确认它走的是 stdout 且没有被上层截断。
              </p>
            </section>
          )}

          {diagnosis.errorLines.length > 0 ? (
            <section className="cds-surface-raised cds-hairline rounded-lg p-4">
              <h4 className="text-sm font-semibold">错误级日志（{diagnosis.errorLines.length} 条）</h4>
              <pre className="mt-2 overflow-x-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6">
                {diagnosis.errorLines.join('\n')}
              </pre>
            </section>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <section className="cds-surface-raised cds-hairline rounded-lg p-4">
            <h4 className="text-sm font-semibold">步骤</h4>
            <ol className="mt-2 flex flex-col">
              {progress.steps.map((step) => (
                <li key={step.id} className="flex items-center gap-2.5 border-b border-dashed border-[hsl(var(--hairline))] py-2 last:border-b-0">
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full border-2 ${
                      step.state === 'done'
                        ? 'border-emerald-500 bg-emerald-500'
                        : step.state === 'failed'
                          ? 'border-red-500 bg-red-500'
                          : 'border-[hsl(var(--hairline-strong))]'
                    }`}
                  />
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${step.state === 'failed' ? 'text-red-600 dark:text-red-400' : ''}`}>
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
            {progress.degraded ? (
              <p className="mt-2 text-[11px] text-muted-foreground">历史记录，仅按日志还原大致阶段。</p>
            ) : null}
          </section>

          {diagnosis.noiseLines.length > 0 ? (
            <section className="cds-surface-raised cds-hairline rounded-lg p-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  顺带发现的噪音
                </h4>
                <Chip tone="warn">{diagnosis.noiseLines.length} 条</Chip>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6">
                {diagnosis.noiseLines.join('\n')}
              </pre>
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                这些是 WARN，不是失败原因；但它们会把真正的判据挤出错误摘要，
                所以单独列在这里，不与上面的结论混在一起。
              </p>
            </section>
          ) : null}

          <details className="cds-surface-raised cds-hairline overflow-hidden rounded-lg">
            <summary className="flex cursor-pointer items-center gap-1.5 px-4 py-3 text-sm font-semibold">
              <ChevronDown className="h-4 w-4" />
              原始日志（{(run.logs || []).length} 行）
            </summary>
            <pre
              className="max-h-[40vh] overflow-auto border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6"
              style={{ overscrollBehavior: 'contain' }}
            >
              {(run.logs || [])
                .map((log) => `[${formatClock(log.at)}] ${log.level.toUpperCase()} ${log.phase ? `${log.phase}: ` : ''}${log.message}`)
                .join('\n') || '没有日志。'}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}

/** 未通过的排最前——用户来这一屏只为看它。 */
function orderChecks(checks: ReadonlyArray<ReleaseGateCheck>): ReleaseGateCheck[] {
  return [...checks].sort((a, b) => Number(a.ok) - Number(b.ok));
}

function CheckRow({ check }: { check: ReleaseGateCheck }): JSX.Element {
  return (
    <tr className={check.ok ? '' : 'bg-red-500/10'}>
      <td className="border-b border-[hsl(var(--hairline))] px-3 py-2 align-top font-mono text-[12px]">{check.name}</td>
      <td className="border-b border-[hsl(var(--hairline))] px-3 py-2 align-top">
        <Chip tone={check.ok ? 'ok' : 'bad'}>{check.ok ? '通过' : '失败'}</Chip>
      </td>
      <td className="border-b border-[hsl(var(--hairline))] px-3 py-2 align-top text-muted-foreground">
        {check.fields.length > 0 ? (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {check.fields.map((field) => (
              <span key={field.key} className="font-mono text-[11.5px]">
                {field.key}={field.value}
              </span>
            ))}
          </span>
        ) : (
          <span className="break-all font-mono text-[11.5px]">{check.detail || '-'}</span>
        )}
      </td>
    </tr>
  );
}
